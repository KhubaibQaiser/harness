import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { Exec } from '../../../src/checks/stop/gate.js';
import { runPlanEntry } from '../../../src/checks/stop/step-runner.js';
import type { Plan, PlanStep } from '../../../src/checks/stop/steps.js';

const N = 'a'.repeat(32);
const ok = { status: 0, output: '', timedOut: false };
const step = (label: string, o: Partial<PlanStep> = {}): PlanStep => ({ label, cmd: label, args: [], cwd: '/r', timeoutMs: 1000, ...o });
const planFile = (p: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'h-sr-')), 'plan.json');
  writeFileSync(f, typeof p === 'string' ? p : JSON.stringify(p));
  return f;
};
const plan = (steps: PlanStep[], o: Partial<Plan> = {}): Plan => ({ nonce: N, deadlineMs: 10_000, steps, ...o });
const run = async (p: unknown, argvNonce = N, exec: Exec = () => ok, now = () => 0) => {
  const lines: string[] = [];
  const code = await runPlanEntry([planFile(p), argvNonce], (l) => lines.push(l), () => exec, now);
  return { code, lines };
};

test('one nonce-tagged line per step, in plan order', async () => {
  const { code, lines } = await run(plan([step('a'), step('b')]));
  expect(code).toBe(0);
  expect(lines.map((l) => JSON.parse(l))).toMatchObject([{ nonce: N, kind: 'step', label: 'a', status: 0, timedOut: false }, { nonce: N, kind: 'step', label: 'b', status: 0 }]);
});

test('stops after the first failing step, whose line has output', async () => {
  const exec: Exec = (cmd) => (cmd === 'a' ? { status: 1, output: 'boom\n', timedOut: false } : ok);
  const { code, lines } = await run(plan([step('a'), step('b')]), N, exec);
  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ label: 'a', status: 1, output: 'boom' });
});

test('each step timeout is clamped to the plan deadline; a spent deadline writes a timedOut line and stops', async () => {
  const seen: number[] = [];
  let t = 0;
  const exec: Exec = (_c, _a, ms) => (seen.push(ms), (t += 600), ok);
  const { lines } = await run(plan([step('a'), step('b'), step('c')], { deadlineMs: 1000 }), N, exec, () => t);
  expect(seen).toEqual([1000, 400]);
  expect(JSON.parse(lines[2]!)).toMatchObject({ label: 'c', status: null, timedOut: true });
  expect(lines).toHaveLength(3);
});

test('a bad plan, a wrong nonce or extra args write nothing and exit 2', async () => {
  const bad: unknown[] = [
    'not json', [], plan([step('a')], { nonce: 'b'.repeat(32) }), plan([step('a')], { nonce: 'A'.repeat(32) }),
    plan([step('a')], { deadlineMs: Infinity }), { ...plan([step('a')]), extra: 1 },
    plan([step('')]), plan([step('a', { cmd: '' })]), plan([step('a', { args: [1 as never] })]), plan([step('a', { cwd: 'rel' })]),
    plan([step('a', { timeoutMs: 0 })]), plan(Array.from({ length: 65 }, (_, i) => step(`s${i}`))), plan('x' as never),
  ];
  for (const p of bad) expect(await run(p), JSON.stringify(p).slice(0, 60)).toEqual({ code: 2, lines: [] });
  expect(await run(plan([step('a')]), 'c'.repeat(32))).toEqual({ code: 2, lines: [] });
  const lines: string[] = [];
  expect(await runPlanEntry([planFile(plan([step('a')])), N, 'x'], (l) => lines.push(l))).toBe(2);
  expect(await runPlanEntry(['/no/such/file', N], (l) => lines.push(l))).toBe(2);
  expect(await runPlanEntry([planFile('x'.repeat(300 * 1024)), N], (l) => lines.push(l))).toBe(2);
  expect(lines).toEqual([]);
});

test('preflight is accepted and ignored', async () => {
  expect((await run(plan([step('a')], { preflight: { any: 1 } }))).code).toBe(0);
});
