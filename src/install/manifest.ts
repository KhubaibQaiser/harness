import { existsSync, readFileSync } from 'node:fs';
import { retryTransient } from '../core/atomic.js';
import { join, resolve, sep } from 'node:path';
import { stampHarnessFiles } from '../core/harness-files.js';
import { applyChanges, type Change } from './apply.js';
import { lineHunks } from './diff.js';
import { STRUCTURAL, removeBlocks } from './merge.js';
import { hashText, jsonIndentOf, matchesHash } from './text.js';

export interface Manifest {
  version: string;
  createdAt: string;
  /** Package dirs init left out of tdd.paths because their test config could not be edited safely. */
  tddOff?: string[];
  files: {
    rel: string; kind: 'create' | 'update' | 'delete'; hash: string; backup?: string; blocks?: string[];
    /** Set when the repo's Prettier formatted harness's edit: the line hunks that undo it (blocks no longer match). */
    replace?: { from: string; to: string }[];
    formatted?: true;
    /** Prettier was found but failed, so the edit was left unformatted. */
    unformatted?: true;
    /** The catalog item this file belongs to. */
    item?: string;
  }[];
}

/** The entry with `from` rewritten to `to` in every block and every hunk's `from` (the text in the file); `found` when any held it. */
export function renameRecorded(entry: Manifest['files'][number], from: string, to: string): { entry: Manifest['files'][number]; found: boolean } {
  let found = false;
  const swap = (s: string) => (s.includes(from) ? ((found = true), s.split(from).join(to)) : s);
  const blocks = entry.blocks?.map(swap);
  const replace = entry.replace?.map((h) => ({ ...h, from: swap(h.from) }));
  return { entry: { ...entry, ...(blocks ? { blocks } : {}), ...(replace ? { replace } : {}) }, found };
}

/** The files an item wrote (`item` is its id), plus the structural blocks (settings, .mcp.json) whose JSON names it. Text blocks belong to agents-md or the core install. */
export function itemFiles(m: Manifest, id: string): { rel: string; blocks: string[] }[] {
  const owns = (b: string) => { try { return JSON.parse(b)?.item === id; } catch { return false; } };
  return m.files.flatMap((f) => {
    const blocks = STRUCTURAL.has(f.rel) ? (f.blocks ?? []).filter(owns) : [];
    return f.item === id || blocks.length ? [{ rel: f.rel, blocks }] : [];
  });
}

export interface StatePaths { dir: string; manifest: string; backup: string; lock: string }
export const statePaths = (dir = '.harness'): StatePaths => ({ dir, manifest: `${dir}/manifest.json`, backup: `${dir}/backup`, lock: `${dir}/apply.lock` });
export const REPO_STATE = statePaths();
export const MANIFEST_REL = REPO_STATE.manifest;

export class ManifestError extends Error {
  constructor(options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? '`.harness/manifest.json` is unreadable. Restore it from git or delete `.harness/` and run /harness:init again.', options);
    this.name = 'ManifestError';
  }
}

/** The text `readManifest` read the manifest from, for a command to hand to applyChanges as `manifestBefore` (copies of the object don't carry it). */
export const rawOf = (m: Manifest): string | undefined => (m as { [RAW]?: string })[RAW];
const RAW = Symbol('raw');

/** True for a manifest backup path: inside `.harness/backup/`, no `..` anywhere. */
export const isBackupPath = (rel: string, sp: StatePaths = REPO_STATE): boolean => rel.startsWith(`${sp.backup}/`) && !rel.split(/[\\/]/).includes('..');

/** The backup's text, or null when it is missing or its recorded path leaves `.harness/backup/` (a committed manifest is not trusted). */
export function backupText(root: string, rel: string | undefined, sp: StatePaths = REPO_STATE): string | null {
  if (!rel || !isBackupPath(rel, sp)) return null;
  const p = resolve(root, rel);
  if (!p.startsWith(resolve(root, sp.backup) + sep) || !existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

export function readManifest(root: string, read: (p: string, e: 'utf8') => string = readFileSync, sp: StatePaths = REPO_STATE): Manifest | null {
  const p = join(root, sp.manifest);
  if (!existsSync(p)) return null;
  let text: string;
  try {
    text = retryTransient(() => read(p, 'utf8'));
  } catch (cause) {
    // A read error (a Windows lock that outlasted the retries) is not a corrupt file: never suggest deleting .harness/.
    const why = (cause as Error).message.split('\n')[0];
    throw new ManifestError({ cause, message: `\`${sp.manifest}\` could not be read (${why}). Try again; if it keeps failing, check what holds the file open.` });
  }
  try {
    const m = JSON.parse(text);
    if (m === null || typeof m !== 'object' || Array.isArray(m) || !Array.isArray(m.files)) throw new Error('bad shape');
    Object.defineProperty(m, RAW, { value: text }); // not enumerable: never written back
    return m as Manifest;
  } catch (cause) {
    throw new ManifestError({ cause });
  }
}

const CONFIG = '.harness/config.yaml';

/**
 * The manifest's file list after an update applies `changes` (rewriting a renamed results path in the records first).
 * Old blocks stay unless the change dropped them, an edited merged file keeps its hash and drops its backup, an entry
 * whose change is `delete` goes, and `item` follows the change.
 */
export function mergeManifestFiles(old: Manifest, changes: Change[], backupDir?: string): Manifest['files'] {
  const base = old.files.slice();
  const entry = (rel: string) => base.find((f) => f.rel === rel);
  const merged = (rel: string) => entry(rel)?.kind === 'update' || !!entry(rel)?.blocks?.length || !!entry(rel)?.replace?.length;
  // A moved results path: rewrite it in what the manifest recorded, else record the swap as hunks uninstall reverts.
  for (const c of changes) {
    if (c.kind !== 'update' || !c.rename) continue;
    const o = entry(c.rel);
    const r = o && renameRecorded(o, c.rename.from, c.rename.to);
    if (r && r.found) base[base.indexOf(o)] = r.entry;
    else c.replace = lineHunks(c.before, c.after);
  }
  const files: Manifest['files'] = [];
  for (const o of base) {
    const c = changes.find((x) => x.rel === o.rel);
    if (c?.kind === 'delete' || (c?.kind === 'update' && c.restored)) continue;
    if (!c) { files.push(o); continue; }
    // A text block the new content no longer holds (a migrated Jest script) can't be removed later; drop it.
    // Structural blocks (settings, .mcp.json) are JSON, not text: kept unless the merge dropped them.
    const still = (b: string) => c.kind !== 'update' || (STRUCTURAL.has(o.rel) ? !c.dropped?.includes(b) : removeBlocks(c.after, [b]) !== c.after); // EOL-tolerant, like uninstall's removal
    const blocks = [...new Set([...(o.blocks ?? []).filter(still), ...(c.blocks ?? [])])];
    // The change cut the file's last harness block (and it has no formatted hunks): what is left is the person's file.
    if (c.kind === 'update' && o.blocks?.length && !blocks.length && !o.replace?.length && !STRUCTURAL.has(o.rel) && o.rel !== CONFIG) continue;
    // A merged file the user edited since harness last wrote it: keep the old hash and drop the pre-init backup, so
    // uninstall still sees the edit and removes only harness's blocks (a whole-file restore or delete would lose it).
    const edited = c.kind === 'update' && merged(o.rel) && !matchesHash(c.before, o.hash);
    const keep = edited || (!(c.kind === 'update' && c.rewrite) && o.rel === CONFIG && !matchesHash(c.kind === 'update' ? c.before : '', o.hash)); // an edited config keeps its hash
    const hash = keep ? o.hash : hashText(c.kind === 'create' ? c.content : c.after);
    // Formatted hunks: keep the old ones the new text still holds, then this update's (uninstall undoes them newest first).
    // ponytail: an old hunk this update reformatted is dropped, so uninstall then leaves that part with a note.
    const replace = [...(o.replace ?? []).filter((h) => c.kind !== 'update' || c.after.includes(h.from)), ...(c.kind === 'update' ? (c.replace ?? []) : [])];
    const fmt = { ...(replace.length ? { replace } : {}), ...(o.formatted || (c.kind === 'update' && c.formatted) ? { formatted: true as const } : {}), ...(c.kind === 'update' && c.unformatted ? { unformatted: true as const } : {}) };
    const item = c.item ?? o.item;
    // Otherwise keep init's kind (a created file stays deletable) and the pre-init backup uninstall restores.
    files.push({ rel: o.rel, kind: o.kind, hash, ...(blocks.length ? { blocks } : {}), ...fmt, ...(item ? { item } : {}), ...(o.backup && !edited ? { backup: o.backup } : {}) });
  }
  for (const c of changes) {
    if (c.kind === 'delete' || old.files.some((f) => f.rel === c.rel)) continue;
    files.push({ rel: c.rel, kind: c.kind, hash: hashText(c.kind === 'create' ? c.content : c.after), ...(c.blocks?.length ? { blocks: c.blocks } : {}), ...(c.kind === 'update' && c.replace?.length ? { replace: c.replace } : {}), ...(c.kind === 'update' && c.formatted ? { formatted: true as const } : {}), ...(c.kind === 'update' && c.unformatted ? { unformatted: true as const } : {}), ...(c.item ? { item: c.item } : {}), ...(c.kind === 'update' && backupDir ? { backup: `${backupDir}/${c.rel}` } : {}) });
  }
  return files;
}

/**
 * True when settings.json differs from its recorded hash only by the `enabledPlugins` entries of `pluginIds` (which
 * `claude plugin install` rewrites). Compared by hash: the entries are set back to what harness wrote (true) and the file
 * is re-serialised with its own indent. Any other edit makes it differ, and so does a missing or unparsable file.
 */
export function settingsOnlyPluginEdits(root: string, pluginIds: string[]): boolean {
  const entry = readManifest(root)?.files.find((f) => f.rel === '.claude/settings.json');
  const p = join(root, '.claude/settings.json');
  if (!entry || !existsSync(p)) return true;
  const text = readFileSync(p, 'utf8');
  if (matchesHash(text, entry.hash)) return true;
  try {
    const j = JSON.parse(text);
    if (j?.enabledPlugins && typeof j.enabledPlugins === 'object') for (const id of pluginIds) if (id in j.enabledPlugins) j.enabledPlugins[id] = true;
    const body = JSON.stringify(j, null, jsonIndentOf(text));
    return [body, body + '\n'].some((t) => matchesHash(t, entry.hash));
  } catch {
    return false;
  }
}

/**
 * `claude plugin install --scope project` rewrites .claude/settings.json behind harness's back. For each of `rels`
 * whose bytes no longer match the recorded hash, the manifest takes the new hash (a manifest-only transaction), then
 * the harness files are stamped so the hooks don't report the install as an outside change.
 */
export function rehashManifest(root: string, rels: string[]): void {
  const m = readManifest(root);
  if (m) {
    let changed = false;
    const files = m.files.map((f) => {
      const p = join(root, f.rel);
      if (!rels.includes(f.rel) || !existsSync(p)) return f;
      const text = readFileSync(p, 'utf8');
      if (matchesHash(text, f.hash)) return f;
      changed = true;
      return { ...f, hash: hashText(text) };
    });
    if (changed) applyChanges(root, [], m.version, undefined, undefined, { manifest: { ...m, files }, manifestBefore: rawOf(m) });
  }
  stampHarnessFiles(root);
}
