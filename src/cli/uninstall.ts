import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ApplyError, LOCK_RECOVERY, type FsLike, applyChanges, removeEmptyDirs, type Change } from '../install/apply.js';
import { STRUCTURAL, removeBlocks, removeFromMcp, removeFromSettings } from '../install/merge.js';
import { revertHunks } from '../install/diff.js';
import { prettierFormat, repoPrettier } from '../install/format.js';
import { matchesHash, eolOf, withEol } from '../install/text.js';
import { MANIFEST_REL, ManifestError, REPO_STATE, backupText, readManifest, type Manifest, type StatePaths } from '../install/manifest.js';
import { ESLINT } from '../install/plan.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { openInstall } from './preamble.js';
import { GLOBAL_LOCK_RECOVERY, GLOBAL_STATE } from './preset.js';
import type { CliEnv } from './index.js';

export type UninstallEnv = CliEnv & { prompt: Prompt; fs?: FsLike; /** Default `os.homedir()`; tests pass a temp dir. */ home?: string };

const USAGE = 'Usage: harness uninstall [--global] [--yes] [--force] [--dry-run]';
const SETTINGS = '.claude/settings.json';

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const JS = /\.[cm]?[jt]s$/;
const HARNESS_ESLINT = ['.harness/eslint/harness.config.mjs', '.harness/eslint/harness.config.d.mts'];

const sameJson = (a: string, b: string): boolean => { try { return isDeepStrictEqual(JSON.parse(a), JSON.parse(b)); } catch { return false; } };

/** A manifest path harness may touch under home: `.claude/…`, forward slashes, no control character, no empty, `.` or `..` segment. */
const underClaude = (p: unknown): p is string => typeof p === 'string' && p.startsWith('.claude/') && !p.includes('\\') && !/[\u0000-\u001f\u007f]/.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/** The first entry of a global manifest that is not a safe path under ~/.claude (the whole value when `dirs` is not an array), or undefined. */
function badGlobalEntry(m: Manifest, sp: StatePaths): { bad: unknown } | undefined {
  if (m.dirs !== undefined && !Array.isArray(m.dirs)) return { bad: m.dirs };
  for (const d of m.dirs ?? []) if (d !== '.claude' && !underClaude(d)) return { bad: d }; // the install may have created ~/.claude itself
  for (const f of m.files) {
    // Under ~/.claude/harness a file is only ever a preset copy: never the manifest, the lock or a backup.
    if (!underClaude(f?.rel) || (f.rel.startsWith(`${sp.dir}/`) && !f.rel.startsWith(`${sp.dir}/presets/`))) return { bad: f?.rel };
    if (f.backup !== undefined && !(underClaude(f.backup) && f.backup.startsWith(`${sp.backup}/`) && f.backup.split('/').length > sp.backup.split('/').length + 1)) return { bad: f.backup };
  }
  return undefined;
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

/** What uninstall writes for each file `m` records: deletes and restores, the edited files it keeps, and notes. Backups are read through `sp`. */
export function removalChanges(root: string, m: Manifest, force: boolean, sp: StatePaths = REPO_STATE): { changes: Change[]; kept: string[]; notes: string[]; /** harness ESLint files kept because a config still imports them */ imported: string[] } {
  const changes: Change[] = [];
  const kept: string[] = [];
  const notes: string[] = [];
  const keptWhole: string[] = []; // the texts of JS files kept whole
  for (const f of m.files) {
    const cur = read(join(root, f.rel));
    if (cur === null) {
      notes.push(`\`${f.rel}\` is already gone.`);
      continue;
    }
    const backup = backupText(root, f.backup, sp);
    if (STRUCTURAL.has(f.rel)) {
      if (matchesHash(cur, f.hash) && f.kind === 'create') {
        changes.push({ kind: 'delete', rel: f.rel, before: cur });
        continue;
      }
      if (matchesHash(cur, f.hash) && backup !== null) {
        changes.push({ kind: 'update', rel: f.rel, before: cur, after: backup, blocks: [] });
        continue;
      }
      const r = (f.rel === SETTINGS ? removeFromSettings : removeFromMcp)(cur, f, backup, notes);
      if (!r) notes.push(`\`${f.rel}\` is not valid JSON; left as is. Remove the harness ${f.rel === SETTINGS ? 'hooks and deny rules' : 'entries'} by hand.`);
      else if (r.empty && f.kind === 'create') changes.push({ kind: 'delete', rel: f.rel, before: cur });
      else if (r.after !== cur && !sameJson(r.after, cur)) changes.push({ kind: 'update', rel: f.rel, before: cur, after: r.after, blocks: [] }); // nothing removed: leave its bytes
      continue;
    }
    const merged = !!f.blocks?.length || !!f.replace?.length;
    if (f.kind === 'create' && (matchesHash(cur, f.hash) || (force && !merged))) changes.push({ kind: 'delete', rel: f.rel, before: cur });
    else if (f.kind === 'create' && !merged) kept.push(f.rel);
    else if (f.kind === 'update' && matchesHash(cur, f.hash) && backup !== null) changes.push({ kind: 'update', rel: f.rel, before: cur, after: backup, blocks: [] });
    else if (f.kind === 'create' || f.kind === 'update') {
      // A merged file the user edited: remove only harness's blocks and keep the rest.
      // In a JS/TS file the blocks depend on each other (an import and its use), so one missing block keeps them all.
      const whole = JS.test(f.rel);
      const keepAll = (lines: string[]) => {
        notes.push(`\`${f.rel}\`: a change harness made was not found or was edited, so none of harness's lines were removed. Remove these by hand:\n${lines.map((l) => `  ${l}`).join('\n')}`);
        keptWhole.push(cur);
      };
      let after = cur;
      for (const b of f.blocks ?? []) {
        const next = removeBlocks(after, [b]);
        if (next !== after) after = next;
        else if (!whole) notes.push(`\`${f.rel}\`: a block harness added was not found; left as is.`);
        else {
          keepAll((f.blocks ?? []).flatMap((x) => x.split(/\r?\n/)).map((l) => l.trim()).filter((l) => l && l !== ','));
          after = cur;
          break;
        }
      }
      // A config the repo's Prettier formatted at install: undo the formatted hunks together, then format again, as install did.
      if (f.replace?.length && !keptWhole.includes(cur)) {
        const next = revertHunks(after, f.replace);
        if (next !== null) after = next;
        else if (whole) {
          keepAll(f.replace.flatMap((h) => { const to = new Set(h.to.split('\n')); return h.from.split('\n').filter((l) => l.trim() && !to.has(l)).map((l) => l.trim()); }));
          after = cur;
        } else notes.push(`\`${f.rel}\`: a change harness made was not found; left as is.`);
      }
      const bin = f.formatted && after !== cur ? repoPrettier(root, f.rel) : null;
      if (bin) {
        try {
          after = withEol(prettierFormat(bin, root, f.rel, after), eolOf(cur)); // keep the checkout's own EOL
        } catch (e) {
          notes.push(`\`${f.rel}\`: Prettier could not format it after the harness part was removed (${String((e as Error).message).split('\n')[0]}).`);
        }
      }
      // A created file that held only harness's blocks and whitespace is removed whole.
      if (f.kind === 'create' && !after.trim()) changes.push({ kind: 'delete', rel: f.rel, before: cur });
      else if (after !== cur) changes.push({ kind: 'update', rel: f.rel, before: cur, after, blocks: [] });
    }
  }

  // An ESLint config that still imports harness's ESLint files (from its text after this uninstall, not the manifest,
  // so a later install's uninstall agrees): keep them too, so the person's lint keeps loading.
  const textAfter = (rel: string) => { const c = changes.find((x) => x.rel === rel); return c ? (c.kind === 'update' ? c.after : null) : read(join(root, rel)); };
  const imported = ESLINT.some((rel) => textAfter(rel)?.includes('.harness/eslint/'))
    ? HARNESS_ESLINT.filter((rel) => existsSync(join(root, rel)))
    : [];
  for (const rel of imported) { const i = changes.findIndex((c) => c.rel === rel); if (i >= 0) changes.splice(i, 1); }
  return { changes, kept, notes, imported };
}

export async function uninstall(args: string[], cli: UninstallEnv): Promise<number> {
  const { out, prompt } = cli;
  if (args.some((a) => !['--yes', '--force', '--dry-run', '--global'].includes(a))) return out(USAGE), 2;
  const yes = args.includes('--yes');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;
  if (args.includes('--global')) return uninstallGlobal(cli, { yes, force, dryRun });

  const opened = openInstall(cli, 'Not a git repository. Run harness uninstall inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;

  const { changes, kept, notes, imported } = removalChanges(root, m, force);
  const importedWhy = `${list(imported)} kept because your edited eslint config still imports them. Delete them after you remove its harness lines.`;

  if (dryRun) {
    for (const c of changes) out(`Would ${c.kind === 'delete' ? 'remove' : 'restore'} \`${c.rel}\``);
    for (const n of notes) out(`Note: ${n}`);
    if (kept.length) out(`Would keep ${list(kept)} because you edited them (--force removes them too).`);
    if (imported.length) out(`Would keep ${importedWhy}`);
    out(`With --yes, \`.harness/\` is deleted too, including its logs${kept.length || imported.length ? ', except the kept files above' : ''}${existsSync(join(root, '.harness', 'presets')) ? ' (`.harness/presets/` stays: it holds your committed presets)' : ''}.`);
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
  removeEmptyDirs(root, changes);
  for (const c of changes) out(`${c.kind === 'delete' ? 'Removed' : 'Restored'} \`${c.rel}\``);
  for (const n of notes) out(`Note: ${n}`);

  // Edited files are kept like any other user edit, but harness is fully uninstalled either way: the manifest always
  // goes, so init, status and doctor see a repo without harness.
  if (deleteHarness) {
    // .harness/presets/ is the person's own committed source, not something harness wrote: it stays.
    const presets = join(root, '.harness', 'presets');
    const keepPresets = existsSync(presets);
    pruneExcept(join(root, '.harness'), [...kept, ...imported].map((k) => join(root, k)).concat(presets));
    const edited = [...kept, ...imported].some((k) => k.startsWith('.harness/'));
    out(`Removed \`.harness/\`${edited ? ' except the kept files' : ''}${keepPresets ? `${edited ? ' and' : ' except'} \`.harness/presets/\`, your committed presets` : ''}.`);
  } else {
    // Keep the logs but mark harness as uninstalled so init can run again.
    rmSync(join(root, MANIFEST_REL), { force: true });
    out('Kept `.harness/` (manifest removed).');
    stampHarnessFiles(root); // change detection: these writes are harness's own
  }
  if (imported.length) out(`Kept ${importedWhy}`);
  if (kept.length) out(`Kept ${list(kept)} because you edited them. Harness no longer tracks them: delete them if you do not need them, or run /harness:init to install again.`);
  out('Restart any Claude Code session open in this repo: its hooks still point at the removed dispatcher and block every call.');
  return 0;
}

/** `uninstall --global`: removes what `~/.claude/harness/manifest.json` records, restores the backups, then the folders the install created. No git repo needed. */
async function uninstallGlobal(cli: UninstallEnv, o: { yes: boolean; force: boolean; dryRun: boolean }): Promise<number> {
  const { out } = cli;
  const home = cli.home ?? homedir();
  const sp = GLOBAL_STATE;
  if (existsSync(join(home, sp.lock))) return out(GLOBAL_LOCK_RECOVERY), 1;
  let m: Manifest | null;
  try {
    m = readManifest(home, undefined, sp);
  } catch (e) {
    if (e instanceof ManifestError) return out(`\`~/${sp.manifest}\` is unreadable, so nothing was removed. Fix or delete it, then remove the preset's files by hand.`), 1;
    throw e;
  }
  if (!m) return out(`No global preset is installed (no ~/${sp.manifest}).`), 1;
  const tampered = badGlobalEntry(m, sp);
  if (tampered) return out(`\`~/${sp.manifest}\` lists ${JSON.stringify(tampered.bad) ?? String(tampered.bad)}, which is not a path under ~/.claude, so nothing was removed.`), 1;
  const r = removalChanges(home, m, o.force, sp);
  const { changes } = r;
  const toHome = (t: string) => t.split('`.claude/').join('`~/.claude/'); // every rel is under .claude/ (checked above)
  const notes = r.notes.map(toHome), kept = r.kept.map((k) => `~/${k}`);
  if (o.dryRun) {
    for (const c of changes) out(`Would ${c.kind === 'delete' ? 'remove' : 'restore'} \`~/${c.rel}\``);
    for (const n of notes) out(`Note: ${n}`);
    if (kept.length) out(`Would keep ${list(kept)} because you edited them (--force removes them too).`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!o.yes && !(await cli.prompt.confirm('Remove the global preset from ~/.claude? (y/N)'))) return out('Cancelled. Nothing was removed.'), 0;
  let written: Manifest | undefined;
  try {
    if (changes.length) written = applyChanges(home, changes, m.version, undefined, cli.fs, { writeManifest: false, state: sp });
  } catch (e) {
    if (!(e instanceof ApplyError)) throw e;
    return out(e.message === LOCK_RECOVERY ? GLOBAL_LOCK_RECOVERY : e.message), 1;
  }
  for (const c of changes) out(`${c.kind === 'delete' ? 'Removed' : 'Restored'} \`~/${c.rel}\``);
  for (const n of notes) out(`Note: ${n}`);
  const { writeFileSync: write, rmSync: rm, rmdirSync: rmdir } = cli.fs ?? { writeFileSync, rmSync, rmdirSync };
  // Locked again until the manifest is gone: a crash in between makes the next run stop instead of half-redoing it.
  write(join(home, sp.lock), `${sp.manifest}\n`);
  // Each run's backups sit in their own timestamped folder: the install's (validated above), and the one this apply just made.
  const depth = sp.backup.split('/').length + 1;
  for (const b of new Set([...m.files, ...(written?.files ?? [])].flatMap((f) => (f.backup ? [f.backup.split('/').slice(0, depth).join('/')] : []))))
    rm(join(home, b), { recursive: true, force: true });
  rm(join(home, sp.manifest), { force: true });
  rm(join(home, sp.lock), { force: true });
  // Deepest first; rmdir refuses a folder that still holds something (an edited file, the person's own).
  for (const d of [...(m.dirs ?? [])].sort((a, b) => b.length - a.length)) {
    try { rmdir(join(home, d)); } catch {}
  }
  out(`Removed ~/${sp.manifest} and the backups.`);
  if (kept.length) out(`Kept ${list(kept)} because you edited them. Harness no longer tracks them: delete them if you do not need them.`);
  return 0;
}
