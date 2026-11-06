import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { overlay } from '../core/config.js';
import { validateConfig } from '../core/config-io.js';
import type { HarnessConfig } from '../core/config.js';
import { answersToConfig } from '../ai/answers.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { claudeVersion as realClaudeVersion } from '../core/min-claude.js';
import { approvedIds } from '../install/approved.js';
import { ApplyError, type FsLike, ManifestError, applyChanges, readManifest } from '../install/apply.js';
import { type Facts } from '../install/detect.js';
import { dirtyPaths } from '../install/git-status.js';
import { toSelected } from '../install/select.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { planChanges } from '../install/plan.js';
import { coverageSkipped, coverageWhy, preset, type Preset, unsafeWhy } from '../install/preset.js';
import { findOnPath } from '../checks/stop/runner.js';
import { type AiArgs, type AiInputs, EXIT_USAGE, loadAiInputs, missingAi, takeAiFlags } from './ai-inputs.js';
import { hasAiFlags, refuseOutsideClaude } from './claude-only.js';
import { budgetGate, installSelected } from './install-selection.js';
import { isDenied, sandboxLine } from './own-command.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { presetConfig } from './preset-inputs.js';
import { gitRoot } from '../core/repo-root.js';
import type { CliEnv } from './index.js';

export type { Prompt };
export { planChanges };
export { type AiArgs, type AiInputs, loadAiInputs, missingAi, overlayAnswers, takeAiFlags } from './ai-inputs.js';
export { budgetGate, installSelected } from './install-selection.js';
export { isDenied, ownCommand, sandboxLine, shq } from './own-command.js';

export type InitEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; nodeVersion?: string; exec?: Exec; fs?: FsLike; claudeVersion?: () => string | null };

export const AI_USAGE = '[--answers <file> --product <file> --picks <file> --report <file> --choose <id,...>] [--install-plugins] [--over-budget]';
const USAGE = `Usage: /harness:init [--yes] [--dry-run] [--config <file>] ${AI_USAGE}`;
const GATES: Record<string, string> = { guard: 'guard', protect: 'protect', depVerify: 'dep-verify', multiFile: 'multi-file', tdd: 'TDD', stop: 'stop', prSize: 'PR size' };
const NODE_MIN_MAJOR = 22, NODE_MIN_MINOR = 11;

const at = (o: any, path: string): unknown => path.split('.').reduce((v, k) => v?.[k], o);

type Opts = { yes: boolean; dryRun: boolean; config?: string };
type Flags = { ai: AiArgs; opts: Opts; aiPath: boolean };
/** One init run's inputs, shared by its steps. */
type Run = { cli: InitEnv; f: Flags; root: string; facts: Facts; p: Preset };
type Built = { plan: ReturnType<typeof planChanges>; touched: string[] };

function parseArgs(args: string[]): Opts | null {
  const o: Opts = { yes: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') o.yes = true;
    else if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--config' && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) o.config = args[++i];
    else return null;
  }
  return o;
}

/** The parsed flags, or the exit code for a usage error. */
function readFlags(args: string[], cli: InitEnv): Flags | number {
  const { out } = cli;
  const taken = takeAiFlags(args);
  const opts = taken && parseArgs(taken.rest);
  if (!taken || !opts) return out(USAGE), EXIT_USAGE;
  const ai = taken.ai;
  const aiPath = hasAiFlags(args);
  const refused = refuseOutsideClaude('init', cli.env, aiPath);
  if (refused) return out(refused), EXIT_USAGE;
  if (!aiPath && (ai.installPlugins || ai.overBudget)) return out(USAGE), EXIT_USAGE;
  const lacking = aiPath ? missingAi('init', ai) : null;
  if (lacking) return out(lacking), EXIT_USAGE;
  if (!opts.yes && !opts.dryRun && cli.tty === false) return out(NO_TTY), EXIT_USAGE;
  return { ai, opts, aiPath };
}

/** The repo root when harness can install there, or the exit code. */
function preflight(cli: InitEnv): string | number {
  const { out } = cli;
  const root = gitRoot(cli.root);
  if (!root) return out('Not a git repository. Run /harness:init inside a git repo.'), 1;
  out(`Installing at the repo root: ${resolve(root)}`);
  const node = cli.nodeVersion ?? process.versions.node;
  const [major, minor] = node.split('.').map(Number);
  if (major < NODE_MIN_MAJOR || (major === NODE_MIN_MAJOR && minor < NODE_MIN_MINOR)) return out(`Node ${node} is too old. Harness needs Node ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} or newer.`), 1;
  try {
    if (readManifest(root)) return out('Harness is already installed (.harness/manifest.json). Run /harness:update instead.'), 1;
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  return root;
}

/** The config from --config, the AI path's preset, or the preset the person reviewed. */
async function chooseConfig(run: Run): Promise<HarnessConfig | number> {
  if (run.f.opts.config) return readConfigFile(run.f.opts.config, run.p.config, run.cli.out);
  if (run.f.aiPath) return run.p.config;
  return reviewPreset(run);
}

function readConfigFile(file: string, base: HarnessConfig, out: (s: string) => void): HarnessConfig | number {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    return out(`Could not read ${file}: ${(e as Error).message}`), EXIT_USAGE;
  }
  const v = validateConfig(raw);
  if (!v.ok) return v.errors.forEach((m) => out(m)), EXIT_USAGE;
  // Overlay onto the preset so a partial file keeps the detected values; the merged result is validated again.
  const merged = structuredClone(base);
  overlay(merged as unknown as Record<string, unknown>, raw as Record<string, unknown>, '', []);
  const v2 = validateConfig(merged);
  if (!v2.ok) return v2.errors.forEach((m) => out(m)), EXIT_USAGE;
  out(`Using the answers in ${file}.`);
  return v2.config;
}

async function reviewPreset({ cli, f, p }: Run): Promise<HarnessConfig | number> {
  const { out, prompt } = cli;
  const config = p.config;
  out('Recommended settings:');
  for (const [k, why] of Object.entries(p.reasons)) out(`  ${k} = ${JSON.stringify(at(config, k))}\n    ${why}`);
  if (p.off.length) out('Off for this repo:\n' + p.off.map((o) => `  ${o.gate}: ${o.why}`).join('\n'));
  if (p.skippedSteps.length) out('Stop steps left out:\n' + p.skippedSteps.map((s) => `  ${s.name}: ${s.why}. Install it, then add the step to stop.steps.`).join('\n'));
  if (f.opts.yes || f.opts.dryRun || !(await prompt.confirm('Edit any value? (y/N)'))) return config;
  return editConfig(config, prompt, out);
}

async function editConfig(config: HarnessConfig, prompt: Prompt, out: (s: string) => void): Promise<HarnessConfig | number> {
  const next: Record<string, unknown> = { ...config };
  for (const k of Object.keys(config).filter((k) => k !== 'version')) {
    const cur = JSON.stringify((config as any)[k]);
    const ans = await prompt.edit(k, cur);
    if (ans === cur) continue;
    try {
      next[k] = parseYaml(ans);
    } catch (e) {
      return out(`${k}: not valid JSON or YAML: ${(e as Error).message}`), EXIT_USAGE;
    }
  }
  const v = validateConfig(next);
  if (!v.ok) return v.errors.forEach((m) => out(m)), EXIT_USAGE;
  return v.config;
}

/** The AI step's files: validated, then they set the answers and the selection. */
function applyAiInputs({ cli, f, facts }: Run, base: HarnessConfig): { config: HarnessConfig; sel: AiInputs } | number {
  const r = loadAiInputs(f.ai, facts, (cli.claudeVersion ?? realClaudeVersion)());
  if (!r.ok) return r.errors.forEach((m) => cli.out(m)), r.code;
  const sel = r.in;
  for (const n of sel.notices) cli.out(n);
  const config: HarnessConfig = { ...answersToConfig(base, sel.answers), items: toSelected(sel.picks, sel.ids, sel.catalog, sel.reasons), catalog_version: sel.catalog.version };
  if (sel.preset) config.preset = presetConfig(sel.preset, cli.version, sel.presetItems);
  return { config, sel };
}

function buildPlan({ cli, f, root, facts }: Run, config: HarnessConfig, sel: AiInputs | null): Built | number {
  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, config, facts, { version: cli.version, distDir: cli.distDir, templatesDir: cli.templatesDir, ...(sel ? { catalog: sel.catalog, ai: sel.files, preset: sel.preset } : {}) });
  } catch (e) {
    return cli.out(`Cannot build the install plan: ${(e as Error).message}`), 1;
  }
  const dirty = dirtyPaths(root);
  const touched = plan.changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  if (touched.length && !f.opts.dryRun) return cli.out(`Commit or stash these files first, so the install can be undone cleanly: ${touched.join(', ')}.`), 1;
  return { plan, touched };
}

/** Prints the plan, then the budget, dry-run and confirm stops: the exit code to stop with, or null to apply. */
async function showPlan({ cli, f, p }: Run, { plan, touched }: Built, config: HarnessConfig, sel: AiInputs | null): Promise<number | null> {
  const { out, prompt } = cli;
  out('Plan:');
  for (const c of plan.changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  // With checks.tdd off the plan skips test configs, but the left-out packages still need their lines.
  const manual = [...new Set([...plan.manual, ...p.tddOff.flatMap((o) => o.manual)])];
  if (manual.length) out('Do these by hand:\n' + manual.map((l) => `  ${l}`).join('\n'));
  for (const n of plan.notes) out(`Note: ${n}`);
  if (sel) {
    const stop = await budgetGate({ cat: sel.catalog, before: [], after: sel.ids, exempt: approvedIds(config, null, sel.catalog), budget: config.context.budget_tokens, templatesDir: cli.templatesDir, out, f: { ...f.opts, overBudget: f.ai.overBudget } });
    if (stop !== null) return stop;
  }
  if (f.opts.dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!f.opts.yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;
  return null;
}

function reportGates({ cli: { out }, facts, p }: Run, plan: ReturnType<typeof planChanges>): void {
  const written = plan.config; // on the AI path its checks follow the selection, not the preset
  const checks = written.checks as Record<string, boolean>;
  // Coverage is on only if some TDD path is not skipped.
  const coverageOn = checks.tdd && written.tdd.paths.some((p) => !written.tdd.coverage_skip.includes(p));
  const gates = [...Object.keys(GATES).map((k) => [GATES[k], checks[k]] as const), ['coverage', coverageOn] as const];
  const why = (g: string) => p.off.find((o) => o.gate === g)?.why ?? 'Turned off in the config.';
  out('Gates that are on: ' + gates.filter(([, on]) => on).map(([g]) => g).join(', '));
  const off = gates.filter(([, on]) => !on);
  out('Gates that are off:' + (off.length ? '\n' + off.map(([g]) => `  ${g}: ${why(g)}`).join('\n') : ' none'));
  if (checks.tdd) for (const o of p.tddOff) out(unsafeWhy(o.dir, o.noConfig));
  if (checks.tdd) for (const p of coverageSkipped(facts, written)) out(coverageWhy(p));
  out(`Commit these files: ${[...plan.changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  out('Teammates need nothing else: the hooks are in the repo.');
}

export async function init(args: string[], cli: InitEnv): Promise<number> {
  const { out } = cli;
  const f = readFlags(args, cli);
  if (typeof f === 'number') return f;

  // 1. Preflight
  const root = preflight(cli);
  if (typeof root === 'number') return root;

  // 2. Detect and preset
  const facts = detect(root);
  const p = preset(facts, (cmd) => findOnPath(cmd, cli.env, process.platform));
  for (const w of facts.warnings) out(`Warning: ${w}`);
  const run: Run = { cli, f, root, facts, p };
  let config = await chooseConfig(run);
  if (typeof config === 'number') return config;
  let sel: AiInputs | null = null;
  if (f.aiPath) {
    const r = applyAiInputs(run, config);
    if (typeof r === 'number') return r;
    ({ config, sel } = r);
  }

  // 3. Build the changes
  const built = buildPlan(run, config, sel);
  if (typeof built === 'number') return built;

  // 4. Plan
  const stop = await showPlan(run, built, config, sel);
  if (stop !== null) return stop;

  // 5. Apply
  try {
    applyChanges(root, built.plan.changes, cli.version, undefined, cli.fs, { tddOff: p.tddOff.map((o) => o.dir) });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine('init', args) : e.message), 1;
    throw e;
  }
  stampHarnessFiles(root); // change detection: these writes are harness's own
  const installed = sel && f.ai.installPlugins ? installSelected({ root, chosen: sel.ids, cat: sel.catalog, exec: cli.exec ?? defaultExec, out }) : 0;

  // 6. Report
  reportGates(run, built.plan);
  return installed;
}
