import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ApplyError, type FsLike, applyChanges, removeEmptyDirs, type Change } from '../install/apply.js';
import { STRUCTURAL, removeBlocks, removeFromMcp, removeFromSettings } from '../install/merge.js';
import { revertHunks } from '../install/diff.js';
import { prettierFormat, repoPrettier } from '../install/format.js';
import { matchesHash, eolOf, withEol } from '../install/text.js';
import { MANIFEST_REL, backupText } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { openInstall } from './preamble.js';
import type { CliEnv } from './index.js';

export type UninstallEnv = CliEnv & { prompt: Prompt; fs?: FsLike };

const USAGE = 'Usage: harness uninstall [--yes] [--force] [--dry-run]';
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

  const opened = openInstall(cli, 'Not a git repository. Run harness uninstall inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;

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
    const backup = backupText(root, f.backup);
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
      else if (r.after !== cur) changes.push({ kind: 'update', rel: f.rel, before: cur, after: r.after, blocks: [] });
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

  // A kept JS config still imports harness's ESLint files: keep them too, so the person's lint keeps loading.
  if (keptWhole.some((t) => t.includes('.harness/eslint/'))) {
    const keepRels = HARNESS_ESLINT.filter((rel) => changes.some((c) => c.rel === rel && c.kind === 'delete'));
    for (const rel of keepRels) changes.splice(changes.findIndex((c) => c.rel === rel), 1);
    if (keepRels.length) {
      kept.push(...keepRels);
      notes.push(`Kept ${list(keepRels)}: the config above still imports it. Delete it after you remove those lines.`);
    }
  }

  if (dryRun) {
    for (const c of changes) out(`Would ${c.kind === 'delete' ? 'remove' : 'restore'} \`${c.rel}\``);
    for (const n of notes) out(`Note: ${n}`);
    if (kept.length) out(`Would keep ${list(kept)} because you edited them (--force removes them too).`);
    out(`With --yes, \`.harness/\` is deleted too, including its logs${kept.length ? ', except the edited files above' : ''}${existsSync(join(root, '.harness', 'presets')) ? ' (`.harness/presets/` stays: it holds your committed presets)' : ''}.`);
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
    pruneExcept(join(root, '.harness'), [...kept.map((k) => join(root, k)), presets]);
    const edited = kept.some((k) => k.startsWith('.harness/'));
    out(`Removed \`.harness/\`${edited ? ' except the edited files' : ''}${keepPresets ? `${edited ? ' and' : ' except'} \`.harness/presets/\`, your committed presets` : ''}.`);
  } else {
    // Keep the logs but mark harness as uninstalled so init can run again.
    rmSync(join(root, MANIFEST_REL), { force: true });
    out('Kept `.harness/` (manifest removed).');
    stampHarnessFiles(root); // change detection: these writes are harness's own
  }
  if (kept.length) out(`Kept ${list(kept)} because you edited them. Harness no longer tracks them: delete them if you do not need them, or run /harness:init to install again.`);
  out('Restart any Claude Code session open in this repo: its hooks still point at the removed dispatcher and block every call.');
  return 0;
}
