import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ApplyError, type FsLike, ManifestError, applyChanges, readManifest, type Change, type Manifest } from '../install/apply.js';
import { removeBlocks } from '../install/merge.js';
import { revertHunks } from '../install/diff.js';
import { prettierFormat, repoPrettier } from '../install/format.js';
import { matchesHash, eolOf, jsonIndentOf, withEol } from '../install/text.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type UninstallEnv = CliEnv & { prompt: Prompt; fs?: FsLike };

const USAGE = 'Usage: harness uninstall [--yes] [--force] [--dry-run]';
const SETTINGS = '.claude/settings.json';
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** Drops the recorded hook groups and deny rules. Returns null when the file is not a JSON object. */
function removeFromSettings(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null {
  let s: any;
  try {
    s = JSON.parse(current);
  } catch {
    return null;
  }
  if (!isObj(s)) return null;
  // What the file had before init: {} if init created it, the backup if there is one, else unknown (null).
  let orig: any = f.kind === 'create' ? {} : null;
  if (orig === null && original !== null) {
    try {
      orig = JSON.parse(original);
    } catch {}
  }
  const had = (...path: string[]) => (orig === null ? true : path.reduce((v: any, k) => v?.[k], orig) !== undefined);
  for (const b of f.blocks ?? []) {
    let blk: any;
    try {
      blk = JSON.parse(b);
    } catch {
      continue;
    }
    if (typeof blk?.event === 'string') {
      const list = s.hooks?.[blk.event];
      const kept = Array.isArray(list) ? list.filter((g: unknown) => !isDeepStrictEqual(g, blk.group)) : [];
      if (!Array.isArray(list) || kept.length === list.length) notes.push(`\`${SETTINGS}\`: the harness ${blk.event} hook was not found; left as is.`);
      else s.hooks[blk.event] = kept;
    } else if (typeof blk?.deny === 'string') {
      const list = s.permissions?.deny;
      if (!Array.isArray(list) || !list.includes(blk.deny)) notes.push(`\`${SETTINGS}\`: deny rule \`${blk.deny}\` was not found; left as is.`);
      else s.permissions.deny = list.filter((d: unknown) => d !== blk.deny);
    }
  }
  // Drop keys that harness's removal left empty and that did not exist before init.
  if (isObj(s.hooks)) {
    for (const [ev, v] of Object.entries(s.hooks)) if (Array.isArray(v) && !v.length && !had('hooks', ev)) delete s.hooks[ev];
    if (!Object.keys(s.hooks).length && !had('hooks')) delete s.hooks;
  }
  if (isObj(s.permissions)) {
    if (Array.isArray(s.permissions.deny) && !s.permissions.deny.length && !had('permissions', 'deny')) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length && !had('permissions')) delete s.permissions;
  }
  const eol = eolOf(current);
  return { after: withEol(JSON.stringify(s, null, jsonIndentOf(current)), eol) + (/\n$/.test(current) ? eol : ''), empty: !Object.keys(s).length };
}

const list = (rels: string[]) => rels.map((k) => `\`${k}\``).join(', ');

/** Deletes everything under `dir` except the `keep` files (absolute paths) and the folders that hold them. */
function pruneExcept(dir: string, keep: string[]): void {
  for (const e of (() => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    const p = join(dir, e.name);
    if (keep.includes(p)) continue;
    if (e.isDirectory() && keep.some((k) => k.startsWith(p + sep))) pruneExcept(p, keep);
    else rmSync(p, { recursive: true, force: true });
  }
  try { rmdirSync(dir); } catch {} // only when nothing was kept in it
}

export async function uninstall(args: string[], cli: UninstallEnv): Promise<number> {
  const { out, prompt } = cli;
  if (args.some((a) => a !== '--yes' && a !== '--force' && a !== '--dry-run')) return out(USAGE), 2;
  const yes = args.includes('--yes');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli.root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return out('Not a git repository. Run harness uninstall inside a git repo.'), 1;
  }
  let m: Manifest | null;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run harness init to install it.'), 1;

  const changes: Change[] = [];
  const kept: string[] = [];
  const notes: string[] = [];
  for (const f of m.files) {
    const cur = read(join(root, f.rel));
    if (cur === null) {
      notes.push(`\`${f.rel}\` is already gone.`);
      continue;
    }
    const backup = f.backup ? read(join(root, f.backup)) : null;
    if (f.rel === SETTINGS) {
      if (matchesHash(cur, f.hash) && f.kind === 'create') {
        changes.push({ kind: 'delete', rel: f.rel, before: cur });
        continue;
      }
      if (matchesHash(cur, f.hash) && backup !== null) {
        changes.push({ kind: 'update', rel: f.rel, before: cur, after: backup, blocks: [] });
        continue;
      }
      const r = removeFromSettings(cur, f, backup, notes);
      if (!r) notes.push(`\`${SETTINGS}\` is not valid JSON; left as is. Remove the harness hooks and deny rules by hand.`);
      else if (r.empty && f.kind === 'create') changes.push({ kind: 'delete', rel: f.rel, before: cur });
      else if (r.after !== cur) changes.push({ kind: 'update', rel: f.rel, before: cur, after: r.after, blocks: [] });
      continue;
    }
    const merged = !!f.blocks?.length || !!f.replace?.length;
    if (f.kind === 'create' && (matchesHash(cur, f.hash) || (force && !merged))) changes.push({ kind: 'delete', rel: f.rel, before: cur });
    else if (f.kind === 'create' && !merged) kept.push(f.rel);
    else if (f.kind === 'update' && matchesHash(cur, f.hash) && backup !== null) changes.push({ kind: 'update', rel: f.rel, before: cur, after: backup, blocks: [] });
    else if (f.kind === 'create' || f.kind === 'update') {
      // A merged file the user edited: remove only harness's blocks and keep the rest.
      let after = cur;
      for (const b of f.blocks ?? []) {
        const next = removeBlocks(after, [b]);
        if (next === after) notes.push(`\`${f.rel}\`: a block harness added was not found; left as is.`);
        after = next;
      }
      // A config the repo's Prettier formatted at install: undo the formatted hunks, then format again, as install did.
      for (const h of [...(f.replace ?? [])].reverse()) {
        const next = revertHunks(after, [h]);
        if (next === null) notes.push(`\`${f.rel}\`: a change harness made was not found; left as is.`);
        else after = next;
      }
      const bin = f.formatted && after !== cur ? repoPrettier(root, f.rel) : null;
      if (bin) {
        try {
          after = prettierFormat(bin, root, f.rel, after);
        } catch (e) {
          notes.push(`\`${f.rel}\`: Prettier could not format it after the harness part was removed (${String((e as Error).message).split('\n')[0]}).`);
        }
      }
      // A created file that held only harness's blocks and whitespace is removed whole.
      if (f.kind === 'create' && !after.trim()) changes.push({ kind: 'delete', rel: f.rel, before: cur });
      else if (after !== cur) changes.push({ kind: 'update', rel: f.rel, before: cur, after, blocks: [] });
    }
  }

  if (dryRun) {
    for (const c of changes) out(`Would ${c.kind === 'delete' ? 'remove' : 'restore'} \`${c.rel}\``);
    for (const n of notes) out(`Note: ${n}`);
    if (kept.length) out(`Would keep ${list(kept)} because you edited them (--force removes them too).`);
    out(`With --yes, \`.harness/\` is deleted too, including its logs${kept.length ? ', except the edited files above' : ''}.`);
    return out('Dry run: nothing was written.'), 0;
  }

  // Asked first: with .harness/ kept, its .gitignore lines stay too, so logs, state and backups stay untracked.
  const deleteHarness = yes || (await prompt.confirm('Delete .harness/ including logs? (y/N)'));
  if (!deleteHarness && changes.some((c) => c.rel === '.gitignore')) {
    changes.splice(changes.findIndex((c) => c.rel === '.gitignore'), 1);
    notes.push('Kept the `.harness/` lines in `.gitignore`, so its logs, state and backups stay out of git.');
  }
  if (changes.length) {
    try {
      applyChanges(root, changes, m.version, undefined, cli.fs, { writeManifest: false });
    } catch (e) {
      if (e instanceof ApplyError) return out(e.message), 1;
      throw e;
    }
  }
  // Remove directories the deletes left empty, never above the repo root and never a non-empty one.
  for (const c of changes) {
    if (c.kind !== 'delete') continue;
    try {
      for (let d = dirname(join(root, c.rel)); d !== root; d = dirname(d)) rmdirSync(d);
    } catch {} // rmdir refuses a non-empty directory
  }
  for (const c of changes) out(`${c.kind === 'delete' ? 'Removed' : 'Restored'} \`${c.rel}\``);
  for (const n of notes) out(`Note: ${n}`);

  // Edited files are kept like any other user edit, but harness is fully uninstalled either way: the manifest always
  // goes, so init, status and doctor see a repo without harness.
  if (deleteHarness) {
    pruneExcept(join(root, '.harness'), kept.map((k) => join(root, k)));
    out(kept.some((k) => k.startsWith('.harness/')) ? 'Removed `.harness/` except the edited files.' : 'Removed `.harness/`.');
  } else {
    // Keep the logs but mark harness as uninstalled so init can run again.
    rmSync(join(root, MANIFEST_REL), { force: true });
    out('Kept `.harness/` (manifest removed).');
  }
  if (kept.length) out(`Kept ${list(kept)} because you edited them. Harness no longer tracks them: delete them if you do not need them, or run harness init to install again.`);
  return 0;
}
