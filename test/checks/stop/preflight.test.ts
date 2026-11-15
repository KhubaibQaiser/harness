import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { PREFLIGHT_ORDER, preflight, realProbes, type Probes } from '../../../src/checks/stop/preflight.js';
import { runPlanEntry } from '../../../src/checks/stop/step-runner.js';
import type { ResultLine } from '../../../src/checks/stop/steps.js';

const N = 'a'.repeat(32);
const pf = { writeCanary: '/r/.harness/state/c', readCanary: '/tmp/rc', socket: '/tmp/s.sock', linux: false };
const boom = () => {
  throw new Error('blocked');
};
const fenced = (): Probes => ({ write: boom, read: boom, connect: async () => boom(), https: async () => boom(), bwrap: () => 1 });
const collect = async (p: typeof pf, probes: Probes) => {
  const lines: ResultLine[] = [];
  const ok = await preflight(p, probes, (l) => lines.push(l), N);
  return { ok, lines };
};

test('order is the four checks, plus user namespace on linux', () => {
  expect(PREFLIGHT_ORDER(false)).toEqual(['write canary', 'read canary', 'unix socket', 'network']);
  expect(PREFLIGHT_ORDER(true)).toEqual(['write canary', 'read canary', 'unix socket', 'network', 'user namespace']);
});

test.each([
  ['write canary', { write: () => undefined }],
  ['read canary', { read: () => 'secret\nmore' }],
  ['unix socket', { connect: async () => undefined }],
  ['network', { https: async () => undefined }],
  ['user namespace', { bwrap: () => 0 }],
] as const)('%s failing on its own emits ok:false and stops', async (name, over) => {
  const linux = name === 'user namespace';
  const { ok, lines } = await collect({ ...pf, linux }, { ...fenced(), ...over });
  const order = PREFLIGHT_ORDER(linux);
  expect(ok).toBe(false);
  expect(lines.map((l) => (l as { name: string }).name)).toEqual(order.slice(0, order.indexOf(name) + 1));
  expect(lines.at(-1)).toMatchObject({ nonce: N, kind: 'check', name, ok: false });
  expect(lines.slice(0, -1).every((l) => (l as { ok: boolean }).ok)).toBe(true);
  expect((lines.at(-1) as { detail: string }).detail.length).toBeLessThanOrEqual(200);
});

test('detail is the first line, escaped and capped', async () => {
  const { lines } = await collect(pf, { ...fenced(), read: () => `‮${'x'.repeat(500)}\nsecond` });
  const d = (lines.at(-1) as { detail: string }).detail;
  expect(d).not.toContain('second');
  expect(d).not.toContain('‮');
  expect(d.length).toBe(200);
});

test('bwrap null or non-zero is ok; user namespace is skipped off linux', async () => {
  expect((await collect({ ...pf, linux: true }, { ...fenced(), bwrap: () => null })).ok).toBe(true);
  const bwrap = vi.fn(() => 0);
  expect((await collect(pf, { ...fenced(), bwrap })).ok).toBe(true);
  expect(bwrap).not.toHaveBeenCalled();
});

const planFile = (p: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'h-pf-')), 'plan.json');
  writeFileSync(f, JSON.stringify(p));
  return f;
};
const step = { label: 'a', cmd: 'a', args: [], cwd: '/r', timeoutMs: 1000 };
const exec = vi.fn(() => ({ status: 0, output: '', timedOut: false }));
const entry = async (plan: Record<string, unknown>, probes: Probes) => {
  const lines: string[] = [];
  const code = await runPlanEntry([planFile({ nonce: N, deadlineMs: 10_000, steps: [step], ...plan }), N], (l) => lines.push(l), () => exec, () => 0, probes);
  return { code, lines: lines.map((l) => JSON.parse(l) as ResultLine) };
};

test('all pass then steps run', async () => {
  exec.mockClear();
  const { code, lines } = await entry({ preflight: pf }, fenced());
  expect(code).toBe(0);
  expect(lines.map((l) => (l.kind === 'check' ? l.name : l.kind))).toEqual(['write canary', 'read canary', 'unix socket', 'network', 'step']);
  expect(exec).toHaveBeenCalledTimes(1);
});

test('a failed check stops before any step', async () => {
  exec.mockClear();
  const { lines } = await entry({ preflight: pf }, { ...fenced(), read: () => 'x' });
  expect(lines.at(-1)).toMatchObject({ kind: 'check', name: 'read canary', ok: false });
  expect(exec).not.toHaveBeenCalled();
});

test('a malformed preflight block exits 2 and writes nothing', async () => {
  for (const bad of [null, [], 'x', {}, { ...pf, extra: 1 }, { ...pf, writeCanary: 'rel' }, { ...pf, socket: '' }, { ...pf, readCanary: 3 }, { ...pf, linux: 'yes' }, { writeCanary: pf.writeCanary, readCanary: pf.readCanary, socket: pf.socket }]) {
    const { code, lines } = await entry({ preflight: bad }, fenced());
    expect([code, lines.length]).toEqual([2, 0]);
  }
});

test('a shim that runs the command unwrapped fails the preflight', async () => {
  const d = mkdtempSync(join(tmpdir(), 'h-pf-real-'));
  const canary = join(d, 'canary');
  writeFileSync(canary, '');
  const https = vi.fn(async () => undefined);
  exec.mockClear();
  const { lines } = await entry({ preflight: { ...pf, writeCanary: canary } }, { ...realProbes, https });
  expect(lines).toMatchObject([{ kind: 'check', name: 'write canary', ok: false }]);
  expect(readFileSync(canary, 'utf8')).toBe('x');
  expect(https).not.toHaveBeenCalled();
  expect(exec).not.toHaveBeenCalled();
});
