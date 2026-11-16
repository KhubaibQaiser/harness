import { expect, test } from 'vitest';
import type { Exec } from '../../../src/checks/stop/gate.js';
import { type PlanStep, runUnwrapped } from '../../../src/checks/stop/steps.js';

const step = (label: string): PlanStep => ({ label, cmd: label, args: [label], cwd: '/r', timeoutMs: 1000 });
const ok = { status: 0, output: '', timedOut: false };

test('runUnwrapped: runs in order, each step gets the remaining share, ms from now()', async () => {
  const calls: [string, number][] = [];
  let t = 0;
  const exec: Exec = (cmd, _a, ms) => {
    calls.push([cmd, ms]);
    t += 100;
    return ok;
  };
  const r = await runUnwrapped(exec, () => t)([step('a'), step('b')], 1000);
  expect(calls).toEqual([['a', 1000], ['b', 900]]);
  expect(r).toEqual({ kind: 'ran', results: [{ label: 'a', status: 0, timedOut: false, ms: 100, output: '', start: 0 }, { label: 'b', status: 0, timedOut: false, ms: 100, output: '', start: 100 }] });
});

test('runUnwrapped: stops at the first non-zero step', async () => {
  const seen: string[] = [];
  const exec: Exec = (cmd) => (seen.push(cmd), cmd === 'a' ? { status: 1, output: 'boom', timedOut: false } : ok);
  const r = await runUnwrapped(exec, () => 0)([step('a'), step('b')], 1000);
  expect(seen).toEqual(['a']);
  expect(r).toMatchObject({ kind: 'ran', results: [{ label: 'a', status: 1, output: 'boom' }] });
});

test('runUnwrapped: a spent budget gives one timedOut result and runs nothing', async () => {
  let ran = 0;
  const r = await runUnwrapped(() => (ran++, ok), () => 5000)([step('a'), step('b')], 5000);
  expect(ran).toBe(0);
  expect(r).toEqual({ kind: 'ran', results: [{ label: 'a', status: null, timedOut: true, ms: 0, output: '' }] });
});

test('runUnwrapped: a timed-out step stops the run', async () => {
  const seen: string[] = [];
  const exec: Exec = (cmd) => (seen.push(cmd), { status: null, output: '', timedOut: true });
  const r = await runUnwrapped(exec, () => 0)([step('a'), step('b')], 1000);
  expect(seen).toEqual(['a']);
  expect(r).toMatchObject({ kind: 'ran', results: [{ label: 'a', timedOut: true }] });
});

test('runUnwrapped with all: a failing step does not stop the run, and a spent budget times out each remaining step', async () => {
  let t = 0;
  const exec: Exec = (cmd) => ((t += 100), cmd === 'a' ? { status: 1, output: 'boom', timedOut: false } : ok);
  const r = await runUnwrapped(exec, () => t)([step('a'), step('b'), step('c'), step('d')], 200, { all: true });
  expect(r).toEqual({ kind: 'ran', results: [
    { label: 'a', status: 1, timedOut: false, ms: 100, output: 'boom', start: 0 }, { label: 'b', status: 0, timedOut: false, ms: 100, output: '', start: 100 },
    { label: 'c', status: null, timedOut: true, ms: 0, output: '' }, { label: 'd', status: null, timedOut: true, ms: 0, output: '' },
  ] });
});
