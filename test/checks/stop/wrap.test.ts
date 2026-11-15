import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { allowWriteMessage } from '../../../src/checks/stop/allow-write.js';
import { defaultExec, type ExecResult } from '../../../src/checks/stop/gate.js';
import { tempRoots } from '../../../src/checks/stop/srt-settings.js';
import { PREFLIGHT_ORDER } from '../../../src/checks/stop/preflight.js';
import { srtMessage, type SrtProbe, type SrtWhy } from '../../../src/checks/stop/srt.js';
import type { PlanStep } from '../../../src/checks/stop/steps.js';
import { type Expected, parseResults, runWrapped, srtArgv, type WrapDeps } from '../../../src/checks/stop/wrap.js';
import { readStopRecord } from '../../../src/checks/stop/record.js';
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
// macOS caps a socket path at 104 bytes and the test temp dir is long, so the canaries go in a short folder.
const short = win ? '' : mkdtempSync(join(realpathSync('/tmp'), 'w-'));
afterAll(() => void (win || (rmSync(base, { recursive: true, force: true }), rmSync(short, { recursive: true, force: true }))));
// srt must sit outside every writable root, and the temp dir is one, so a repo file stands in (a .mjs is a node launch).
const srtJs = fileURLToPath(new URL('../../../build.mjs', import.meta.url));
const node = win ? '' : realpathSync(process.execPath);
const srtBin = fileURLToPath(new URL('../../fixtures/srt', import.meta.url)); // 4 bytes of ELF magic; the fake probe never runs it

const N = 'a'.repeat(32);
const N2 = 'b'.repeat(32);
const STEPS = ['format:check', 'lint', 'typecheck', 'test'];
const steps: PlanStep[] = STEPS.map((label) => ({ label, cmd: 'pnpm', args: ['run', label], cwd: root, timeoutMs: 1000 }));
const line = (label: string, o: Record<string, unknown> = {}, nonce = N) => JSON.stringify({ nonce, kind: 'step', label, status: 0, timedOut: false, ms: 5, ...o });
const check = (name: string, o: Record<string, unknown> = {}, nonce = N) => JSON.stringify({ nonce, kind: 'check', name, ok: true, ...o });
const pre = PREFLIGHT_ORDER(process.platform === 'linux').map((n) => check(n));
const pass = [...pre, ...STEPS.map((l) => line(l))].join('\n') + '\n';
const end = (seal: string, nonce = N) => JSON.stringify({ nonce, kind: 'end', seal });
const settingsAt = (n = N) => join(state, `srt-${n}.json`);
const planAt = (n = N) => join(state, `plan-${n}.json`);

type Call = { cmd: string; args: string[]; ms: number; settings: string; plan: string; input?: string };
const probe = (path: string | null = srtJs, ver = '0.0.83'): SrtProbe => ({ which: () => path, version: () => ver });
// The fake exec reads the seal from stdin like the real runner: the literal SEAL in stdout becomes it, and a sealed end line is appended unless sealed is false.
function setup(script: Partial<ExecResult> | (() => Partial<ExecResult> | Promise<Partial<ExecResult>>) = { stdout: pass }, o: Partial<WrapDeps> = {}, sealed = true) {
  const calls: Call[] = [];
  const nonces = [N, N2];
  const d: WrapDeps = {
    root, stop: defaults().stop, now: () => 0, srt: probe(), home, platform: process.platform, env: { PATH: '/usr/bin:/bin' },
    tokenBase: () => null, node: process.execPath, tmp: short, nonce: () => nonces.shift()!,
    exec: async (cmd, args, ms, input) => {
      const n = args.at(-1)!;
      calls.push({ cmd, args, ms, input, settings: readFileSync(settingsAt(n), 'utf8'), plan: readFileSync(planAt(n), 'utf8') });
      const r = { status: 0, output: '', timedOut: false, stdout: '', stderr: '', ...(typeof script === 'function' ? await script() : script) };
      const seal = (input ?? '').trim();
      if (typeof r.stdout === 'string') r.stdout = r.stdout.replaceAll('SEAL', seal) + (sealed ? `\n${end(seal)}\n` : '');
      return r;
    },
    ...o,
  };
  return { calls, run: () => runWrapped(d)(steps, 1000) };
}
const unavailable = (check: string, first: string) => ({ kind: 'unavailable', message: srtMessage({ kind: 'check', check, first }), reason: check });
const clean = () => (expect(readdirSync(state).filter((f) => /^(srt|plan|canary)-/.test(f))).toEqual([]), expect(readdirSync(short)).toEqual([])); // short holds the read canary and the socket

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
    expect(JSON.parse(calls[0]!.plan)).toEqual({ nonce: N, deadlineMs: 1000, steps, preflight: expect.objectContaining({ linux: process.platform === 'linux' }) });
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
    const fail = [...pre, line('format:check'), line('lint', { status: 1, output: 'boom' })].join('\n');
    for (const s of [{ stdout: fail }, { timedOut: true, status: null }, () => { throw new Error('spawn boom'); }]) {
      await setup(s).run();
      clean();
    }
    expect(await setup(() => { throw new Error('spawn boom'); }).run()).toEqual(unavailable('srt exit', 'spawn boom'));
    expect(await setup({ timedOut: true, status: null }).run()).toEqual({ kind: 'timeout' });
  });

  test('result lines: missing, extra, out of order, a wrong nonce and non-JSON are each rejected as failed its check: result lines', async () => {
    const bad = [
      [...pre, ...STEPS.slice(0, 3).map((l) => line(l))].join('\n'),
      pass + line('test'),
      [...pre, line('lint'), line('format:check'), line('typecheck'), line('test')].join('\n'),
      [...pre, line('format:check'), line('lint', {}, N2), line('typecheck'), line('test')].join('\n'),
      [...pre, line('format:check'), 'not json', line('typecheck'), line('test')].join('\n'),
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

  test('a full set of forged ok lines without the seal is rejected', async () => {
    expect(await setup({ stdout: pass }, {}, false).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
    expect(await setup({ stdout: pass + end('0'.repeat(64)) }, {}, false).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
  });

  test('a wrong seal, a duplicated end line, or an end line that is not last is rejected', async () => {
    const e = end('SEAL');
    for (const stdout of [pass + end('f'.repeat(64)), pass + e + '\n' + e, pass + e + '\n' + line('test'), e + '\n' + pass]) {
      expect(await setup({ stdout }, {}, false).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
    }
    expect(await setup({ stdout: pass + e }, {}, false).run()).toMatchObject({ kind: 'ran' });
  });

  test('the seal is fresh 64-hex on stdin, and is never in the plan, settings, argv or the nonce', async () => {
    const a = setup();
    await a.run();
    await a.run();
    const [x, y] = a.calls;
    for (const c of [x!, y!]) {
      expect(c.input).toMatch(/^[0-9a-f]{64}\n$/);
      const seal = c.input!.trim();
      expect([c.plan, c.settings, ...c.args].some((t) => t.includes(seal))).toBe(false);
    }
    expect(x!.input).not.toBe(y!.input);
  });

  test('non-zero exit gives failed its check: srt exit (<first stderr line>)', async () => {
    expect(await setup({ status: 1, stdout: pass, stderr: 'Error: bad settings\nat x' }).run()).toEqual(unavailable('srt exit', 'Error: bad settings'));
    expect(await setup({ status: null, stdout: pass, stderr: '' }).run()).toEqual(unavailable('srt exit', 'status null'));
  });

  test("any non-proxy srt stderr line fails the preflight; sandbox proxy: lines only reach the step tail", async () => {
    const stderr = 'sandbox proxy: denied registry.npmjs.org:443\n';
    const failOut = [...pre, line('format:check'), line('lint', { status: 1, output: 'npm ERR! network' })].join('\n');
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

  test('canaries are new per run, on denyWrite and denyRead, removed after', async () => {
    const seen: { w: string; r: string; s: string; mode: number; wBody: string; sock: boolean; deny: { w: string[]; r: string[] } }[] = [];
    const script = () => {
      const n = [N, N2][seen.length]!;
      const p = JSON.parse(readFileSync(planAt(n), 'utf8')).preflight;
      const f = JSON.parse(readFileSync(settingsAt(n), 'utf8')).filesystem;
      seen.push({ w: p.writeCanary, r: p.readCanary, s: p.socket, mode: statSync(p.writeCanary).mode & 0o777, wBody: readFileSync(p.writeCanary, 'utf8'), sock: statSync(p.socket).isSocket(), deny: { w: f.denyWrite.map((e: { path: string }) => e.path), r: f.denyRead.map((e: { path: string }) => e.path) } });
      return { stdout: [...pre.map((c) => c), ...STEPS.map((l) => line(l))].join('\n').replaceAll(N, n) };
    };
    const { run } = setup(script);
    await run();
    await run();
    expect(seen).toHaveLength(2);
    for (const c of seen) {
      expect(c.w.startsWith(`${state}/canary-`)).toBe(true);
      expect(c.mode).toBe(0o600);
      expect(c.wBody).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.byteLength(c.s)).toBeLessThan(104);
      expect(c.sock).toBe(true);
      expect(c.deny.w).toContain(c.w);
      expect(c.deny.r).toContain(c.r);
      expect(c.r.startsWith(`${short}/`)).toBe(true);
      for (const f of [c.w, c.r, c.s]) expect(existsSync(f)).toBe(false);
    }
    expect(new Set([seen[0]!.w, seen[1]!.w, seen[0]!.r, seen[1]!.r, seen[0]!.s, seen[1]!.s]).size).toBe(6);
    clean();
  });

  test('a pre-existing canary path fails closed, srt not called, and is left alone', async () => {
    mkdirSync(state, { recursive: true });
    const planted = join(state, `canary-${N}`);
    writeFileSync(planted, 'planted');
    const { calls, run } = setup();
    expect(await run()).toMatchObject({ kind: 'unavailable', reason: 'preflight' });
    expect(calls).toHaveLength(0);
    expect(readFileSync(planted, 'utf8')).toBe('planted');
    rmSync(planted);
    clean();
    const long = setup(undefined, { tmp: join(short, 'x'.repeat(100)) });
    expect(await long.run()).toMatchObject({ kind: 'unavailable', reason: 'preflight' });
    expect(long.calls).toHaveLength(0);
  });

  test('a check line ok:false gives failed its check: <name> (<detail>)', async () => {
    const stdout = [check('write canary', { ok: false, detail: 'wrote to the state canary' })].join('\n');
    expect(await setup({ stdout }).run()).toEqual(unavailable('write canary', 'wrote to the state canary'));
    clean();
  });

  test('outer sees a changed canary or a socket connection and fails it', async () => {
    const plan = (n = N) => JSON.parse(readFileSync(planAt(n), 'utf8')).preflight;
    const ok = { stdout: pass };
    expect(await setup(() => (writeFileSync(plan().writeCanary, 'changed'), ok)).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    expect(await setup(() => (rmSync(plan().writeCanary), ok)).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    const viaSocket = async () => {
      await new Promise<void>((res) => connect(plan().socket).on('close', () => res()).on('error', () => res())); // the server destroys it at once
      return ok;
    };
    expect(await setup(viaSocket).run()).toEqual(unavailable('unix socket', 'seen by the outer runner'));
    clean();
  });

  test('a missing check line is rejected', async () => {
    const steps = STEPS.map((l) => line(l)).join('\n');
    expect(await setup({ stdout: steps }).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
    expect(await setup({ stdout: [...pre.slice(0, -1), ...STEPS.map((l) => line(l))].join('\n') }).run()).toMatchObject({ kind: 'unavailable', reason: 'result lines' });
  });

  test('a breach the outer runner saw blocks on a timeout or a non-zero exit too; a failed check line on timeout blocks', async () => {
    const plan = () => JSON.parse(readFileSync(planAt(), 'utf8')).preflight;
    const touch = () => writeFileSync(plan().writeCanary, 'changed');
    expect(await setup(() => (touch(), { timedOut: true, status: null })).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    expect(await setup(() => (touch(), { status: 1, stderr: 'boom' })).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    const viaSocket = async () => {
      await new Promise<void>((res) => connect(plan().socket).on('close', () => res()).on('error', () => res()));
      return { timedOut: true, status: null };
    };
    expect(await setup(viaSocket).run()).toEqual(unavailable('unix socket', 'seen by the outer runner'));
    const badLine = [check('write canary'), check('read canary', { ok: false, detail: 'read the temp canary' })].join('\n');
    expect(await setup({ timedOut: true, status: null, stdout: badLine }).run()).toEqual(unavailable('read canary', 'read the temp canary'));
    expect(await setup({ timedOut: true, status: null, stdout: check('write canary') + '\nnot json' }).run()).toEqual({ kind: 'timeout' });
    clean();
  });

  test('a canary deleted and recreated, or renamed over, with the same content is seen as changed', async () => {
    const plan = () => JSON.parse(readFileSync(planAt(), 'utf8')).preflight;
    const ok = { stdout: pass };
    const same = (f: string) => readFileSync(f, 'utf8');
    expect(await setup(() => { const f = plan().writeCanary; const b = same(f); rmSync(f); writeFileSync(f, b); return ok; }).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    expect(await setup(() => { const f = plan().writeCanary; writeFileSync(`${f}.x`, same(f)); renameSync(`${f}.x`, f); return ok; }).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    expect(await setup(() => { const f = plan().writeCanary; writeFileSync(`${f}.x`, same(f)); rmSync(f); symlinkSync(`${f}.x`, f); return ok; }).run()).toEqual(unavailable('write canary', 'seen by the outer runner'));
    for (const f of readdirSync(state)) rmSync(join(state, f), { force: true });
    clean();
  });

  test('every failure path removes the write canary, the read canary and the socket', async () => {
    const failLine = [...pre.slice(0, 1).map(() => check('write canary', { ok: false, detail: 'x' }))].join('\n');
    for (const s of [() => { throw new Error('spawn boom'); }, { status: 1, stderr: 'e' }, { timedOut: true, status: null }, { stdout: 'junk' }, { stdout: failLine }]) {
      await setup(s).run();
      clean();
    }
  });

  test('the socket and read canary go in the shortest temp root, and are gone after', async () => {
    const rnd = randomBytes(16).toString('hex');
    let p: { socket: string; readCanary: string } | undefined;
    await setup(() => ((p = JSON.parse(readFileSync(planAt(rnd), 'utf8')).preflight), { stdout: pass.replaceAll(N, rnd) }), { tmp: undefined, nonce: () => rnd }).run();
    const shortest = tempRoots().reduce((a, b) => (Buffer.byteLength(b) < Buffer.byteLength(a) ? b : a));
    expect(p!.socket.startsWith(`${shortest}/h-`)).toBe(true);
    expect(p!.readCanary.startsWith(`${shortest}/h-canary-`)).toBe(true);
    expect([p!.socket, p!.readCanary].filter(existsSync)).toEqual([]);
  });

  test('the timeout scan ignores unknown check names and non-boolean ok, and caps the detail', async () => {
    const t = (o: Record<string, unknown>) => ({ timedOut: true, status: null, stdout: JSON.stringify({ nonce: N, kind: 'check', ...o }) });
    expect(await setup(t({ name: 'evil\u001b[2J', ok: false, detail: 'x' })).run()).toEqual({ kind: 'timeout' });
    expect(await setup(t({ name: 'network', ok: 'no' })).run()).toEqual({ kind: 'timeout' });
    const r = await setup(t({ name: 'network', ok: false, detail: 'y\u001b[2J' + 'z'.repeat(500) })).run();
    expect(r).toMatchObject({ kind: 'unavailable', reason: 'network' });
    expect(r.kind === 'unavailable' && r.message).not.toContain('\u001b');
    expect(r.kind === 'unavailable' && r.message.length).toBeLessThan(900);
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
  const S = 's'.repeat(64);
  const P = (text: string, e: Expected[]) => parseResults(`${text}\n${end(S)}`, N, e, S);
  const l = (label: string, o: Record<string, unknown> = {}) => line(label, o);
  test('names the first bad line', () => {
    expect(P(`${l('a')}\n\n${l('b')}\n`, exp)).toMatchObject({ lines: [{ label: 'a' }, { label: 'b' }] });
    expect(P(l('a', { status: 2 }), exp)).toMatchObject({ lines: [{ label: 'a', status: 2 }] });
    expect(P(l('a', { timedOut: true, status: null }), exp)).toMatchObject({ lines: [{ label: 'a' }] });
    expect(P(l('a'), exp)).toEqual({ error: "line 2: missing (step 'b')" });
    expect(P(`${l('a')}\n${l('b')}\n${l('b')}`, exp)).toEqual({ error: 'line 3: extra' });
    expect(P(`${l('a', { status: 1 })}\n${l('b')}`, exp)).toEqual({ error: 'line 2: extra' });
    expect(P(`${l('b')}\n${l('a')}`, exp)).toEqual({ error: "line 1: out of order (expected step 'a')" });
    expect(P(`${line('a', {}, N2)}`, exp)).toEqual({ error: 'line 1: no nonce' });
    expect(P('x', exp)).toEqual({ error: 'line 1: not JSON' });
    expect(P(`${l('a', { status: '0' })}`, exp)).toEqual({ error: 'line 1: bad fields' });
    const [a, b, e] = [l('a'), l('b'), end(S)];
    expect(parseResults(a + '\n' + b, N, exp, S)).toEqual({ error: 'end line: missing' });
    expect(parseResults(a + '\n' + b + '\n' + end('f'.repeat(64)), N, exp, S)).toEqual({ error: 'end line: wrong seal' });
    expect(parseResults([a, b, e, e].join('\n'), N, exp, S)).toEqual({ error: 'end line: duplicated' });
    expect(parseResults([a, b, e, l('a')].join('\n'), N, exp, S)).toEqual({ error: 'end line: not last' });
    expect(parseResults([e, a, b].join('\n'), N, exp, S)).toEqual({ error: 'end line: not last' });
    const chk: Expected[] = [{ kind: 'check', name: 'network' }, { kind: 'step', label: 'a' }];
    expect(P(JSON.stringify({ nonce: N, kind: 'check', name: 'network', ok: false, detail: 'reached' }), chk)).toMatchObject({ lines: [{ name: 'network', ok: false }] });
  });
});

suite('runWrapped records what it saw', () => {
  const recFile = join(state, 'stop-sandbox.json');
  const rec = () => readStopRecord(root);
  const failNet = (detail: string) => [...PREFLIGHT_ORDER(process.platform === 'linux').slice(0, 3).map((n) => check(n)), check('network', { ok: false, detail })].join('\n') + '\n';

  test('a passing run records ran, srt version and every check ok', async () => {
    rmSync(recFile, { force: true });
    expect((await setup().run()).kind).toBe('ran');
    const names = PREFLIGHT_ORDER(process.platform === 'linux');
    expect(rec()).toMatchObject({ outcome: 'ran', srt: '0.0.83', checks: Object.fromEntries(names.map((n) => [n, 'ok'])) });
    expect(rec()?.reason).toBeUndefined();
  });

  test('an unavailable run records the reported checks, the failing detail and the reason', async () => {
    rmSync(recFile, { force: true });
    expect((await setup({ stdout: failNet('connected out') }).run()).kind).toBe('unavailable');
    expect(rec()).toMatchObject({ outcome: 'unavailable', srt: '0.0.83', reason: 'network', checks: { 'write canary': 'ok', 'read canary': 'ok', 'unix socket': 'ok', network: 'connected out' } });
  });

  test('a check detail is capped so the record always reads back', async () => {
    rmSync(recFile, { force: true });
    await setup({ stdout: failNet('x'.repeat(100000)) }).run();
    expect(rec()?.checks.network).toHaveLength(200);
  });

  test('a timeout leaves the previous record byte for byte', async () => {
    await setup().run();
    const before = readFileSync(recFile, 'utf8');
    expect(await setup({ timedOut: true, status: null }).run()).toEqual({ kind: 'timeout' });
    expect(readFileSync(recFile, 'utf8')).toBe(before);
  });

  test('srt not found records unavailable with srt null', async () => {
    rmSync(recFile, { force: true });
    await setup(undefined, { srt: { which: () => null, version: () => '' } }).run();
    expect(rec()).toMatchObject({ outcome: 'unavailable', srt: null, reason: 'missing', checks: {} });
  });
});
