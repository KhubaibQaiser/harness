import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LEGACY_RESULTS_DIR } from '../core/config.js';
import { migrateResultsDir, validateConfig } from '../core/config-io.js';
import { answersToConfig, configToAnswers } from '../ai/answers.js';
import { latestVersion } from '../core/registry.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { claudeVersion as realClaudeVersion } from '../core/min-claude.js';
import { ApplyError, type Change, type FsLike, ManifestError, applyChanges, removeEmptyDirs, readManifest, type Manifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL, mergeManifestFiles, rawOf } from '../install/manifest.js';
export { isBackupPath } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { reconcile } from '../install/reconcile.js';
import { selectedIds } from '../install/plan.js';
import { toSelected } from '../install/select.js';
import { STRUCTURAL } from '../install/merge.js';
import { CATALOG_BROKEN, loadCatalog } from '../catalog/load.js';
import { catalogDelta, contradictions } from '../install/delta.js';
import { factsJson } from '../install/facts.js';
import type { Facts } from '../install/detect.js';
import { approvedIds } from '../install/approved.js';
import { dirtyTouched, dropRestoredBackups, pruneStale } from '../install/finish.js';
import { updatePreset } from './preset-inputs.js';
import { AI_USAGE, budgetGate, installSelected, isDenied, loadAiInputs, missingAi, sandboxLine, takeAiFlags, type AiInputs } from './init.js';
import { hasAiFlags, insideClaude, refuseOutsideClaude } from './claude-only.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { openInstall } from './preamble.js';
import type { CliEnv } from './index.js';

export type UpdateEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; fetchImpl?: typeof fetch; fs?: FsLike; exec?: Exec; claudeVersion?: () => string | null };

const USAGE = `Usage: /harness:update [--yes] [--check] [--dry-run] [--plan] ${AI_USAGE}`;
const PKG = '@khubaibqaiser/harness';
const CONFIG = '.harness/config.yaml';
const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';
const FACTS = '.harness/facts.json';
const AGAIN = 'Run /harness:update again to get recommendations for this repo.';


export async function update(args: string[], cli: UpdateEnv): Promise<number> {
  const { out, prompt, version } = cli;
  const taken = takeAiFlags(args);
  if (!taken || taken.rest.some((a) => a !== '--yes' && a !== '--check' && a !== '--dry-run' && a !== '--plan')) return out(USAGE), 2;
  const ai = taken.ai;
  const plan = args.includes('--plan'); // a preview: prints JSON and writes nothing
  if (plan && (args.length > 1 || hasAiFlags(args))) return out(USAGE), 2;
  if (!hasAiFlags(args) && (ai.installPlugins || ai.overBudget)) return out(USAGE), 2;
  const refused = args.includes('--check') || plan ? null : refuseOutsideClaude('update', cli.env, hasAiFlags(args));
  if (refused) return out(refused), 2;
  const lacking = !args.includes('--check') && hasAiFlags(args) ? missingAi('update', ai) : null;
  if (lacking) return out(lacking), 2;
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  if (!yes && !dryRun && !plan && !args.includes('--check') && cli.tty === false) return out(NO_TTY), 2;

  if (args.includes('--check')) {
    const latest = await latestVersion(PKG, cli.fetchImpl);
    if (latest === null) return out('Could not reach npm to check for a newer version. Try again later.'), 1;
    out(latest === version ? `Harness ${version} is the latest.` : `Harness ${latest} is available (you have ${version}). Plugin users: update the plugin, then run /harness:update. CLI users: npx ${PKG}@latest update.`);
    return 0;
  }

  const opened = openInstall(cli, 'Not a git repository. Run /harness:update inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;

  // Strict validation: update plans from this config, so a mistake in it should stop us, not be skipped silently.
  // The old default results_dir is now a config error, so it is migrated first (ruling 9): a one-line edit, not a rewrite.
  let raw: unknown;
  let migrated: Change | null = null;
  try {
    const text = readFileSync(join(root, CONFIG), 'utf8');
    const after = migrateResultsDir(text);
    if (after !== null) migrated = { kind: 'update', rel: CONFIG, before: text, after, blocks: [] };
    raw = parseYaml(after ?? text);
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
  const v = validateConfig(raw);
  if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;

  if (plan) {
    const lc = loadCatalog();
    if (lc.errors.length) return lc.errors.forEach((e) => out(e)), out(CATALOG_BROKEN), 1;
    const now = detect(root);
    let stored: string | null = null;
    let prev: Facts | null = null;
    try {
      stored = readFileSync(join(root, FACTS), 'utf8');
      const j = JSON.parse(stored);
      if (Array.isArray(j?.apps) && Array.isArray(j?.deploy)) prev = j as Facts; // any other shape counts as missing
    } catch { /* missing or unreadable: nothing to compare, so nothing is re-asked */ }
    const recommend = v.config.catalog_version !== lc.catalog.version || stored?.trimEnd() !== factsJson(now);
    return out(JSON.stringify({ recommend, delta: catalogDelta(v.config, lc.catalog), reask: contradictions(prev, now, v.config) }, null, 2)), 0;
  }
  const aiFlags = hasAiFlags(args);
  const aiPath = v.config.items.length > 0 || aiFlags; // a selection from the recommend flow: the plan owns the config
  const cat = aiPath && !aiFlags ? loadCatalog() : null;
  if (cat?.errors.length) return cat.errors.forEach((e) => out(e)), out(CATALOG_BROKEN), 1;
  let config = v.config;
  let sel: AiInputs | null = null;
  if (aiFlags) {
    const r = loadAiInputs(ai, detect(root), (cli.claudeVersion ?? realClaudeVersion)(), configToAnswers(v.config));
    if (!r.ok) return r.errors.forEach((e) => out(e)), r.code;
    sel = r.in;
    for (const n of sel.notices) out(n);
    config = { ...answersToConfig(config, sel.answers), items: toSelected(sel.picks, sel.ids, sel.catalog), catalog_version: sel.catalog.version };
  }
  if (aiPath) {
    const d = catalogDelta(v.config, sel?.catalog ?? cat!.catalog);
    const had = new Set(v.config.items.map((i) => i.id));
    const fresh = sel ? sel.picks.items.map((i) => i.id).filter((id) => !had.has(id)) : [];
    if (fresh.length) out(`New: ${fresh.join(', ')}`);
    if (sel && d.changed.length) out(`Changed in the catalog: ${d.changed.join(', ')}`);
    if (sel) for (const [a, b] of d.conflicting) out(`Now conflicting: ${a} and ${b}.`);
    for (const id of d.retired) out(`${id}: no longer in the catalog; its files are kept.`);
    if (!sel) config = { ...config, items: config.items.filter((i) => !d.retired.includes(i.id)) };
  }
  const pr = updatePreset(config, sel, root, version);
  config = pr.config;
  for (const n of pr.notices) out(n);
  let planned: ReturnType<typeof reconcile>;
  try {
    planned = reconcile(root, config, m, {
      version, distDir: cli.distDir, templatesDir: cli.templatesDir, legacyDir: LEGACY_RESULTS_DIR,
      ...(aiPath ? { catalog: (sel?.catalog ?? cat!.catalog) } : {}), ...(sel ? { ai: sel.files } : {}), preset: pr.preset,
    });
  } catch (e) {
    return out(`Cannot build the update plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  // The user owns the config after init, except on the AI path, where the checks follow the selection.
  const changes = aiPath || pr.changed ? planned.changes : [...(migrated ? [migrated] : []), ...planned.changes.filter((c) => c.rel !== CONFIG)];

  const at = new Date();
  const commit = (cs: typeof changes, manifest: Manifest) => {
    try {
      applyChanges(root, cs, version, () => at, cli.fs, { manifest, manifestBefore: rawOf(m) });
      return null;
    } catch (e) {
      if (e instanceof ApplyError) return isDenied(e) ? sandboxLine('update', args) : e.message;
      throw e;
    }
  };
  // A file with no change still loses its dropped blocks (leaving `always` with no key left to delete changes no bytes).
  const stale = pruneStale(m, changes, planned.dropped);
  // An unchanged selection still installs its plugins when asked (a failed install is retried that way).
  const inst = async (ask: boolean, applied: boolean) => {
    if (!sel || !ai.installPlugins) return 0;
    if (ask && !yes && !(await prompt.confirm('Install these plugins? (y/N)'))) return out('Cancelled. No plugins were installed.'), 0;
    return installSelected(root, sel.ids, sel.catalog, cli.exec ?? defaultExec, out, applied);
  };
  if (!changes.length && !stale) {
    if (dryRun) return out(m.version === version ? `Harness ${version} is up to date.` : `Harness files already match ${version}. Dry run: nothing was written.`), 0;
    if (m.version === version) {
      out(`Harness ${version} is up to date.`);
      if (insideClaude(cli.env) && !aiPath) out(AGAIN);
      return inst(true, false);
    }
    const err = commit([], { ...m, version });
    if (!err) stampHarnessFiles(root);
    out(err ?? `Harness files already match ${version}. Manifest version updated from ${m.version}.`);
    return err ? 1 : inst(true, false);
  }

  const touched = dirtyTouched(root, changes);
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the update can be undone cleanly: ${touched.join(', ')}.`), 1;

  const list = (rels: string[]) => rels.map((r) => `\`${r}\``).join(', ');
  const { owned: editedOwned, merged: editedMerged } = planned.edited;
  out(changes.length ? `Update ${m.version} -> ${version}:` : 'Only the manifest changes.');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  if (planned.manual.length) out('Do these by hand:\n' + planned.manual.map((l) => `  ${l}`).join('\n'));
  for (const n of planned.notes) out(`Note: ${n}`);
  if (sel) {
    // Ask once, then exempt: what the person approved before shows but does not count.
    const had = approvedIds(v.config, m, sel.catalog);
    const stop = await budgetGate(sel.catalog, had, sel.ids, had, config.context.budget_tokens, cli.templatesDir, out, { yes, dryRun, overBudget: ai.overBudget });
    if (stop !== null) return stop;
  }
  if (editedOwned.length) out(`You edited these harness files; update replaces them: ${list(editedOwned)}.`);
  if (editedMerged.length) out(`You edited these files; update changes only the harness parts: ${list(editedMerged)}.`);
  if (dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  // One transaction: the files and the merged manifest commit together or roll back together.
  const files = mergeManifestFiles(m, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  const err = commit(changes, { version, createdAt: at.toISOString(), ...(m.tddOff ? { tddOff: m.tddOff } : {}), files });
  if (err) return out(err), 1;
  removeEmptyDirs(root, changes);
  // The original is back in place. The path comes from the manifest, so delete only inside .harness/backup/.
  dropRestoredBackups(root, changes);
  stampHarnessFiles(root); // change detection: these writes are harness's own
  const installed = await inst(false, true);

  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  out(`Harness updated to ${version}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  if (insideClaude(cli.env) && !aiPath) out(AGAIN);
  return installed;
}
