import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvalPlugin, EVAL_MODEL, type CaseInfo, type EvalKind } from '../eval/build.js';
import { evalArgs, planLines } from '../eval/run.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { EVALS_DIR, readEvalResults } from '../report/evals.js';
import { insideClaude } from './claude-only.js';
import type { CliEnv } from './index.js';
import type { Prompt } from './prompt.js';

const DEFAULT_RUNS = 3, DEFAULT_MAX_COST = 2, MAX_RUNS = 50;
const HOUR_MS = 3_600_000;
const KINDS: EvalKind[] = ['skills', 'rules'];
const RULE_TOOLS = ['Bash', 'Write', 'Edit'];
const USAGE = 'Usage: harness eval [--kind skills|rules|gates] [--runs N] [--max-cost-usd X] [--model <id>]';
const GATES_MSG = "Gate evals wait for the owner's P0 probe (spec 7.6): whether plugin hooks run in eval sessions is not proven yet. Nothing was run.";

type Env = CliEnv & { prompt: Prompt; exec?: Exec; tmp?: string };
const flag = (a: string[], n: string): string | undefined => { const i = a.indexOf(n); return i === -1 ? undefined : a[i + 1]; };
const safe = (s: string): string => s.replace(/[^\w.-]/g, '_');

function refusal(cli: Env): string | null {
  if (cli.tty === false) return 'harness eval needs a terminal to ask before spending. Run it yourself in a terminal.';
  if (insideClaude(cli.env)) return 'harness eval spends money, so run it yourself in a plain terminal, not inside Claude Code.';
  if (cli.env.CI === 'true' || cli.env.CI === '1') return 'harness eval does not run unattended (CI is set).';
  return null;
}

function lastCostPerRun(root: string, model: string, kinds: EvalKind[]): number | null {
  const last = readEvalResults(root).filter((r) => r.model === model && kinds.includes(r.kind) && r.costUsd !== null && r.runs > 0).pop();
  return last ? last.costUsd! / last.runs : null;
}

interface Build { kind: EvalKind; dir: string; out: string; cases: CaseInfo[] }

function runOne(b: Build, o: { runs: number; model: string; maxCost: number; root: string; date: string }, exec: Exec, out: (s: string) => void): number | 'missing' {
  mkdirSync(b.out, { recursive: true });
  const tools = b.kind === 'rules' ? RULE_TOOLS : [];
  const r = exec('claude', evalArgs(b.dir, { ...o, out: b.out, scaffold: false, tools }), { timeoutMs: HOUR_MS });
  if (r.missing) return 'missing';
  if (!existsSync(join(b.out, 'result.json'))) return out(`${b.kind}: no result (exit ${r.status}). ${r.stderr ?? ''}`.trim()), 1;
  const dest = join(o.root, EVALS_DIR, `${o.date}-${o.model}-${b.kind}`);
  cpSync(b.out, dest, { recursive: true });
  out(`${b.kind}: exit ${r.status}, saved to ${dest}`);
  return r.status === 0 ? 0 : 1;
}

/** `harness eval`: builds the plugin, prints the plan, runs `claude plugin eval` only after an exact `yes`. */
export async function evalCmd(args: string[], cli: Env): Promise<number> {
  const stop = refusal(cli);
  if (stop) return cli.out(stop), 1;
  const kindArg = flag(args, '--kind');
  if (kindArg === 'gates') return cli.out(GATES_MSG), 1;
  if (kindArg !== undefined && !KINDS.includes(kindArg as EvalKind)) return cli.out(USAGE), 2;
  const kinds = kindArg ? [kindArg as EvalKind] : KINDS;
  const runs = Number(flag(args, '--runs') ?? DEFAULT_RUNS);
  const maxCost = Number(flag(args, '--max-cost-usd') ?? DEFAULT_MAX_COST);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS || !(maxCost > 0)) return cli.out(USAGE), 2;
  const model = safe((flag(args, '--model') ?? (await cli.prompt.edit('Agent model for the evals', EVAL_MODEL))).trim());
  if (!model) return cli.out(USAGE), 2;

  const base = cli.tmp ?? mkdtempSync(join(tmpdir(), 'harness-eval-'));
  const builds: Build[] = [];
  try {
    for (const kind of kinds) {
      const b = buildEvalPlugin(cli.root, { kinds: [kind], tmp: join(base, kind), dispatch: '', model });
      builds.push({ kind, dir: b.dir, out: join(base, `${kind}-out`), cases: b.cases });
    }
  } catch (e) {
    return cli.out(`harness eval: ${(e as Error).message}`), 1;
  }
  planLines(builds.flatMap((b) => b.cases), runs, model, maxCost, lastCostPerRun(cli.root, model, kinds)).forEach(cli.out);
  const answer = (await cli.prompt.edit('This spends money. Type yes to run', '')).trim();
  if (answer !== 'yes') return cli.out('Not run. Nothing was spent.'), 1;

  const o = { runs, model, maxCost, root: cli.root, date: new Date().toISOString().slice(0, 10) };
  let code = 0;
  for (const b of builds) {
    const r = runOne(b, o, cli.exec ?? defaultExec, cli.out);
    if (r === 'missing') return cli.out('claude is not on PATH.'), 1;
    code = Math.max(code, r);
  }
  return code;
}
