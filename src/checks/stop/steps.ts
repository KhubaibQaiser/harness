// The Stop gate's step plan, and the unwrapped runner behind the RunSteps seam.
import type { Exec } from './gate.js';

export type PreflightPlan = unknown; // T11 defines the shape
export type PlanStep = { label: string; cmd: string; args: string[]; cwd: string; timeoutMs: number };
export type Plan = { nonce: string; deadlineMs: number; steps: PlanStep[]; preflight?: PreflightPlan };
export type StepResult = { label: string; status: number | null; timedOut: boolean; ms: number; output: string };
export type StepsRun = { kind: 'ran'; results: StepResult[] } | { kind: 'timeout' } | { kind: 'unavailable'; message: string; reason: string };
export type RunSteps = (steps: PlanStep[], deadline: number) => Promise<StepsRun>; // deadline in the gate's now() units
export type CheckName = 'write canary' | 'read canary' | 'unix socket' | 'network' | 'user namespace'; // T11
export type ResultLine =
  | { nonce: string; kind: 'step'; label: string; status: number | null; timedOut: boolean; ms: number; output?: string }
  | { nonce: string; kind: 'check'; name: CheckName; ok: boolean; detail?: string };

export const runUnwrapped = (exec: Exec, now: () => number): RunSteps => async (steps, deadline) => {
  const results: StepResult[] = [];
  for (const s of steps) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      results.push({ label: s.label, status: null, timedOut: true, ms: 0, output: '' });
      break;
    }
    const t0 = now();
    const r = await exec(s.cmd, s.args, remaining);
    results.push({ label: s.label, status: r.status, timedOut: r.timedOut, ms: now() - t0, output: r.output });
    if (r.timedOut || r.status !== 0) break;
  }
  return { kind: 'ran', results };
};
