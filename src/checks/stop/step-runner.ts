// The step runner behind `dispatch.mjs --stop-steps <plan> <nonce>`: runs inside srt, prints one nonce-tagged JSON line per step.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defaultExec, type Exec, tail } from './gate.js';
import type { Plan, PlanStep, ResultLine } from './steps.js';

const MAX_PLAN = 256 * 1024;
const MAX_STEPS = 64;
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const posNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const validStep = (s: unknown): s is PlanStep => {
  const o = s as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && isStr(o.label) && isStr(o.cmd) && Array.isArray(o.args) && o.args.every((a) => typeof a === 'string') && isStr(o.cwd) && isAbsolute(o.cwd) && posNum(o.timeoutMs);
};

function readPlan(path: string, nonce: string): Plan | null {
  let text: string;
  const fd = openSync(path, 'r');
  try {
    if (fstatSync(fd).size > MAX_PLAN) return null;
    const buf = Buffer.alloc(MAX_PLAN);
    text = buf.toString('utf8', 0, readSync(fd, buf, 0, MAX_PLAN, 0));
  } finally {
    closeSync(fd);
  }
  const p = JSON.parse(text) as Record<string, unknown> | null;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (Object.keys(p).some((k) => !['nonce', 'deadlineMs', 'steps', 'preflight'].includes(k))) return null;
  if (typeof p.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(p.nonce) || p.nonce !== nonce) return null;
  if (typeof p.deadlineMs !== 'number' || !Number.isFinite(p.deadlineMs)) return null;
  if (!Array.isArray(p.steps) || p.steps.length > MAX_STEPS || !p.steps.every(validStep)) return null;
  return p as unknown as Plan;
}

/** Exit 2 and no output for a bad plan; otherwise 0, with the verdict in the lines. */
export async function runPlanEntry(argv: string[], out: (line: string) => void, execFor: (cwd: string) => Exec = defaultExec, now: () => number = Date.now): Promise<number> {
  if (argv.length !== 2) return 2;
  let plan: Plan | null;
  try {
    plan = readPlan(argv[0]!, argv[1]!);
  } catch {
    return 2;
  }
  if (!plan) return 2;
  const emit = (l: Omit<Extract<ResultLine, { kind: 'step' }>, 'nonce' | 'kind'>) => out(JSON.stringify({ nonce: plan.nonce, kind: 'step', ...l }));
  for (const s of plan.steps) {
    const timeout = Math.min(s.timeoutMs, plan.deadlineMs - now());
    if (timeout <= 0) return emit({ label: s.label, status: null, timedOut: true, ms: 0 }), 0;
    const t0 = now();
    const r = await execFor(s.cwd)(s.cmd, s.args, timeout);
    const failed = r.timedOut || r.status !== 0;
    emit({ label: s.label, status: r.status, timedOut: r.timedOut, ms: now() - t0, ...(failed ? { output: tail(r.output) } : {}) });
    if (failed) break;
  }
  return 0;
}
