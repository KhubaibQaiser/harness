import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalKind } from '../eval/build.js';
import { h } from './h.js';
import { section, table } from './html-parts.js';

export interface EvalSummary {
  date: string; model: string; kind: EvalKind;
  cases: { name: string; mean: number; passK: boolean | null; variant?: string; rule?: string }[];
  deltaByRule: Record<string, number | null>; costUsd: number | null;
  /** Total agent runs in the result; 0 when per-run data is missing. */
  runs: number;
}

export const EVALS_DIR = '.harness/reports/evals';
// result.json is untrusted: cap what is read.
const MAX_BYTES = 5_000_000, MAX_CASES = 500, MAX_RUNS = 50, MAX_NAME = 200, MAX_SUMMARIES = 50;
const FOLDER = /^(\d{4}-\d{2}-\d{2})-(.+)-(skills|rules|gates)$/;
const VARIANT = /^(.+)-(rules|bare)$/;
const PERCENT = 100;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

type Case = EvalSummary['cases'][number];
interface Parsed { c: Case; runs: number }

function parseCase(raw: unknown, kind: EvalKind, threshold: number): Parsed | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  const name = raw.name.slice(0, MAX_NAME);
  const arms = isObj(raw.arms) && Array.isArray(raw.arms.with) ? raw.arms.with.slice(0, MAX_RUNS) : [];
  const scores = arms.map((r) => (isObj(r) ? num(r.score) : null));
  const known = scores.length > 0 && scores.every((s) => s !== null);
  const mean = (isObj(raw.aggregates) ? num(raw.aggregates.score) : null) ?? (known ? (scores as number[]).reduce((a, b) => a + b, 0) / scores.length : 0);
  const m = kind === 'rules' ? VARIANT.exec(name) : null;
  const c: Case = { name, mean, passK: known ? (scores as number[]).every((s) => s >= threshold) : null, ...(m && { rule: m[1]!, variant: m[2]! }) };
  return { c, runs: arms.length };
}

function deltas(cases: Case[]): Record<string, number | null> {
  const rate = (rule: string, variant: string): number | null => {
    const xs = cases.filter((c) => c.rule === rule && c.variant === variant);
    return xs.length === 0 || xs.some((c) => c.passK === null) ? null : xs.filter((c) => c.passK).length / xs.length;
  };
  const out: Record<string, number | null> = {};
  for (const rule of new Set(cases.flatMap((c) => (c.rule ? [c.rule] : [])))) {
    const a = rate(rule, 'rules'), b = rate(rule, 'bare');
    out[rule] = a === null || b === null ? null : a - b;
  }
  return out;
}

function readOne(file: string, folder: RegExpExecArray): EvalSummary | null {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    const doc: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(doc) || !Array.isArray(doc.cases)) return null;
    const kind = folder[3] as EvalKind;
    const parsed = doc.cases.slice(0, MAX_CASES).map((c) => parseCase(c, kind, num(doc.threshold) ?? 1));
    const ok = parsed.filter((p): p is Parsed => p !== null);
    const cases = ok.map((p) => p.c);
    return { date: folder[1]!, model: folder[2]!, kind, cases, deltaByRule: deltas(cases), costUsd: num(doc.costUsd), runs: ok.reduce((a, p) => a + p.runs, 0) };
  } catch {
    return null; // unreadable or malformed: skipped, never fatal
  }
}

/** Reads `.harness/reports/evals/<date>-<model>-<kind>/result.json`, oldest first; bad folders and files are skipped. */
export function readEvalResults(root: string): EvalSummary[] {
  const base = join(root, EVALS_DIR);
  if (!existsSync(base)) return [];
  const out: EvalSummary[] = [];
  for (const name of readdirSync(base).sort().slice(-MAX_SUMMARIES)) {
    const m = FOLDER.exec(name);
    const file = join(base, name, 'result.json');
    const s = m && existsSync(file) ? readOne(file, m) : null;
    if (s) out.push(s);
  }
  return out;
}

const pct = (x: number): string => `${Math.round(x * PERCENT)}%`;
/** One table per result; the model is always named, and results on different models are never merged. */
export function evalsSection(evals: EvalSummary[]): string {
  if (evals.length === 0) return section('evals', 'Evals', '<p>No eval results yet. Run <code>harness eval</code> in a terminal.</p>');
  const body = evals.map((e) => {
    const rows = e.cases.map((c) => [c.name, c.variant ?? '', pct(c.mean), c.passK === null ? 'unavailable' : c.passK ? 'yes' : 'no']);
    const delta = Object.entries(e.deltaByRule).map(([r, d]) => `<li>${h(r)}: ${d === null ? 'n/a' : h(`${d >= 0 ? '+' : ''}${Math.round(d * PERCENT)} pts`)}</li>`).join('');
    return `<h3>${h(e.kind)} on ${h(e.model)}, ${h(e.date)}</h3>`
      + `<p>Cost: ${e.costUsd === null ? 'unknown' : h(`$${e.costUsd.toFixed(2)}`)}. pass^k: every run of the case passed.</p>`
      + table(['Case', 'Variant', 'Mean score', 'pass^k'], rows)
      + (delta ? `<h4>pass^k delta, rules minus bare</h4><ul>${delta}</ul>` : '');
  }).join('');
  return section('evals', 'Evals', body);
}
