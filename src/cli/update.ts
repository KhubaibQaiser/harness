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
import { AI_USAGE, isDenied, loadAiInputs, missingAi, sandboxLine, takeAiFlags, type AiInputs } from './init.js';
import { budgetGate, installSelected } from './install-selection.js';
import { hasAiFlags, insideClaude, refuseOutsideClaude } from './claude-only.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { openInstall } from './preamble.js';
import type { CliEnv } from './index.js';
import type { HarnessConfig } from '../core/config.js';
import type { Catalog } from '../catalog/schema.js';

export type UpdateEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; fetchImpl?: typeof fetch; fs?: FsLike; exec?: Exec; claudeVersion?: () => string | null };

const USAGE = `Usage: /harness:update [--yes] [--check] [--dry-run] [--plan] ${AI_USAGE}`;
const PKG = '@khubaibqaiser/harness';
const CONFIG = '.harness/config.yaml';
const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';
const FACTS = '.harness/facts.json';
const AGAIN = 'Run /harness:update again to get recommendations for this repo.';
const USAGE_EXIT = 2;
const JSON_INDENT = 2;

type AiFlags = NonNullable<ReturnType<typeof takeAiFlags>>['ai'];
type Flags = { ai: AiFlags; plan: boolean; yes: boolean; dryRun: boolean };
/** `config`: the selection's config, before updatePreset; reconcile plans from updatePreset's config, the budget gate reads this one (as before the split). */
type Selection = { aiPath: boolean; catalog?: Catalog; config: HarnessConfig; sel: AiInputs | null };
type Planned = ReturnType<typeof reconcile>;
/** One update run: who asked, where, what the manifest holds, and the selection it plans from. */
type Run = Selection & { cli: UpdateEnv; args: string[]; root: string; m: Manifest; at: Date; flags: Flags; base: HarnessConfig };

export async function update(args: string[], cli: UpdateEnv): Promise<number> {
  const flags = parseFlags(args, cli);
  if (typeof flags === 'number') return flags;
  if (args.includes('--check')) return checkLatest(cli);
  const opened = openInstall(cli, 'Not a git repository. Run /harness:update inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;
  const read = readConfig(root, cli.out);
  if (typeof read === 'number') return read;
  if (flags.plan) return previewPlan(root, read.config, cli.out);
  const s = pickSelection(cli, root, read.config, { ai: flags.ai, aiFlags: hasAiFlags(args) });
  if (typeof s === 'number') return s;
  const built = buildPlan(cli, root, m, { ...s, migrated: read.migrated });
  if (typeof built === 'number') return built;
  const r: Run = { ...s, cli, args, root, m, at: new Date(), flags, base: read.config };
  // A file with no change still loses its dropped blocks (leaving `always` with no key left to delete changes no bytes).
  const stale = pruneStale(m, built.changes, built.planned.dropped);
  if (!built.changes.length && !stale) return nothingToApply(r);
  const stop = await reviewPlan(r, built.changes, built.planned);
  return stop ?? applyUpdate(r, built.changes);
}

/** The flags, checked before anything is read: a usage error, a refusal or a missing input exits 2. */
function parseFlags(args: string[], cli: UpdateEnv): Flags | number {
  const { out } = cli;
  const taken = takeAiFlags(args);
  if (!taken || taken.rest.some((a) => a !== '--yes' && a !== '--check' && a !== '--dry-run' && a !== '--plan') || misused(args, taken.ai)) return out(USAGE), USAGE_EXIT;
  const ai = taken.ai;
  const plan = args.includes('--plan'); // a preview: prints JSON and writes nothing
  const refused = refusal(args, cli, ai);
  if (refused) return out(refused), USAGE_EXIT;
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  if (!yes && !dryRun && !plan && !args.includes('--check') && cli.tty === false) return out(NO_TTY), USAGE_EXIT;
  return { ai, plan, yes, dryRun };
}

/** `--plan` takes no other flag, and the AI-only flags need the AI inputs. */
function misused(args: string[], ai: AiFlags): boolean {
  const plan = args.includes('--plan');
  return (plan && (args.length > 1 || hasAiFlags(args))) || (!hasAiFlags(args) && (ai.installPlugins || ai.overBudget));
}

/** Outside Claude Code (unless --check or --plan), then a missing AI input: the message to print, else null. */
function refusal(args: string[], cli: UpdateEnv, ai: AiFlags): string | null {
  const check = args.includes('--check');
  const refused = check || args.includes('--plan') ? null : refuseOutsideClaude('update', cli.env, hasAiFlags(args));
  if (refused) return refused;
  return !check && hasAiFlags(args) ? missingAi('update', ai) : null;
}

async function checkLatest(cli: UpdateEnv): Promise<number> {
  const { out, version } = cli;
  const latest = await latestVersion(PKG, cli.fetchImpl);
  if (latest === null) return out('Could not reach npm to check for a newer version. Try again later.'), 1;
  out(latest === version ? `Harness ${version} is the latest.` : `Harness ${latest} is available (you have ${version}). Plugin users: update the plugin, then run /harness:update. CLI users: npx ${PKG}@latest update.`);
  return 0;
}

/**
 * Strict validation: update plans from this config, so a mistake in it should stop us, not be skipped silently.
 * The old default results_dir is now a config error, so it is migrated first (ruling 9): a one-line edit, not a rewrite.
 */
function readConfig(root: string, out: UpdateEnv['out']): { config: HarnessConfig; migrated: Change | null } | number {
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
  return { config: v.config, migrated };
}

/** `--plan`: whether to re-run the recommend flow, the catalog delta and what to re-ask, as JSON. */
function previewPlan(root: string, config: HarnessConfig, out: UpdateEnv['out']): number {
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
  const recommend = config.catalog_version !== lc.catalog.version || stored?.trimEnd() !== factsJson(now);
  return out(JSON.stringify({ recommend, delta: catalogDelta(config, lc.catalog), reask: contradictions(prev, now, config) }, null, JSON_INDENT)), 0;
}

/** The selection to plan from: the AI inputs when given, else the config's own items less the retired ones. */
function pickSelection(cli: UpdateEnv, root: string, base: HarnessConfig, o: { ai: AiFlags; aiFlags: boolean }): Selection | number {
  const { out } = cli;
  const aiPath = base.items.length > 0 || o.aiFlags; // a selection from the recommend flow: the plan owns the config
  const cat = aiPath && !o.aiFlags ? loadCatalog() : null;
  if (cat?.errors.length) return cat.errors.forEach((e) => out(e)), out(CATALOG_BROKEN), 1;
  let config = base;
  let sel: AiInputs | null = null;
  if (o.aiFlags) {
    const r = loadAiInputs(o.ai, detect(root), (cli.claudeVersion ?? realClaudeVersion)(), configToAnswers(base));
    if (!r.ok) return r.errors.forEach((e) => out(e)), r.code;
    sel = r.in;
    for (const n of sel.notices) out(n);
    config = { ...answersToConfig(config, sel.answers), items: toSelected(sel.picks, sel.ids, sel.catalog), catalog_version: sel.catalog.version };
  }
  if (!aiPath) return { aiPath, config, sel };
  const catalog = sel?.catalog ?? cat!.catalog;
  const retired = reportDelta(out, base, sel, catalog);
  if (!sel) config = { ...config, items: config.items.filter((i) => !retired.includes(i.id)) };
  return { aiPath, catalog, config, sel };
}

/** Prints what is new, changed, conflicting and retired; returns the retired ids. */
function reportDelta(out: UpdateEnv['out'], base: HarnessConfig, sel: AiInputs | null, catalog: Catalog): string[] {
  const d = catalogDelta(base, catalog);
  const had = new Set(base.items.map((i) => i.id));
  const fresh = sel ? sel.picks.items.map((i) => i.id).filter((id) => !had.has(id)) : [];
  if (fresh.length) out(`New: ${fresh.join(', ')}`);
  if (sel && d.changed.length) out(`Changed in the catalog: ${d.changed.join(', ')}`);
  if (sel) for (const [a, b] of d.conflicting) out(`Now conflicting: ${a} and ${b}.`);
  for (const id of d.retired) out(`${id}: no longer in the catalog; its files are kept.`);
  return d.retired;
}

function buildPlan(cli: UpdateEnv, root: string, m: Manifest, s: Selection & { migrated: Change | null }): { planned: Planned; changes: Change[] } | number {
  const { out, version } = cli;
  const pr = updatePreset(s.config, s.sel, { root, version, out });
  let planned: Planned;
  try {
    planned = reconcile(root, pr.config, m, {
      version, distDir: cli.distDir, templatesDir: cli.templatesDir, legacyDir: LEGACY_RESULTS_DIR,
      ...(s.aiPath ? { catalog: s.catalog } : {}), ...(s.sel ? { ai: s.sel.files } : {}), preset: pr.preset,
    });
  } catch (e) {
    return out(`Cannot build the update plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  const changes = s.aiPath || pr.changed ? planned.changes : [...(s.migrated ? [s.migrated] : []), ...planned.changes.filter((c) => c.rel !== CONFIG)]; // the user owns the config after init, except on the AI path (and a preset change)
  return { planned, changes };
}

function commit(r: Run, cs: Change[], manifest: Manifest): string | null {
  try {
    applyChanges(r.root, cs, r.cli.version, () => r.at, r.cli.fs, { manifest, manifestBefore: rawOf(r.m) });
    return null;
  } catch (e) {
    if (e instanceof ApplyError) return isDenied(e) ? sandboxLine('update', r.args) : e.message;
    throw e;
  }
}

/** An unchanged selection still installs its plugins when asked (a failed install is retried that way). */
async function inst(r: Run, ask: boolean, applied: boolean): Promise<number> {
  const { out } = r.cli;
  if (!r.sel || !r.flags.ai.installPlugins) return 0;
  if (ask && !r.flags.yes && !(await r.cli.prompt.confirm('Install these plugins? (y/N)'))) return out('Cancelled. No plugins were installed.'), 0;
  return installSelected({ root: r.root, chosen: r.sel.ids, cat: r.sel.catalog, exec: r.cli.exec ?? defaultExec, out, applied });
}

/** Nothing to write: up to date, or only the manifest version moves. */
async function nothingToApply(r: Run): Promise<number> {
  const { out, version } = r.cli;
  const { m } = r;
  if (r.flags.dryRun) return out(m.version === version ? `Harness ${version} is up to date.` : `Harness files already match ${version}. Dry run: nothing was written.`), 0;
  if (m.version === version) {
    out(`Harness ${version} is up to date.`);
    if (insideClaude(r.cli.env) && !r.aiPath) out(AGAIN);
    return inst(r, true, false);
  }
  const err = commit(r, [], { ...m, version });
  if (!err) stampHarnessFiles(r.root);
  out(err ?? `Harness files already match ${version}. Manifest version updated from ${m.version}.`);
  return err ? 1 : inst(r, true, false);
}

/** Shows the plan and asks; null to go on and apply it, else the exit code. */
async function reviewPlan(r: Run, changes: Change[], planned: Planned): Promise<number | null> {
  const { out } = r.cli;
  const { yes, dryRun } = r.flags;
  const touched = dirtyTouched(r.root, changes);
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the update can be undone cleanly: ${touched.join(', ')}.`), 1;
  printPlan(r, changes, planned);
  if (r.sel) {
    // Ask once, then exempt: what the person approved before shows but does not count.
    const had = approvedIds(r.base, r.m, r.sel.catalog);
    const stop = await budgetGate({ cat: r.sel.catalog, before: had, after: r.sel.ids, exempt: had, budget: r.config.context.budget_tokens, templatesDir: r.cli.templatesDir, out, f: { yes, dryRun, overBudget: r.flags.ai.overBudget } });
    if (stop !== null) return stop;
  }
  const list = (rels: string[]) => rels.map((rel) => `\`${rel}\``).join(', ');
  const { owned: editedOwned, merged: editedMerged } = planned.edited;
  if (editedOwned.length) out(`You edited these harness files; update replaces them: ${list(editedOwned)}.`);
  if (editedMerged.length) out(`You edited these files; update changes only the harness parts: ${list(editedMerged)}.`);
  if (dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!yes && !(await r.cli.prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;
  return null;
}

function printPlan(r: Run, changes: Change[], planned: Planned): void {
  const { out } = r.cli;
  out(changes.length ? `Update ${r.m.version} -> ${r.cli.version}:` : 'Only the manifest changes.');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  if (planned.manual.length) out('Do these by hand:\n' + planned.manual.map((l) => `  ${l}`).join('\n'));
  for (const n of planned.notes) out(`Note: ${n}`);
}

async function applyUpdate(r: Run, changes: Change[]): Promise<number> {
  const { out, version } = r.cli;
  const { root, m, at } = r;
  // One transaction: the files and the merged manifest commit together or roll back together.
  const files = mergeManifestFiles(m, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  const err = commit(r, changes, { version, createdAt: at.toISOString(), ...(m.tddOff ? { tddOff: m.tddOff } : {}), files });
  if (err) return out(err), 1;
  removeEmptyDirs(root, changes);
  // The original is back in place. The path comes from the manifest, so delete only inside .harness/backup/.
  dropRestoredBackups(root, changes);
  stampHarnessFiles(root); // change detection: these writes are harness's own
  const installed = await inst(r, false, true);

  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  out(`Harness updated to ${version}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  if (insideClaude(r.cli.env) && !r.aiPath) out(AGAIN);
  return installed;
}
