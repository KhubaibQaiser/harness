// The Stop gate's step plan, and the unwrapped runner behind the RunSteps seam.
import type { Exec } from './gate.js';
import type { PreflightPlan } from './preflight.js';

export type PlanStep = { label: string; cmd: string; args: string[]; cwd: string; timeoutMs: number };
// all: run every step and report each, as harness verify needs; the Stop gate stops at the first failure.
export type Plan = { nonce: string; deadlineMs: number; steps: PlanStep[]; preflight?: PreflightPlan; all?: boolean };
export type StepResult = { label: string; status: number | null; timedOut: boolean; ms: number; output: string; start?: number }; // start: now() when the step began
export type StepsRun = { kind: 'ran'; results: StepResult[] } | { kind: 'timeout' } | { kind: 'unavailable'; message: string; reason: string };
export type RunSteps = (steps: PlanStep[], deadline: number, o?: { all?: boolean }) => Promise<StepsRun>; // deadline in the gate's now() units
export type CheckName = 'write canary' | 'read canary' | 'unix socket' | 'network' | 'user namespace';
export type ResultLine =
  | { nonce: string; kind: 'step'; label: string; status: number | null; timedOut: boolean; ms: number; output?: string; start?: number }
  | { nonce: string; kind: 'check'; name: CheckName; ok: boolean; detail?: string };

export const runUnwrapped = (exec: Exec, now: () => number): RunSteps => async (steps, deadline, o) => {
  const results: StepResult[] = [];
  for (const s of steps) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      results.push({ label: s.label, status: null, timedOut: true, ms: 0, output: '' });
      if (o?.all) continue;
      break;
    }
    const t0 = now();
    const r = await exec(s.cmd, s.args, remaining);
    results.push({ label: s.label, status: r.status, timedOut: r.timedOut, ms: now() - t0, output: r.output, start: t0 });
    if (!o?.all && (r.timedOut || r.status !== 0)) break;
  }
  return { kind: 'ran', results };
};
