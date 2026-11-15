import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { buildSync } from 'esbuild';
import { expect, test } from 'vitest';
import { defaultExec } from '../../../src/checks/stop/gate.js';
import { parseResults } from '../../../src/checks/stop/wrap.js';
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
const SEAL = 'c0ffee'.repeat(10) + 'abcd';
// run() splits off the sealed end line (checked here), so tests see only check and step lines.
const run = async (p: unknown, argvNonce = N, exec: Exec = () => ok, now = () => 0, seal: () => string = () => SEAL + '\n') => {
  const lines: string[] = [];
  const code = await runPlanEntry([planFile(p), argvNonce], (l) => lines.push(l), () => exec, now, undefined, seal);
  if (code === 0) expect(JSON.parse(lines.pop()!)).toEqual({ nonce: N, kind: 'end', seal: SEAL });
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
  expect(await runPlanEntry([planFile(plan([step('a')])), N, 'x'], (l) => lines.push(l), undefined, undefined, undefined, () => SEAL)).toBe(2);
  expect(await runPlanEntry(['/no/such/file', N], (l) => lines.push(l), undefined, undefined, undefined, () => SEAL)).toBe(2);
  expect(await runPlanEntry([planFile('x'.repeat(300 * 1024)), N], (l) => lines.push(l), undefined, undefined, undefined, () => SEAL)).toBe(2);
  expect(lines).toEqual([]);
});


test('the runner reads the seal from stdin before any step and steps get no stdin', async () => {
  const order: string[] = [];
  const exec: Exec = () => (order.push('step'), ok);
  await run(plan([step('a')]), N, exec, () => 0, () => (order.push('seal'), SEAL));
  expect(order).toEqual(['seal', 'step']);
  // a real step that tries to read stdin sees EOF at once, and the seal is nowhere in its output
  const lines: string[] = [];
  const reader = step('r', { cmd: process.execPath, args: ['-e', "let n=0;process.stdin.on('data',d=>n+=d.length).on('end',()=>{console.log('stdin='+n);process.exit(1)})"], cwd: tmpdir() });
  await runPlanEntry([planFile(plan([reader])), N], (l) => lines.push(l), undefined, () => 0, undefined, () => SEAL);
  expect(JSON.parse(lines[0]!)).toMatchObject({ label: 'r', status: 1, output: 'stdin=0' });
  expect(lines.slice(0, -1).join('')).not.toContain(SEAL);
  expect(lines).toHaveLength(2);
});

test('a bad seal on stdin exits 2 and writes nothing', async () => {
  const bad = ['', '\n', 'abc\n', SEAL.toUpperCase() + '\n', SEAL + '\n' + SEAL + '\n', SEAL + '0\n', ' ' + SEAL, SEAL.slice(1) + 'g\n'];
  for (const b of bad) expect(await run(plan([step('a')]), N, () => ok, () => 0, () => b), JSON.stringify(b)).toEqual({ code: 2, lines: [] });
  expect(await run(plan([step('a')]), N, () => ok, () => 0, () => { throw new Error('no stdin'); })).toEqual({ code: 2, lines: [] });
});

test('a failing step still ends with the sealed end line', async () => {
  const lines: string[] = [];
  await runPlanEntry([planFile(plan([step('a')])), N], (l) => lines.push(l), () => () => ({ status: 1, output: 'x', timedOut: false }), () => 0, undefined, () => SEAL);
  expect(lines.map((l) => JSON.parse(l).kind)).toEqual(['step', 'end']);
});

// The real fd-0 reader, bundled into a runnable entry.
const entryFile = (d: string) => {
  const entry = join(d, 'entry.ts');
  writeFileSync(entry, `import { runPlanEntry } from ${JSON.stringify(join(process.cwd(), 'src/checks/stop/step-runner.ts'))};\nrunPlanEntry(process.argv.slice(2), (l) => process.stdout.write(l + '\\n')).then((c) => (process.exitCode = c));`);
  const out = join(d, 'entry.cjs');
  buildSync({ entryPoints: [entry], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  return out;
};

test.skipIf(process.platform === 'win32')('the real fd-0 reader: a runner spawned with the seal on stdin ends with the sealed line; without input it exits 2', async () => {
  const d = mkdtempSync(join(tmpdir(), 'h-sr-e-'));
  const out = entryFile(d);
  const reader = step('r', { cmd: process.execPath, args: ['-e', "let n=0;process.stdin.on('data',d=>n+=d.length).on('end',()=>{console.log('stdin='+n);process.exit(1)})"], cwd: d, timeoutMs: 5000 });
  const f = planFile(plan([reader], { deadlineMs: Date.now() + 60_000 }));
  const r = await defaultExec(d)(process.execPath, [out, f, N], 20_000, SEAL + '\n');
  expect(r.status).toBe(0);
  expect(r.stdout!.trim().split('\n').at(-1)).toBe(JSON.stringify({ nonce: N, kind: 'end', seal: SEAL }));
  expect(r.stdout!.match(new RegExp(SEAL, 'g'))).toHaveLength(1);
  expect(JSON.parse(r.stdout!.split('\n')[0]!)).toMatchObject({ label: 'r', output: 'stdin=0' });
  expect(parseResults(r.stdout!, N, [{ kind: 'step', label: 'r' }], SEAL)).toMatchObject({ lines: [{ label: 'r' }] });
  const none = await defaultExec(d)(process.execPath, [out, f, N], 20_000);
  expect([none.status, none.stdout]).toEqual([2, '']);
});

test.skipIf(process.platform === 'win32')('the seal is one bounded line: read to the first newline or 128 bytes, never waiting for EOF', async () => {
  const d = mkdtempSync(join(tmpdir(), 'h-sr-b-'));
  const out = entryFile(d);
  const f = planFile(plan([step('a', { cmd: process.execPath, args: ['-e', ''], cwd: d })], { deadlineMs: Date.now() + 60_000 }));
  // stdin stays open (no EOF), as when srt does not forward the close.
  const open = (input: string) => new Promise<{ code: number | null; stdout: string }>((res) => {
    const c = spawn(process.execPath, [out, f, N], { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const t = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.stdout.on('data', (b) => (stdout += b));
    c.on('close', (code) => (clearTimeout(t), c.stdin.destroy(), res({ code, stdout })));
    c.stdin.write(input);
  });
  const good = await open(SEAL + '\n');
  expect(good.code).toBe(0);
  expect(good.stdout.trim().split('\n').at(-1)).toBe(JSON.stringify({ nonce: N, kind: 'end', seal: SEAL }));
  for (const bad of ['f'.repeat(200), 'abc\n', SEAL.slice(0, 63) + 'g\n']) expect(await open(bad), bad.slice(0, 10)).toEqual({ code: 2, stdout: '' });
}, 30000);
