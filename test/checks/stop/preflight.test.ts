import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { PREFLIGHT_ORDER, preflight, realProbes, type Probes } from '../../../src/checks/stop/preflight.js';
import { runPlanEntry } from '../../../src/checks/stop/step-runner.js';
import type { ResultLine } from '../../../src/checks/stop/steps.js';

const N = 'a'.repeat(32);
const pf = { writeCanary: '/r/.harness/state/c', readCanary: '/tmp/rc', socket: '/tmp/s.sock', linux: false };
const err = (code?: string, m = 'blocked'): Error => Object.assign(new Error(m), { code });
const boom = (code = 'EPERM') => {
  throw err(code);
};
const fenced = (): Probes => ({ write: () => boom(), read: () => boom(), connect: async () => boom(), https: async () => boom('ENOTFOUND'), bwrap: () => 1 });
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

test.each([
  ['write canary', 'write', 'ENOENT'],
  ['write canary', 'write', 'EISDIR'],
  ['read canary', 'read', 'ENOENT'],
  ['unix socket', 'connect', 'ENOENT'],
  ['unix socket', 'connect', 'ECONNREFUSED'],
  ['network', 'https', 'ETIMEDOUT'],
] as const)('%s: %s probe error %s is not a deny, so it fails with the code', async (name, probe, code) => {
  const over = { [probe]: probe === 'connect' || probe === 'https' ? async () => boom(code) : () => boom(code) } as Partial<Probes>;
  const { ok, lines } = await collect(pf, { ...fenced(), ...over });
  expect(ok).toBe(false);
  expect(lines.at(-1)).toMatchObject({ name, ok: false });
  expect((lines.at(-1) as { detail: string }).detail).toContain(`${code}: `);
});

test('a TypeError fails the check; EROFS and EACCES deny a write; an empty read is a deny', async () => {
  const te = () => {
    throw new TypeError('bug');
  };
  expect((await collect(pf, { ...fenced(), write: te })).lines.at(-1)).toMatchObject({ ok: false, detail: 'bug' });
  expect((await collect(pf, { ...fenced(), write: () => boom('EROFS') })).ok).toBe(true);
  expect((await collect(pf, { ...fenced(), write: () => boom('EACCES') })).ok).toBe(true);
  expect((await collect(pf, { ...fenced(), read: () => '' })).ok).toBe(true);
  expect((await collect(pf, { ...fenced(), https: async () => boom('HARNESS_TIMEOUT') })).ok).toBe(true);
});

test('bwrap null or a thrown spawn error fails; non-zero is ok; user namespace is skipped off linux', async () => {
  expect((await collect({ ...pf, linux: true }, { ...fenced(), bwrap: () => null })).lines.at(-1)).toMatchObject({ ok: false, detail: 'bwrap: no status' });
  expect((await collect({ ...pf, linux: true }, { ...fenced(), bwrap: () => boom('BWRAP') })).ok).toBe(false);
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
  const code = await runPlanEntry([planFile({ nonce: N, deadlineMs: 10_000, steps: [step], ...plan }), N], (l) => lines.push(l), () => exec, () => 0, probes, () => 'c0ffee'.repeat(10) + 'abcd');
  const all = lines.map((l) => JSON.parse(l));
  if (code === 0) expect(all.pop()).toMatchObject({ kind: 'end' }); // sealed end line is last even when a check fails
  return { code, lines: all as ResultLine[] };
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

// Real probes, loopback and temp files only.
const tmp = () => mkdtempSync(join(tmpdir(), 'h-pf-rp-'));
const listen = (s: Server, where: string | number) => new Promise<void>((r) => s.listen(where as never, r));
const unix = test.skipIf(process.platform === 'win32');

test('real read probe: content returns it, an empty file returns ""', () => {
  const f = join(tmp(), 'f');
  writeFileSync(f, 'secret');
  expect(realProbes.read(f)).toBe('secret');
  writeFileSync(f, '');
  expect(realProbes.read(f)).toBe('');
});

unix('real connect probe: a listener leaks, a missing path fails with ENOENT', async () => {
  const sock = join(tmp(), 's');
  const srv = createServer((c) => c.destroy());
  await listen(srv, sock);
  await expect(realProbes.connect(sock)).resolves.toBeUndefined();
  srv.close();
  await expect(realProbes.connect(join(tmp(), 'none'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('real https probe: an accepted but silent TCP connection counts as reached; a closed port is ECONNREFUSED', async () => {
  const socks: Socket[] = [];
  const srv = createServer((c) => socks.push(c));
  await listen(srv, 0);
  const port = (srv.address() as { port: number }).port;
  await expect(realProbes.https(`https://127.0.0.1:${port}`)).resolves.toBeUndefined();
  socks.forEach((c) => c.destroy());
  await new Promise((r) => srv.close(r));
  await expect(realProbes.https(`https://127.0.0.1:${port}`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

test('real bwrap probe with an empty PATH throws instead of passing', () => {
  const p = process.env.PATH;
  process.env.PATH = '';
  try {
    expect(() => realProbes.bwrap()).toThrow(/bwrap: ENOENT/);
  } finally {
    process.env.PATH = p;
  }
});
