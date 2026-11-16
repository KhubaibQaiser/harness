// The step runner behind `dispatch.mjs --stop-steps <plan> <nonce>`: runs inside srt, prints one nonce-tagged JSON line per step.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { defaultExec, type Exec, tail } from './gate.js';
import { preflight, realProbes, type Probes } from './preflight.js';
import type { Plan, PlanStep, ResultLine } from './steps.js';

const MAX_PLAN = 256 * 1024;
const MAX_SEAL = 128;

/** The seal line from fd 0: up to the first newline or MAX_SEAL bytes, never waiting for EOF (srt may leave stdin open). */
const readSealLine = (): string => {
  const buf = Buffer.alloc(MAX_SEAL);
  let n = 0;
  while (n < MAX_SEAL && !buf.subarray(0, n).includes(10)) {
    const k = readSync(0, buf, n, MAX_SEAL - n, null);
    if (k === 0) break;
    n += k;
  }
  const nl = buf.subarray(0, n).indexOf(10);
  return buf.toString('utf8', 0, nl < 0 ? n : nl + 1);
};
const MAX_STEPS = 64;
const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const posNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const validStep = (s: unknown): s is PlanStep => {
  const o = s as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && isStr(o.label) && isStr(o.cmd) && Array.isArray(o.args) && o.args.every((a) => typeof a === 'string') && isStr(o.cwd) && isAbsolute(o.cwd) && posNum(o.timeoutMs);
};

const validPreflight = (v: unknown) => {
  const o = v as Record<string, unknown> | null;
  const keys = ['writeCanary', 'readCanary', 'socket', 'linux'];
  return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 4 && keys.every((k) => k in o) && ['writeCanary', 'readCanary', 'socket'].every((k) => isStr(o[k]) && isAbsolute(o[k] as string)) && typeof o.linux === 'boolean';
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
  if (Object.keys(p).some((k) => !['nonce', 'deadlineMs', 'steps', 'preflight', 'all'].includes(k))) return null;
  if ('all' in p && typeof p.all !== 'boolean') return null;
  if (typeof p.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(p.nonce) || p.nonce !== nonce) return null;
  if (typeof p.deadlineMs !== 'number' || !Number.isFinite(p.deadlineMs)) return null;
  if (!Array.isArray(p.steps) || p.steps.length > MAX_STEPS || !p.steps.every(validStep)) return null;
  if ('preflight' in p && !validPreflight(p.preflight)) return null;
  return p as unknown as Plan;
}

/** Exit 2 and no output for a bad plan or seal; otherwise 0, with the verdict in the lines and the sealed end line last. */
export async function runPlanEntry(argv: string[], out: (line: string) => void, execFor: (cwd: string) => Exec = defaultExec, now: () => number = Date.now, probes: Probes = realProbes, readSeal: () => string = readSealLine): Promise<number> {
  if (argv.length !== 2) return 2;
  let plan: Plan | null;
  let seal: string;
  try {
    seal = readSeal(); // one bounded line, before the preflight and before any step runs
    plan = readPlan(argv[0]!, argv[1]!);
  } catch {
    return 2;
  }
  if (!plan || !/^[0-9a-f]{64}\n?$/.test(seal)) return 2;
  await runLines(plan, out, execFor, now, probes);
  out(JSON.stringify({ nonce: plan.nonce, kind: 'end', seal: seal.trim() }));
  return 0;
}

async function runLines(plan: Plan, out: (line: string) => void, execFor: (cwd: string) => Exec, now: () => number, probes: Probes): Promise<void> {
  const emit = (l: Omit<Extract<ResultLine, { kind: 'step' }>, 'nonce' | 'kind'>) => out(JSON.stringify({ nonce: plan.nonce, kind: 'step', ...l }));
  if (plan.preflight && !(await preflight(plan.preflight, probes, (l) => out(JSON.stringify(l)), plan.nonce))) return;
  for (const s of plan.steps) {
    const timeout = Math.min(s.timeoutMs, plan.deadlineMs - now());
    if (timeout <= 0) {
      emit({ label: s.label, status: null, timedOut: true, ms: 0 });
      if (plan.all) continue;
      return;
    }
    const t0 = now();
    const r = await execFor(s.cwd)(s.cmd, s.args, timeout);
    const failed = r.timedOut || r.status !== 0;
    emit({ label: s.label, status: r.status, timedOut: r.timedOut, ms: now() - t0, start: t0, ...(failed ? { output: tail(r.output) } : {}) });
    if (failed && !plan.all) break;
  }
}
