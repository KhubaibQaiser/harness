import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { esc, overlay } from '../core/config.js';
import { validateConfig } from '../core/config-io.js';
import type { HarnessConfig } from '../core/config.js';
import { answersToConfig, validateAnswers, type Answers } from '../ai/answers.js';
import { validatePicks, type Picks } from '../ai/picks.js';
import { validateProduct } from '../ai/product.js';
import { validateReport } from '../ai/report.js';
import { budgetLines, budgetVerdict, measureSelection } from '../budget/measure.js';
import { CATALOG_BROKEN, loadCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import type { LoadedPreset } from '../catalog/presets.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { claudeVersion as realClaudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { approvedIds } from '../install/approved.js';
import { ApplyError, type FsLike, ManifestError, applyChanges, readManifest } from '../install/apply.js';
import { type Facts } from '../install/detect.js';
import { pinnedPlugins } from '../install/merge.js';
import { dirtyPaths } from '../install/git-status.js';
import { installPlugins } from '../install/plugin-install.js';
import { notPicked, resolveSelection, toSelected } from '../install/select.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL, rehashManifest, settingsOnlyPluginEdits } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { planChanges } from '../install/plan.js';
import { coverageSkipped, coverageWhy, preset, unsafeWhy } from '../install/preset.js';
import { findOnPath } from '../checks/stop/runner.js';
import { hasAiFlags, refuseOutsideClaude } from './claude-only.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { splitPreset, type PresetChoice } from './preset-inputs.js';
import { gitRoot } from '../core/repo-root.js';
import type { CliEnv } from './index.js';

export type { Prompt };
export { planChanges };

export type InitEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; nodeVersion?: string; exec?: Exec; fs?: FsLike; claudeVersion?: () => string | null };

export const AI_USAGE = '[--answers <file> --product <file> --picks <file> --report <file> --choose <id,...>] [--install-plugins] [--over-budget]';
const USAGE = `Usage: /harness:init [--yes] [--dry-run] [--config <file>] ${AI_USAGE}`;
const GATES: Record<string, string> = { guard: 'guard', protect: 'protect', depVerify: 'dep-verify', multiFile: 'multi-file', tdd: 'TDD', stop: 'stop', prSize: 'PR size' };

const at = (o: any, path: string): unknown => path.split('.').reduce((v, k) => v?.[k], o);

export interface AiArgs { answers?: string; product?: string; picks?: string; report?: string; choose?: string; installPlugins: boolean; overBudget: boolean }
const VALUE_FLAGS = ['answers', 'product', 'picks', 'report', 'choose'] as const;

/** Splits the AI flags off `args`; null when a value flag has no value. */
export function takeAiFlags(args: string[]): { ai: AiArgs; rest: string[] } | null {
  const ai: AiArgs = { installPlugins: false, overBudget: false };
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const k = VALUE_FLAGS.find((f) => args[i] === `--${f}`);
    if (k) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) return null;
      ai[k] = args[++i];
    } else if (args[i] === '--install-plugins') ai.installPlugins = true;
    else if (args[i] === '--over-budget') ai.overBudget = true;
    else rest.push(args[i]);
  }
  return { ai, rest };
}

/** The usage error for the first AI input that is missing (all of them are needed together), or null. */
export const missingAi = (cmd: string, ai: AiArgs): string | null => {
  const f = VALUE_FLAGS.find((k) => ai[k] === undefined && !(cmd === 'update' && k === 'answers')); // update merges a partial answers file
  return f ? `${cmd}: --${f} ${f === 'choose' ? '<id,...>' : '<file>'} is required inside Claude Code` : null;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lays a partial answers file over the existing answers; `project`, `unattended` and `tdd` merge one level deep. */
export function overlayAnswers(base: Record<string, unknown>, part: Record<string, unknown>): Record<string, unknown> {
  const m: Record<string, unknown> = { ...base, ...part };
  for (const k of ['project', 'unattended', 'tdd']) if (isObj(part[k])) m[k] = { ...(isObj(base[k]) ? base[k] : {}), ...part[k] };
  return m;
}

export interface AiInputs { answers: Answers; picks: Picks; ids: string[]; notices: string[]; files: { picks: string; report: string; product: string }; catalog: Catalog; presetItems: string[]; preset?: LoadedPreset; reasons: Record<string, string> }

/** Reads and validates the AI step's files against the facts and the real catalog, then resolves --choose. */
export function loadAiInputs(ai: AiArgs, facts: Facts, claudeVer: string | null, base?: Record<string, unknown>): { ok: true; in: AiInputs } | { ok: false; errors: string[]; code: number } {
  const cat = loadCatalog();
  if (cat.errors.length) return { ok: false, errors: [...cat.errors, CATALOG_BROKEN], code: 1 };
  const text: Record<string, string> = {};
  for (const k of ['answers', 'product', 'picks', 'report'] as const) {
    if (k === 'answers' && base && ai.answers === undefined) { text.answers = '{}'; continue; }
    try {
      text[k] = readFileSync(ai[k]!, 'utf8');
    } catch (e) {
      return { ok: false, errors: [`Could not read --${k} "${esc(ai[k]!)}" (${(e as NodeJS.ErrnoException).code ?? 'unreadable'}).`], code: 2 };
    }
  }
  const parsed = (k: 'answers' | 'picks'): { v: unknown } | { err: string } => {
    try {
      return { v: JSON.parse(text[k]) };
    } catch (e) {
      return { err: `${k}: not valid JSON (${esc((e as Error).message.split('\n')[0])})` };
    }
  };
  const pa = parsed('answers');
  if ('err' in pa) return { ok: false, errors: [pa.err], code: 2 };
  // update: the file holds only the re-asked keys; they go over the existing answers, then the full set is validated.
  const merged = base && isObj(pa.v) ? overlayAnswers(base, pa.v) : pa.v;
  const a = validateAnswers(merged, facts);
  if (!a.ok) return { ok: false, errors: a.errors, code: 2 };
  const pp = parsed('picks');
  if ('err' in pp) return { ok: false, errors: [pp.err], code: 2 };
  const p = validatePicks(pp.v, cat.catalog, a.answers);
  if (!p.ok) return { ok: false, errors: p.errors, code: 2 };
  const errors = [...validateProduct(text.product), ...validateReport(text.report, p.picks)];
  if (errors.length) return { ok: false, errors, code: 2 };
  let chosen = ai.choose!.split(',').filter(Boolean);
  let pc: PresetChoice | undefined;
  if (a.answers.preset) {
    const s = splitPreset(a.answers.preset, facts, a.answers.project.type, chosen);
    if (!s.ok) return { ok: false, errors: s.errors, code: 2 };
    pc = s.choice;
    chosen = pc.rest;
  }
  const np = notPicked(chosen, p.picks, cat.catalog, Object.keys(pc?.reasons ?? {}));
  if (np.length) return { ok: false, errors: np, code: 2 };
  const r = resolveSelection(chosen, cat.catalog, claudeVer);
  if (r.errors.length) return { ok: false, errors: r.errors, code: 2 };
  // The report is passed as written: planChanges adds the enforcement sentence when it writes .harness/report.md.
  return { ok: true, in: { answers: a.answers, picks: p.picks, ids: r.ids, notices: r.notices, files: { picks: text.picks, report: text.report, product: text.product }, catalog: cat.catalog, presetItems: pc?.items ?? [], preset: pc?.loaded, reasons: pc?.reasons ?? {} } };
}

/**
 * Prints the budget lines. Returns 2 when the install must stop (over budget, --yes, no --over-budget), else null.
 * `exempt` holds the ids the person already approved: they show but do not count.
 */
export async function budgetGate(
  cat: Catalog, before: string[], after: string[], exempt: string[], budget: number, templatesDir: string, out: (s: string) => void, f: { yes: boolean; dryRun: boolean; overBudget: boolean },
): Promise<number | null> {
  const dirs = { templates: templatesDir, plugin: dirname(packageDir('templates')) };
  const v = budgetVerdict(await measureSelection(before, cat, dirs, { exempt }), await measureSelection(after, cat, dirs, { exempt }), budget);
  for (const l of budgetLines(v)) out(l);
  if (!v.ask || f.dryRun || f.overBudget || !f.yes) return null;
  out(`This goes over the context budget (~${v.after.tokens} of ${budget} tokens, estimate). Run again with --over-budget to accept, or pick fewer items.`);
  return 2;
}

/** The person's own command line, for a step Claude Code's sandbox blocks. */
export function sandboxLine(cmd: 'init' | 'update' | 'git' | 'add' | 'remove' | 'sync', args: string[]): string {
  return `Claude Code's sandbox blocks harness's own files. ${ownCommand(cmd, args)}`;
}
/** The person's own command line, with the `!` prefix hint. */
export function ownCommand(cmd: string, args: string[]): string {
  const self = process.argv[1] ? `node "${resolve(process.argv[1])}"` : 'npx @khubaibqaiser/harness';
  return `Run this yourself with Claude Code's \`!\` prefix: ${self} ${cmd} ${args.map(shq).join(' ')}`;
}
/** One shell word: bare when plain, else single-quoted (embedded quotes the POSIX way); control characters are escaped first so they never reach the terminal. */
export const shq = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${(/[\u0000-\u001f\u007f-\u009f]/.test(a) ? esc(a) : a).replace(/'/g, `'\\''`)}'`);
export const isDenied = (e: unknown): boolean => ['EPERM', 'EACCES'].includes((((e as Error)?.cause ?? e) as NodeJS.ErrnoException)?.code ?? '');
/** Installs the selected pinned plugins, prints one line each, and re-hashes settings. Returns 1 when any install or the re-hash failed. `applied`: the files were written in this run. */
export function installSelected(root: string, chosen: string[], cat: Catalog, exec: Exec, out: (s: string) => void, applied = true, have: string[] = []): number {
  const all = pinnedPlugins(cat.items.filter((i) => chosen.includes(i.id))).map((p) => `${p.name}@harness-pins`);
  const ids = all.filter((id) => !have.includes(id));
  if (!ids.length) return 0;
  const r = installPlugins(ids, exec);
  for (const id of r.ok) out(`Installed plugin ${id}`);
  if (r.failed.length) out(`${applied ? 'Files applied; ' : ''}${r.failed.length} plugin(s) not installed.`);
  for (const f of r.failed) out(`Could not install ${f.id}: ${f.message}\n  Run this yourself with Claude Code's \`!\` prefix: claude plugin install ${shq(f.id)} --scope project`);
  if (r.failed.length) out('Then run /harness:sync to record the install.');
  try {
    if (r.ok.length) {
      if (settingsOnlyPluginEdits(root, all)) rehashManifest(root, ['.claude/settings.json']);
      else out('settings.json has other edits; not recorded. Run /harness:update to review them.');
    }
  } catch (e) {
    if (!(e instanceof ApplyError)) throw e;
    out(`${isDenied(e) ? "Claude Code's sandbox blocks harness's own files. " : ''}The install worked but harness could not record it (${e.message}). Run /harness:sync to record the install.`);
    return 1;
  }
  return r.failed.length ? 1 : 0;
}

function parseArgs(args: string[]): { yes: boolean; dryRun: boolean; config?: string } | null {
  const o: { yes: boolean; dryRun: boolean; config?: string } = { yes: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') o.yes = true;
    else if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--config' && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) o.config = args[++i];
    else return null;
  }
  return o;
}

export async function init(args: string[], cli: InitEnv): Promise<number> {
  const { out, prompt } = cli;
  const taken = takeAiFlags(args);
  const opts = taken && parseArgs(taken.rest);
  if (!taken || !opts) return out(USAGE), 2;
  const ai = taken.ai;
  const aiPath = hasAiFlags(args);
  const refused = refuseOutsideClaude('init', cli.env, aiPath);
  if (refused) return out(refused), 2;
  if (!aiPath && (ai.installPlugins || ai.overBudget)) return out(USAGE), 2;
  const lacking = aiPath ? missingAi('init', ai) : null;
  if (lacking) return out(lacking), 2;
  if (!opts.yes && !opts.dryRun && cli.tty === false) return out(NO_TTY), 2;

  // 1. Preflight
  const root = gitRoot(cli.root);
  if (!root) return out('Not a git repository. Run /harness:init inside a git repo.'), 1;
  out(`Installing at the repo root: ${resolve(root)}`);
  const node = cli.nodeVersion ?? process.versions.node;
  const [major, minor] = node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 11)) return out(`Node ${node} is too old. Harness needs Node 22.11 or newer.`), 1;
  try {
    if (readManifest(root)) return out('Harness is already installed (.harness/manifest.json). Run /harness:update instead.'), 1;
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }

  // 2. Detect and preset
  const facts = detect(root);
  const p = preset(facts, (cmd) => findOnPath(cmd, cli.env, process.platform));
  let config: HarnessConfig = p.config;
  for (const w of facts.warnings) out(`Warning: ${w}`);
  if (opts.config) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(opts.config, 'utf8'));
    } catch (e) {
      return out(`Could not read ${opts.config}: ${(e as Error).message}`), 2;
    }
    const v = validateConfig(raw);
    if (!v.ok) return v.errors.forEach((m) => out(m)), 2;
    // Overlay onto the preset so a partial file keeps the detected values; the merged result is validated again.
    const merged = structuredClone(p.config);
    overlay(merged as unknown as Record<string, unknown>, raw as Record<string, unknown>, '', []);
    const v2 = validateConfig(merged);
    if (!v2.ok) return v2.errors.forEach((m) => out(m)), 2;
    config = v2.config;
    out(`Using the answers in ${opts.config}.`);
  } else if (!aiPath) {
    out('Recommended settings:');
    for (const [k, why] of Object.entries(p.reasons)) out(`  ${k} = ${JSON.stringify(at(config, k))}\n    ${why}`);
    if (p.off.length) out('Off for this repo:\n' + p.off.map((o) => `  ${o.gate}: ${o.why}`).join('\n'));
    if (p.skippedSteps.length) out('Stop steps left out:\n' + p.skippedSteps.map((s) => `  ${s.name}: ${s.why}. Install it, then add the step to stop.steps.`).join('\n'));
    if (!opts.yes && !opts.dryRun && (await prompt.confirm('Edit any value? (y/N)'))) {
      const next: Record<string, unknown> = { ...config };
      for (const k of Object.keys(config).filter((k) => k !== 'version')) {
        const cur = JSON.stringify((config as any)[k]);
        const ans = await prompt.edit(k, cur);
        if (ans === cur) continue;
        try {
          next[k] = parseYaml(ans);
        } catch (e) {
          return out(`${k}: not valid JSON or YAML: ${(e as Error).message}`), 2;
        }
      }
      const v = validateConfig(next);
      if (!v.ok) return v.errors.forEach((m) => out(m)), 2;
      config = v.config;
    }
  }

  // The AI step's files: validated, then they set the answers and the selection.
  let sel: AiInputs | null = null;
  if (aiPath) {
    const r = loadAiInputs(ai, facts, (cli.claudeVersion ?? realClaudeVersion)());
    if (!r.ok) return r.errors.forEach((m) => out(m)), r.code;
    sel = r.in;
    for (const n of sel.notices) out(n);
    config = { ...answersToConfig(config, sel.answers), items: toSelected(sel.picks, sel.ids, sel.catalog, sel.reasons), catalog_version: sel.catalog.version };
    if (sel.preset) config.preset = { id: sel.preset.preset.id, version: cli.version, items: sel.presetItems, git: sel.preset.preset.git };
  }

  // 3. Build the changes
  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, config, facts, { version: cli.version, distDir: cli.distDir, templatesDir: cli.templatesDir, ...(sel ? { catalog: sel.catalog, ai: sel.files, preset: sel.preset } : {}) });
  } catch (e) {
    return out(`Cannot build the install plan: ${(e as Error).message}`), 1;
  }
  const dirty = dirtyPaths(root);
  const touched = plan.changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  if (touched.length && !opts.dryRun) return out(`Commit or stash these files first, so the install can be undone cleanly: ${touched.join(', ')}.`), 1;

  // 4. Plan
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
    const stop = await budgetGate(sel.catalog, [], sel.ids, approvedIds(config, null, sel.catalog), config.context.budget_tokens, cli.templatesDir, out, { ...opts, overBudget: ai.overBudget });
    if (stop !== null) return stop;
  }
  if (opts.dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!opts.yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  // 5. Apply
  try {
    applyChanges(root, plan.changes, cli.version, undefined, cli.fs, { tddOff: p.tddOff.map((o) => o.dir) });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine('init', args) : e.message), 1;
    throw e;
  }
  stampHarnessFiles(root); // change detection: these writes are harness's own
  const installed = sel && ai.installPlugins ? installSelected(root, sel.ids, sel.catalog, cli.exec ?? defaultExec, out) : 0;

  // 6. Report
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
  return installed;
}
