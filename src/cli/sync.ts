import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CATALOG_BROKEN, loadCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import { validateConfig } from '../core/config-io.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { ApplyError, type Change, type FsLike, ManifestError, applyChanges, readManifest, removeEmptyDirs, type Manifest } from '../install/apply.js';
import { unifiedDiff } from '../install/diff.js';
import { dirtyPaths } from '../install/git-status.js';
import { MANIFEST_REL, itemFiles, mergeManifestFiles, rehashManifest, settingsOnlyPluginEdits } from '../install/manifest.js';
import { pinnedPlugins, STRUCTURAL } from '../install/merge.js';
import { pluginList } from '../install/plugin-install.js';
import { selectedIds } from '../install/plan.js';
import { reconcile } from '../install/reconcile.js';
import { refuseOutsideClaude } from './claude-only.js';
import { budgetGate, installSelected, isDenied, sandboxLine } from './init.js';
import { isBackupPath } from './update.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type SyncEnv = CliEnv & { prompt: Prompt; version?: string; templatesDir: string; distDir: string; fs?: FsLike; exec?: Exec; catalog?: Catalog };

const USAGE = 'Usage: /harness:sync [--dry-run|--yes] [--take <file,...>] [--install-plugins] [--over-budget]';
const CONFIG = '.harness/config.yaml';
const list = (rels: string[]) => rels.map((r) => `\`${r}\``).join(', ');

export async function sync(args: string[], cli: SyncEnv): Promise<number> {
  const { out } = cli;
  const take: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--take') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return out(USAGE), 2;
      take.push(...v.split(',').filter(Boolean));
    } else if (['--yes', '--dry-run', '--install-plugins', '--over-budget'].includes(a) && !flags.has(a)) flags.add(a);
    else return out(USAGE), 2;
  }
  const [yes, dryRun, installFlag, overBudget] = ['--yes', '--dry-run', '--install-plugins', '--over-budget'].map((f) => flags.has(f));
  const refused = refuseOutsideClaude('sync', cli.env, false);
  if (refused) return out(refused), 2;
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli.root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return out('Not a git repository. Run /harness:sync inside a git repo.'), 1;
  }
  let m: Manifest | null;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.'), 1;
  const man = m;
  let config;
  try {
    const v = validateConfig(parseYaml(readFileSync(join(root, CONFIG), 'utf8')));
    if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;
    config = v.config;
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
  if (!config.items.length) return out('This install predates the item catalog. Run /harness:update with recommendations first.'), 1;
  const lc = cli.catalog ? { catalog: cli.catalog, errors: [] as string[] } : loadCatalog();
  if (lc.errors.length) return lc.errors.forEach((e) => out(e)), out(CATALOG_BROKEN), 1;
  const cat = lc.catalog;
  if (cli.version && cli.version !== man.version) return out(`Harness files are ${man.version} but this is ${cli.version}. Run /harness:update first; sync does not change the version.`), 1;
  const have = selectedIds(config);

  let planned: ReturnType<typeof reconcile>;
  try {
    planned = reconcile(root, config, man, { version: man.version, distDir: cli.distDir, templatesDir: cli.templatesDir, catalog: cat });
  } catch (e) {
    return out(`Cannot build the plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  const { owned, merged } = planned.edited;
  const unknown = take.filter((r) => !owned.includes(r));
  if (unknown.length) return out(`--take names files that are not edited harness-owned files: ${list(unknown)}.`), 2;
  // An edited file whose whole content is harness's is kept unless named in --take; a merged one changes only harness's parts.
  const kept = owned.filter((r) => !take.includes(r));
  const changes: Change[] = planned.changes.filter((c) => !kept.includes(c.rel));
  // A recorded file of an unselected item that is already gone: only its manifest entry is left.
  const gone = man.files.filter((f) => f.item && !have.includes(f.item) && !existsSync(join(root, f.rel)) && !changes.some((c) => c.rel === f.rel));
  // A file with no change still loses its dropped blocks.
  let stale = 0;
  for (const rel of STRUCTURAL) {
    const f = man.files.find((x) => x.rel === rel);
    if (changes.some((c) => c.rel === rel) || !f?.blocks) continue;
    const left = f.blocks.filter((b) => !planned.dropped.includes(b));
    stale += f.blocks.length - left.length;
    if (left.length) f.blocks = left;
    else delete f.blocks;
  }

  const wanted = pinnedPlugins(cat.items.filter((i) => have.includes(i.id))).map((p) => `${p.name}@harness-pins`);
  let present: string[] = [];
  let missing: string[] = [];
  if (wanted.length) {
    const l = pluginList(cli.exec ?? defaultExec); // read-only, so the preview can report what is missing
    if (!l && installFlag) return out('Could not read the installed plugins (`claude plugin list` failed). Nothing was changed.'), 1;
    present = (l ?? []).map((p) => p.id);
    missing = l ? wanted.filter((id) => !present.includes(id)) : [];
  }
  // Recording an install touches settings.json's hash, so it needs the flag and proof that every wanted plugin is installed.
  const record = installFlag && wanted.length > 0 && !missing.length;
  const recordInstall = (): number | null => {
    if (!settingsOnlyPluginEdits(root, wanted)) return out('settings.json has other edits; not recorded. Run /harness:update to review them.'), null;
    const before = readFileSync(join(root, MANIFEST_REL), 'utf8');
    try {
      rehashManifest(root, ['.claude/settings.json']);
    } catch (e) {
      if (!(e instanceof ApplyError)) throw e;
      return out(isDenied(e) ? sandboxLine('sync', args) : e.message), 1;
    }
    if (readFileSync(join(root, MANIFEST_REL), 'utf8') !== before) out('Recorded the plugin install in the manifest.');
    return null;
  };

  for (const r of kept) out(`Kept \`${r}\`: you edited it. Name it in --take to replace it with harness's version.`);
  for (const n of planned.notes) out(`Note: ${n}`);
  if (planned.manual.length) out('Do these by hand:\n' + planned.manual.map((l) => `  ${l}`).join('\n'));
  if (!changes.length && !gone.length && !stale) {
    if (dryRun) return out(missing.length ? `Plugins not installed: ${missing.join(', ')}. Run with --install-plugins to install them. Dry run: nothing was written.` : 'Nothing to sync. Dry run: nothing was written.'), 0;
    if (!missing.length) {
      if (record) { const r = recordInstall(); if (r !== null) return r; }
      return out('Nothing to sync.'), 0;
    }
  }

  const dirty = dirtyPaths(root);
  const touched = changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  const dirtyLine = `Commit or stash these files first, so the change can be undone cleanly: ${touched.join(', ')}.`;
  if (touched.length && !dryRun) return out(dirtyLine), 1;
  if (touched.length) out(dirtyLine); // a preview still says so, and exits 0
  if (changes.length || gone.length) out('Plan:');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  for (const f of gone) out(`  forget ${f.rel} (${f.item} is not selected)`);
  if (merged.length) out(`You edited these files; sync changes only the harness parts: ${list(merged)}.`);
  // Installed items are approved: they show, but only a selected item that was never installed counts.
  const approved = have.filter((id) => itemFiles(man, id).length > 0);
  const stop = await budgetGate(cat, approved, have, approved, config.context.budget_tokens, cli.templatesDir, out, { yes, dryRun, overBudget });
  if (stop !== null) return stop;
  if (dryRun) {
    if (missing.length) out(`Plugins not installed: ${missing.join(', ')}. ${installFlag ? 'Would install them.' : 'Run with --install-plugins to install them.'}`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!yes && !(await cli.prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  const at = new Date();
  let files = mergeManifestFiles(man, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  files = files.filter((f) => !gone.some((g) => g.rel === f.rel));
  try {
    applyChanges(root, changes, man.version, () => at, cli.fs, { manifest: { ...man, files } });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine('sync', args) : e.message), 1;
    throw e;
  }
  removeEmptyDirs(root, changes);
  // The original is back in place. The path comes from the manifest; delete only inside .harness/backup/.
  for (const c of changes) if (c.kind === 'update' && c.restored && isBackupPath(c.restored)) rmSync(join(root, c.restored), { force: true });
  stampHarnessFiles(root); // change detection: these writes are harness's own
  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  let code = 0;
  if (installFlag && missing.length) code = installSelected(root, have, cat, cli.exec ?? defaultExec, out, true, present);
  else if (record) code = recordInstall() ?? 0;
  out('Run harness git commit on a branch to commit this change.');
  return code;
}
