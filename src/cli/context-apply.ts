// `harness context apply <n> [--dry-run] [--yes]`: applies a harness-owned recommendation (spec §5). name-only writes a
// recorded `skillOverrides` set block in the installer's transaction, so uninstall takes it out; remove runs harness remove.
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
import { mergeManifestFiles, rawOf } from '../install/manifest.js';
import { MergeError, mergePresetSettings } from '../install/merge.js';
import { items, type ItemsEnv } from './items.js';
import { openInstall, readConfig } from './preamble.js';
import { NO_TTY } from './prompt.js';

const USAGE = 'Usage: harness context apply <n> [--dry-run] [--yes]';
const SETTINGS = '.claude/settings.json';

/** The recommendations, always from the offline estimate, so the report and apply number them the same. */
export function contextRecs(root: string, config: HarnessConfig, dirs: { templates: string; plugin: string }, catalog?: Catalog): Rec[] {
  const s = contextSet(root, config, dirs, undefined, catalog ? { catalog: { catalog, excluded: [], errors: [] } } : {});
  return recommend(s, preloadedSkills(root));
}

export async function contextApply(args: string[], cli: ItemsEnv): Promise<number> {
  const { out } = cli;
  const nums = args.filter((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));
  if (nums.length !== 1 || !/^[1-9]\d*$/.test(nums[0]) || flags.some((f) => f !== '--dry-run' && f !== '--yes') || new Set(args).size !== args.length) return out(USAGE), 2;
  const n = Number(nums[0]);
  const yes = flags.includes('--yes');
  const dryRun = flags.includes('--dry-run');

  const opened = openInstall(cli, 'Not a git repository. Run harness inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;
  const config = readConfig(root, out);
  if (typeof config === 'number') return config;
  const rec = contextRecs(root, config, { templates: cli.templatesDir, plugin: dirname(cli.templatesDir) }, cli.catalog).find((r) => r.n === n);
  if (!rec) return out(`No recommendation ${n}. Run harness context to list them.`), 2;
  if (!rec.apply) return out(`Recommendation ${n} changes your own file; the context-optimize skill shows you the diff first.`), 2;
  if (rec.kind === 'remove') return items('remove', [rec.target, ...(dryRun ? ['--dry-run'] : []), ...(yes ? ['--yes'] : [])], cli);
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;

  const abs = join(root, SETTINGS);
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  let merged: ReturnType<typeof mergePresetSettings>;
  try {
    merged = mergePresetSettings(before, [{ set: ['skillOverrides', rec.target], value: 'name-only' }], [], SETTINGS, 'harness');
  } catch (e) {
    if (e instanceof MergeError) return out(e.message), 1;
    throw e;
  }
  for (const note of merged.notes) out(`Note: ${note}`);
  if (!merged.blocks.length) return out('Nothing to change.'), 0;
  const change: Change = before === null
    ? { kind: 'create', rel: SETTINGS, content: merged.after, blocks: merged.blocks }
    : { kind: 'update', rel: SETTINGS, before, after: merged.after, blocks: merged.blocks };
  const touched = dirtyTouched(root, [change]);
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the change can be undone cleanly: ${touched.join(', ')}.`), 1;
  out('Plan:');
  out(`  ${change.kind} ${SETTINGS}`);
  out(unifiedDiff(before ?? '', merged.after, SETTINGS).trimEnd());
  if (dryRun) return out('Dry run: nothing was written.'), 0;
  if (!yes && !(await cli.prompt.confirm('Apply these changes? [y/N]'))) return out('Cancelled. Nothing was written.'), 0;

  const at = new Date();
  const files = mergeManifestFiles(m, [change], `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  try {
    applyChanges(root, [change], m.version, () => at, cli.fs, { manifest: { ...m, files }, manifestBefore: rawOf(m) });
  } catch (e) {
    if (e instanceof ApplyError) return out(e.message), 1;
    throw e;
  }
  stampHarnessFiles(root); // change detection: this write is harness's own
  out(`${change.kind === 'create' ? 'Created' : 'Updated'} \`${SETTINGS}\``);
  out('Run harness git commit on a branch to commit this change.');
  return 0;
}
