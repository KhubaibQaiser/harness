import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvalPlugin, EVAL_MODEL, type CaseInfo, type EvalKind } from '../eval/build.js';
import { evalArgs, planLines } from '../eval/run.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { EVALS_DIR, readEvalResults, type EvalSummary } from '../report/evals.js';
import { insideClaude } from './claude-only.js';
import type { CliEnv } from './index.js';
import type { Prompt } from './prompt.js';

const DEFAULT_RUNS = 3, DEFAULT_MAX_COST = 2, MAX_RUNS = 50, MIN_COST = 0.01, CENTS = 100, USD_DECIMALS = 2;
const EXIT_FAIL = 1, EXIT_USAGE = 2, DATE_LEN = 10;
const HOUR_MS = 3_600_000;
const KINDS: EvalKind[] = ['skills', 'rules'];
const RULE_TOOLS = ['Bash', 'Write', 'Edit'];
// Passed to `claude --model` unchanged, so it allows ids like claude-opus-5[1m]; no leading dash, no spaces.
const MODEL_RX = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;
const USAGE = 'Usage: harness eval [--kind skills|rules|gates] [--runs N] [--max-cost-usd X] [--model <id>]';
const GATES_MSG = "Gate evals wait for the owner's P0 probe (spec 7.6): whether plugin hooks run in eval sessions is not proven yet. Nothing was run.";

type Env = CliEnv & { prompt: Prompt; exec?: Exec; tmp?: string };
interface Opts { kinds: EvalKind[]; runs: number; maxCost: number; model?: string }
interface Build { kind: EvalKind; dir: string; out: string; cases: CaseInfo[] }

const flag = (a: string[], n: string): string | undefined => { const i = a.indexOf(n); return i === -1 ? undefined : a[i + 1]; };
const folderSafe = (s: string): string => s.replace(/[^\w.-]/g, '_');
const cents = (usd: number): number => Math.floor(usd * CENTS) / CENTS;

function refusal(cli: Env): string | null {
  if (cli.tty === false) return 'harness eval needs a terminal to ask before spending. Run it yourself in a terminal.';
  if (insideClaude(cli.env)) return 'harness eval spends money, so run it yourself in a plain terminal, not inside Claude Code.';
  if (cli.env.CI === 'true' || cli.env.CI === '1') return 'harness eval does not run unattended (CI is set).';
  return null;
}

/** Flags to options, or the message and exit code to stop with. */
function parseArgs(args: string[]): Opts | { stop: string; code: number } {
  const kindArg = flag(args, '--kind');
  if (kindArg === 'gates') return { stop: GATES_MSG, code: EXIT_FAIL };
  const runs = Number(flag(args, '--runs') ?? DEFAULT_RUNS);
  const maxCost = Number(flag(args, '--max-cost-usd') ?? DEFAULT_MAX_COST);
  const bad = (kindArg !== undefined && !KINDS.includes(kindArg as EvalKind))
    || !Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS || !Number.isFinite(maxCost) || maxCost < MIN_COST;
  if (bad) return { stop: USAGE, code: EXIT_USAGE };
  return { kinds: kindArg ? [kindArg as EvalKind] : KINDS, runs, maxCost, model: flag(args, '--model') };
}

/** Per-run cost for one kind from its latest full (not partial) result on this model. */
function costPerRun(saved: EvalSummary[], model: string, kind: EvalKind): number | null {
  const last = saved.filter((r) => r.model === model && r.kind === kind && !r.partial && r.costUsd !== null && r.runs > 0).pop();
  return last ? last.costUsd! / last.runs : null;
}

/** One rate for the plan: null unless every selected kind has an earlier result. */
function planRate(saved: EvalSummary[], model: string, builds: Build[], runs: number): number | null {
  let cost = 0, count = 0;
  for (const b of builds) {
    const rate = costPerRun(saved, model, b.kind);
    if (rate === null) return null;
    cost += rate * b.cases.length * runs;
    count += b.cases.length * runs;
  }
  return count === 0 ? null : cost / count;
}

interface RunOpts { runs: number; model: string; maxCost: number; root: string; date: string }

function runOne(b: Build, o: RunOpts, exec: Exec, out: (s: string) => void): { code: number; summary: EvalSummary | null } | 'missing' {
  mkdirSync(b.out, { recursive: true });
  const tools = b.kind === 'rules' ? RULE_TOOLS : [];
  const r = exec('claude', evalArgs(b.dir, { ...o, out: b.out, scaffold: false, tools }), { timeoutMs: HOUR_MS });
  if (r.missing) return 'missing';
  if (!existsSync(join(b.out, 'result.json'))) return out(`${b.kind}: no result (exit ${r.status}). ${r.stderr ?? ''}`.trim()), { code: EXIT_FAIL, summary: null };
  const name = `${o.date}-${folderSafe(o.model)}-${b.kind}`;
  cpSync(b.out, join(o.root, EVALS_DIR, name), { recursive: true });
  out(`${b.kind}: exit ${r.status}, saved to ${join(o.root, EVALS_DIR, name)}`);
  const summary = readEvalResults(o.root).find((s) => `${s.date}-${folderSafe(s.model)}-${s.kind}` === name) ?? null;
  if (!summary) out(`${b.kind}: could not read result.json (malformed or too large); the file was saved as it is.`);
  return { code: r.status === 0 && summary ? 0 : EXIT_FAIL, summary };
}

/** Takes this run's spend off what is left; returns why the next kind must not start, or null. */
function budgetStop(left: { usd: number }, ceiling: number, summary: EvalSummary | null): string | null {
  if (!summary || summary.costUsd === null || summary.runs === 0) return 'could not read the spend of the last run';
  left.usd -= summary.costUsd;
  const oneRun = summary.costUsd / summary.runs;
  return left.usd < oneRun ? `less than one agent run (~$${oneRun.toFixed(USD_DECIMALS)}) is left in the $${ceiling} ceiling` : null;
}

async function runAll(builds: Build[], o: RunOpts, ceiling: number, cli: Env): Promise<number> {
  const exec = cli.exec ?? defaultExec;
  const left = { usd: ceiling };
  let code = 0;
  for (const [i, b] of builds.entries()) {
    const r = runOne(b, { ...o, maxCost: cents(left.usd) }, exec, cli.out);
    if (r === 'missing') return cli.out('claude is not on PATH.'), EXIT_FAIL;
    code = Math.max(code, r.code);
    const next = builds[i + 1];
    const why = next ? budgetStop(left, ceiling, r.summary) : null;
    if (next && why) return cli.out(`${next.kind}: not started: ${why}. Nothing more was spent.`), EXIT_FAIL;
  }
  return code;
}

function buildAll(cli: Env, opts: Opts, model: string, base: string): Build[] {
  return opts.kinds.map((kind) => {
    const b = buildEvalPlugin(cli.root, { kinds: [kind], tmp: join(base, kind), dispatch: '', model });
    return { kind, dir: b.dir, out: join(base, `${kind}-out`), cases: b.cases };
  });
}

/** `harness eval`: builds the plugin, prints the plan, runs `claude plugin eval` only after an exact `yes`. */
export async function evalCmd(args: string[], cli: Env): Promise<number> {
  const stop = refusal(cli);
  if (stop) return cli.out(stop), EXIT_FAIL;
  const opts = parseArgs(args);
  if ('stop' in opts) return cli.out(opts.stop), opts.code;
  const model = (opts.model ?? (await cli.prompt.edit('Agent model for the evals', EVAL_MODEL))).trim();
  if (!MODEL_RX.test(model)) return cli.out(`Not a model id: ${USAGE}`), EXIT_USAGE;

  const base = cli.tmp ?? mkdtempSync(join(tmpdir(), 'harness-eval-'));
  try {
    const builds = buildAll(cli, opts, model, base);
    const rate = planRate(readEvalResults(cli.root), model, builds, opts.runs);
    planLines(builds.flatMap((b) => b.cases), opts.runs, model, opts.maxCost, rate).forEach(cli.out);
    if ((await cli.prompt.edit('This spends money. Type yes to run', '')).trim() !== 'yes') return cli.out('Not run. Nothing was spent.'), EXIT_FAIL;
    const o = { runs: opts.runs, model, maxCost: opts.maxCost, root: cli.root, date: new Date().toISOString().slice(0, DATE_LEN) };
    return await runAll(builds, o, opts.maxCost, cli);
  } catch (e) {
    return cli.out(`harness eval: ${(e as Error).message}`), EXIT_FAIL;
  } finally {
    if (!cli.tmp) rmSync(base, { recursive: true, force: true }); // only the folder this command made
  }
}
