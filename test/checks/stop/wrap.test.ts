import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { allowWriteMessage } from '../../../src/checks/stop/allow-write.js';
import { defaultExec, type ExecResult } from '../../../src/checks/stop/gate.js';
import { srtMessage, type SrtProbe, type SrtWhy } from '../../../src/checks/stop/srt.js';
import type { PlanStep } from '../../../src/checks/stop/steps.js';
import { type Expected, parseResults, runWrapped, srtArgv, type WrapDeps } from '../../../src/checks/stop/wrap.js';
import { defaults } from '../../../src/core/config.js';

// srt runs on macOS and Linux only (R10); a skipped file never runs its cleanup, so win32 touches no disk.
const win = process.platform === 'win32';
const suite = describe.skipIf(win);

const base = win ? join(tmpdir(), 'unused') : realpathSync(mkdtempSync(join(tmpdir(), 'wrap-')));
const root = join(base, 'repo');
const home = join(base, 'home');
const runner = join(root, '.harness/hooks/dispatch.mjs');
const state = join(root, '.harness/state');
if (!win) for (const d of [join(root, '.harness/hooks'), home]) mkdirSync(d, { recursive: true });
if (!win) writeFileSync(runner, '');
afterAll(() => void (win || rmSync(base, { recursive: true, force: true })));
// srt must sit outside every writable root, and the temp dir is one, so a repo file stands in (a .mjs is a node launch).
const srtJs = fileURLToPath(new URL('../../../build.mjs', import.meta.url));
const node = win ? '' : realpathSync(process.execPath);
const srtBin = fileURLToPath(new URL('../../fixtures/srt', import.meta.url)); // 4 bytes of ELF magic; the fake probe never runs it

const N = 'a'.repeat(32);
const N2 = 'b'.repeat(32);
const STEPS = ['format:check', 'lint', 'typecheck', 'test'];
const steps: PlanStep[] = STEPS.map((label) => ({ label, cmd: 'pnpm', args: ['run', label], cwd: root, timeoutMs: 1000 }));
const line = (label: string, o: Record<string, unknown> = {}, nonce = N) => JSON.stringify({ nonce, kind: 'step', label, status: 0, timedOut: false, ms: 5, ...o });
const pass = STEPS.map((l) => line(l)).join('\n') + '\n';
const settingsAt = (n = N) => join(state, `srt-${n}.json`);
const planAt = (n = N) => join(state, `plan-${n}.json`);

type Call = { cmd: string; args: string[]; ms: number; settings: string; plan: string };
const probe = (path: string | null = srtJs, ver = '0.0.83'): SrtProbe => ({ which: () => path, version: () => ver });
function setup(script: Partial<ExecResult> | (() => Partial<ExecResult> | Promise<Partial<ExecResult>>) = { stdout: pass }, o: Partial<WrapDeps> = {}) {
  const calls: Call[] = [];
  const nonces = [N, N2];
  const d: WrapDeps = {
    root, stop: defaults().stop, now: () => 0, srt: probe(), home, platform: process.platform, env: { PATH: '/usr/bin:/bin' },
    tokenBase: () => null, node: process.execPath, nonce: () => nonces.shift()!,
    exec: async (cmd, args, ms) => {
      const n = args.at(-1)!;
      calls.push({ cmd, args, ms, settings: readFileSync(settingsAt(n), 'utf8'), plan: readFileSync(planAt(n), 'utf8') });
      return { status: 0, output: '', timedOut: false, stdout: '', stderr: '', ...(typeof script === 'function' ? await script() : script) };
    },
    ...o,
  };
  return { calls, run: () => runWrapped(d)(steps, 1000) };
}
const unavailable = (check: string, first: string) => ({ kind: 'unavailable', message: srtMessage({ kind: 'check', check, first }), reason: check });
const clean = () => expect(readdirSync(state).filter((f) => /^(srt|plan)-/.test(f))).toEqual([]);

suite('runWrapped', () => {
  test('argv is exactly the launch prefix, --settings <abs settings>, <node>, <abs runner>, --stop-steps <abs plan>, <nonce>', async () => {
    const { calls, run } = setup();
    await run();
    expect(srtArgv('/s', '/n', '/r', '/p', N)).toEqual(['--settings', '/s', '/n', '--no-warnings', '/r', '--stop-steps', '/p', N]);
    expect([calls[0]!.cmd, ...calls[0]!.args]).toEqual([node, srtJs, '--settings', settingsAt(), node, '--no-warnings', runner, '--stop-steps', planAt(), N]);
    expect(calls[0]!.ms).toBe(1000);
  });

  test('one srt call per run, with four steps; the settings file is on its own denyRead, the plan is not', async () => {
    const { calls, run } = setup();
    expect(await run()).toEqual({ kind: 'ran', results: STEPS.map((label) => ({ label, status: 0, timedOut: false, ms: 5, output: '' })) });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.plan)).toEqual({ nonce: N, deadlineMs: 1000, steps });
    const deny = JSON.parse(calls[0]!.settings).filesystem.denyRead.map((e: { path: string }) => e.path);
    expect(deny).toContain(settingsAt());
    expect(deny).not.toContain(planAt());
  });

  test('settings and plan are written new per run (two runs, two nonces) and deleted after, on pass, fail, timeout and throw', async () => {
    const two = setup();
    await two.run();
    await two.run();
    expect(two.calls.map((c) => c.args.at(-1))).toEqual([N, N2]);
    clean();
    const fail = [line('format:check'), line('lint', { status: 1, output: 'boom' })].join('\n');
    for (const s of [{ stdout: fail }, { timedOut: true, status: null }, () => { throw new Error('spawn boom'); }]) {
      await setup(s).run();
      clean();
    }
    expect(await setup(() => { throw new Error('spawn boom'); }).run()).toEqual(unavailable('srt exit', 'spawn boom'));
    expect(await setup({ timedOut: true, status: null }).run()).toEqual({ kind: 'timeout' });
  });

  test('result lines: missing, extra, out of order, a wrong nonce and non-JSON are each rejected as failed its check: result lines', async () => {
    const bad = [
      STEPS.slice(0, 3).map((l) => line(l)).join('\n'),
      pass + line('test'),
      [line('lint'), line('format:check'), line('typecheck'), line('test')].join('\n'),
      [line('format:check'), line('lint', {}, N2), line('typecheck'), line('test')].join('\n'),
      [line('format:check'), 'not json', line('typecheck'), line('test')].join('\n'),
    ];
    for (const stdout of bad) expect(await setup({ stdout }).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
  });

  test('srt exit 0 with a missing or partial line set is rejected, never a pass', async () => {
    for (const stdout of ['', '\n', line('format:check'), line('format:check') + '\n{"nonce":"' + N]) {
      const r = await setup({ stdout }).run();
      expect(r.kind).toBe('unavailable');
      expect(r).toMatchObject({ reason: 'result lines' });
    }
    expect(await setup({ stdout: undefined }).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
  });

  test('non-zero exit gives failed its check: srt exit (<first stderr line>)', async () => {
    expect(await setup({ status: 1, stdout: pass, stderr: 'Error: bad settings\nat x' }).run()).toEqual(unavailable('srt exit', 'Error: bad settings'));
    expect(await setup({ status: null, stdout: pass, stderr: '' }).run()).toEqual(unavailable('srt exit', 'status null'));
  });

  test("a failing step's output ends with srt's proxy lines, capped at 1024 chars; a stray srt line on any run is a warning", async () => {
    const stderr = 'sandbox proxy: denied registry.npmjs.org:443\n';
    const failOut = [line('format:check'), line('lint', { status: 1, output: 'npm ERR! network' })].join('\n');
    const r = await setup({ stdout: failOut, stderr }).run();
    expect(r).toEqual({ kind: 'ran', results: [{ label: 'format:check', status: 0, timedOut: false, ms: 5, output: '' }, { label: 'lint', status: 1, timedOut: false, ms: 5, output: 'npm ERR! network\nsandbox proxy: denied registry.npmjs.org:443' }] });
    const many = Array.from({ length: 100 }, (_, i) => `sandbox proxy: denied host${i}.example:443${'x'.repeat(i % 7)}`).join('\n');
    const capped = await setup({ stdout: failOut, stderr: many }).run();
    const out = capped.kind === 'ran' ? capped.results[1]!.output : '';
    expect(out.startsWith('npm ERR! network\n')).toBe(true);
    const tail = out.slice('npm ERR! network\n'.length);
    expect(tail.length).toBeLessThanOrEqual(1024);
    expect(tail.split('\n').every((l) => l.startsWith('sandbox proxy: denied host'))).toBe(true); // starts at a line boundary, never mid-line
    expect(out.endsWith(`host99.example:443${'x'.repeat(99 % 7)}`)).toBe(true);
    expect(await setup({ stdout: pass, stderr }).run()).toMatchObject({ kind: 'ran' });
    const warn = stderr + 'warning: seccomp filter not applied\n';
    expect(await setup({ stdout: pass, stderr: warn }).run()).toEqual(unavailable('srt warning', 'warning: seccomp filter not applied'));
    expect(await setup({ stdout: failOut, stderr: warn }).run()).toEqual(unavailable('srt warning', 'warning: seccomp filter not applied'));
  });

  test('a stderr flood that rolls the warning out of the tail is an srt warning, never a pass', async () => {
    // The real defaultExec: a warning, then 70 KiB of proxy lines, so the 64 KiB tail no longer holds the warning.
    const js = "process.stderr.write('warning: seccomp filter not applied\\n' + 'sandbox proxy: denied x.example:443 padding padding padding pad\\n'.repeat(1120))";
    const r = await setup(async () => ({ ...(await defaultExec(base)(process.execPath, ['-e', js], 20_000)), stdout: pass })).run();
    expect(r).toEqual(unavailable('srt warning', 'stderr overflow'));
  });

  test('a deadline already past is a timeout, srt not called', async () => {
    const { calls, run } = setup(undefined, { now: () => 2000 });
    expect(await run()).toEqual({ kind: 'timeout' });
    expect(calls).toHaveLength(0);
    clean();
  });

  test('a failed plan write and a symlinked state folder fail closed as settings file', async () => {
    writeFileSync(planAt(), 'planted');
    const r = await setup().run();
    expect(r).toMatchObject({ kind: 'unavailable', reason: 'settings file' });
    expect(r.kind === 'unavailable' && r.message).toContain('failed its check: settings file (plan: EEXIST');
    rmSync(planAt());
    clean();
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(state, { recursive: true, force: true });
    symlinkSync(elsewhere, state);
    const { calls, run } = setup();
    expect(await run()).toEqual(unavailable('settings file', 'state folder is not a real directory'));
    expect(calls).toHaveLength(0);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(state);
  });

  test('a binary srt still checks the node it runs the step runner with', async () => {
    const inRepo = join(root, 'node');
    writeFileSync(inRepo, '');
    const { calls, run } = setup(undefined, { srt: probe(srtBin), node: inRepo });
    expect(await run()).toEqual({ kind: 'unavailable', message: srtMessage({ kind: 'writable', path: inRepo }), reason: 'writable' });
    expect(calls).toHaveLength(0);
  });

  test('settings file missing or changed before spawn fails closed, srt not called', async () => {
    for (const [tamper, first] of [
      [(f: string) => rmSync(f), 'missing'],
      [(f: string) => writeFileSync(f, '{}'), 'changed'],
      [(f: string) => (writeFileSync(`${f}.x`, 'x'), rmSync(f), symlinkSync(`${f}.x`, f), rmSync(`${f}.x`)), 'not a regular file'],
    ] as const) {
      // now() is read once, after both files are written and just before the check and the spawn.
      const { calls, run } = setup(undefined, { now: () => (existsSync(settingsAt()) && tamper(settingsAt()), 0) });
      expect(await run()).toEqual(unavailable('settings file', first));
      expect(calls).toHaveLength(0);
      clean();
    }
  });

  test('allow_write refused gives the §11.2 message and srt is not called', async () => {
    const { calls, run } = setup(undefined, { stop: { ...defaults().stop, allow_write: [join(base, 'cache'), home] }, srt: { which: () => srtJs, version: () => { throw new Error('version probed'); } } });
    expect(await run()).toEqual({ kind: 'unavailable', message: allowWriteMessage(home, 'it is your home folder'), reason: 'stop.allow_write' });
    expect(calls).toHaveLength(0);
  });

  test('srt missing, inside repo or old gives the §4.4 message', async () => {
    const inRepo = join(root, 'srt.mjs');
    writeFileSync(inRepo, '');
    const cases: [SrtProbe, SrtWhy, string][] = [
      [probe(null), { kind: 'missing' }, 'missing'],
      [probe(inRepo), { kind: 'writable', path: inRepo }, 'writable'],
      [probe(srtJs, '0.0.82'), { kind: 'old', version: '0.0.82' }, 'old'],
    ];
    for (const [srt, why, reason] of cases) {
      const { calls, run } = setup(undefined, { srt });
      expect(await run()).toEqual({ kind: 'unavailable', message: srtMessage(why), reason });
      expect(calls).toHaveLength(0);
    }
  });

  test('a token base that throws, or a hook bundle that is missing or a symlink, fails closed before srt', async () => {
    expect(await setup(undefined, { tokenBase: () => { throw new Error('getconf failed\nx'); } }).run()).toEqual(unavailable('token base', 'getconf failed'));
    rmSync(runner);
    expect(await setup().run()).toMatchObject({ kind: 'unavailable', reason: 'step runner' });
    const target = join(root, '.harness/hooks/real.mjs');
    writeFileSync(target, '');
    symlinkSync(target, runner);
    expect(await setup().run()).toEqual(unavailable('step runner', 'not a regular file'));
    rmSync(runner);
    writeFileSync(runner, '');
  });
});

suite('parseResults', () => {
  const exp: Expected[] = [{ kind: 'step', label: 'a' }, { kind: 'step', label: 'b' }];
  const l = (label: string, o: Record<string, unknown> = {}) => line(label, o);
  test('names the first bad line', () => {
    expect(parseResults(`${l('a')}\n\n${l('b')}\n`, N, exp)).toMatchObject({ lines: [{ label: 'a' }, { label: 'b' }] });
    expect(parseResults(l('a', { status: 2 }), N, exp)).toMatchObject({ lines: [{ label: 'a', status: 2 }] });
    expect(parseResults(l('a', { timedOut: true, status: null }), N, exp)).toMatchObject({ lines: [{ label: 'a' }] });
    expect(parseResults(l('a'), N, exp)).toEqual({ error: "line 2: missing (step 'b')" });
    expect(parseResults(`${l('a')}\n${l('b')}\n${l('b')}`, N, exp)).toEqual({ error: 'line 3: extra' });
    expect(parseResults(`${l('a', { status: 1 })}\n${l('b')}`, N, exp)).toEqual({ error: 'line 2: extra' });
    expect(parseResults(`${l('b')}\n${l('a')}`, N, exp)).toEqual({ error: "line 1: out of order (expected step 'a')" });
    expect(parseResults(`${line('a', {}, N2)}`, N, exp)).toEqual({ error: 'line 1: no nonce' });
    expect(parseResults('x', N, exp)).toEqual({ error: 'line 1: not JSON' });
    expect(parseResults(`${l('a', { status: '0' })}`, N, exp)).toEqual({ error: 'line 1: bad fields' });
    const chk: Expected[] = [{ kind: 'check', name: 'network' }, { kind: 'step', label: 'a' }];
    expect(parseResults(JSON.stringify({ nonce: N, kind: 'check', name: 'network', ok: false, detail: 'reached' }), N, chk)).toMatchObject({ lines: [{ name: 'network', ok: false }] });
  });
});
