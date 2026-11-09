// `harness context apply <n>[,<n>…] [--dry-run|--yes]`: applies harness-owned recommendations (spec §5). Every
// name-only goes into one recorded `skillOverrides` change in the installer's transaction, so uninstall takes it out;
// then each remove runs harness remove with the same flags.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { preloadedSkills, recommend, type Rec } from '../budget/recommend.js';
import { contextSet } from '../budget/summary.js';
import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { ApplyError, applyChanges, type Change } from '../install/apply.js';
import { unifiedDiff } from '../install/diff.js';
import { dirtyTouched } from '../install/finish.js';
import { mergeManifestFiles, rawOf, type Manifest } from '../install/manifest.js';
import { MergeError, mergePresetSettings } from '../install/merge.js';
import { items, type ItemsEnv } from './items.js';
import { isDenied, sandboxLine } from './own-command.js';
import { openInstall, readConfig } from './preamble.js';
import { NO_TTY } from './prompt.js';

const USAGE = 'Usage: harness context apply <n>[,<n>…] [--dry-run|--yes]';
const SETTINGS = '.claude/settings.json';
const NUMBERS = /^[1-9]\d*(,[1-9]\d*)*$/;

/** The recommendations, always from the offline estimate, so the report and apply number them the same. */
export function contextRecs(root: string, config: HarnessConfig, dirs: { templates: string; plugin: string }, catalog?: Catalog): Rec[] {
  const s = contextSet(root, config, dirs, undefined, catalog ? { catalog: { catalog, excluded: [], errors: [] } } : {});
  return recommend(s, preloadedSkills(root));
}

export async function contextApply(args: string[], cli: ItemsEnv): Promise<number> {
  const { out } = cli;
  const nums = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  const bad = nums.length !== 1 || !NUMBERS.test(nums[0]) || flags.some((f) => f !== '--dry-run' && f !== '--yes') || new Set(args).size !== args.length;
  if (bad || flags.length > 1) return out(USAGE), 2; // --dry-run and --yes together is a usage error
  const want = [...new Set(nums[0].split(',').map(Number))];
  const yes = flags.includes('--yes');
  const dryRun = flags.includes('--dry-run');

  const opened = openInstall(cli, 'Not a git repository. Run harness inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;
  const config = readConfig(root, out);
  if (typeof config === 'number') return config;
  const all = contextRecs(root, config, { templates: cli.templatesDir, plugin: dirname(cli.templatesDir) }, cli.catalog);
  const recs: Rec[] = [];
  for (const n of want) { // the whole call refuses on the first number it can't apply
    const r = all.find((x) => x.n === n);
    if (!r) return out(`No recommendation ${n}. Run harness context to list them.`), 2;
    if (!r.apply) return out(`Recommendation ${n} changes your own file; the context-optimize skill shows you the diff first.`), 2;
    recs.push(r);
  }
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;

  const names = recs.filter((r) => r.kind === 'name-only').map((r) => r.target);
  if (names.length) {
    const code = await applyNameOnly(root, m, names, { yes, dryRun, args }, cli);
    if (code !== 0) return code;
  }
  for (const r of recs.filter((x) => x.kind === 'remove')) {
    const code = await items('remove', [r.target, ...flags], cli);
    if (code !== 0) return code;
  }
  return 0;
}

/** One `.claude/settings.json` change for every name, with one plan, one diff and one prompt. */
async function applyNameOnly(root: string, m: Manifest, names: string[], f: { yes: boolean; dryRun: boolean; args: string[] }, cli: ItemsEnv): Promise<number> {
  const { out } = cli;
  const abs = join(root, SETTINGS);
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  let merged: ReturnType<typeof mergePresetSettings>;
  try {
    merged = mergePresetSettings(before, names.map((name) => ({ set: ['skillOverrides', name], value: 'name-only' })), [], SETTINGS, 'harness');
  } catch (e) {
    if (e instanceof MergeError) return out(e.message), 1;
    throw e;
  }
  for (const note of merged.notes) out(`Note: ${note}`);
  if (!merged.blocks.length) return out('Nothing to change.'), 0;
  const change: Change = before === null
    ? { kind: 'create', rel: SETTINGS, content: merged.after, blocks: merged.blocks }
    : { kind: 'update', rel: SETTINGS, before, after: merged.after, blocks: merged.blocks };
  if (dirtyTouched(root, [change]).length && !f.dryRun) return out(`Commit or stash these files first, so the change can be undone cleanly: ${SETTINGS}.`), 1;
  out('Plan:');
  out(`  ${change.kind} ${SETTINGS}`);
  out(unifiedDiff(before ?? '', merged.after, SETTINGS).trimEnd());
  if (f.dryRun) return out('Dry run: nothing was written.'), 0;
  if (!f.yes && !(await cli.prompt.confirm('Apply these changes? [y/N]'))) return out('Cancelled. Nothing was written.'), 0;

  const at = new Date();
  const files = mergeManifestFiles(m, [change], `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  try {
    applyChanges(root, [change], m.version, () => at, cli.fs, { manifest: { ...m, files }, manifestBefore: rawOf(m) });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine('context', ['apply', ...f.args]) : e.message), 1;
    throw e;
  }
  stampHarnessFiles(root); // change detection: this write is harness's own
  out(`${change.kind === 'create' ? 'Created' : 'Updated'} \`${SETTINGS}\``);
  out('Run harness git commit on a branch to commit this change.');
  return 0;
}
