import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Exec, runStop, stopGate } from '../../../src/checks/stop/gate.js';
import { loadConfig } from '../../../src/core/config.js';
import { readEvents } from '../../../src/core/events.js';
import { readState, writeState } from '../../../src/core/state.js';
import { type Ctx, detectBaseHead, dispatch, registry } from '../../../src/hooks/dispatch.js';

const ALL = ['format:check', 'lint', 'typecheck', 'test'];
type Opts = { baseHead?: string; scripts?: string[]; yaml?: string; attempts?: number; hookActive?: boolean };
const setup = (o: Opts = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'h-stop-'));
  const scripts = Object.fromEntries((o.scripts ?? ALL).map((s) => [s, 'x']));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts }));
  if (o.yaml) {
    require_mkdir(root);
    writeFileSync(join(root, '.harness/config.yaml'), o.yaml);
  }
  const state = { ...readState(root, 's'), stopAttempts: o.attempts ?? 0, ...(o.baseHead ? { baseHead: o.baseHead } : {}) };
  const saved: number[] = [];
  const ctx = {
    input: { session_id: 's', cwd: root, hook_event_name: 'Stop', ...(o.hookActive === undefined ? {} : { stop_hook_active: o.hookActive }) },
    root, config: loadConfig(root).config, state, unattended: false, env: {},
    save(s) { ctx.state = s; saved.push(s.stopAttempts); },
  } as Ctx;
  const calls: { cmd: string; args: string[]; ms: number }[] = [];
  const exec = (porcelain: string, fail = '', timeout = '', committed = ''): Exec => (cmd, args, ms) => {
    calls.push({ cmd, args, ms });
    if (cmd === 'git') return { status: 0, output: args[0] === 'diff' ? committed : porcelain, timedOut: false };
    if (args[1] === timeout) return { status: null, output: '', timedOut: true };
    return args[1] === fail ? { status: 1, output: `boom in ${fail}`, timedOut: false } : { status: 0, output: '', timedOut: false };
  };
  const steps = () => calls.filter((c) => c.cmd !== 'git').map((c) => c.args[1]);
  return { root, ctx, calls, exec, steps, saved };
};
import { mkdirSync } from 'node:fs';
const require_mkdir = (root: string) => mkdirSync(join(root, '.harness'), { recursive: true });
const SRC = ' M src/a.ts\n';

test('registered last, Stop only, not fail-closed', () => {
  expect(registry.at(-1)).toBe(stopGate);
  expect(stopGate.events).toEqual(['Stop']);
  expect(stopGate.failClosed).toBeFalsy();
});

test('inactive when checks.stop is false', async () => {
  const s = setup({ yaml: 'checks:\n  stop: false\n' });
  const out = await dispatch(JSON.stringify(s.ctx.input), [stopGate], {});
  expect(out).toBe('');
});

test('all steps pass: runs in order via the package manager, allows, resets attempts', () => {
  const s = setup({ attempts: 2 });
  expect(runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.steps()).toEqual(ALL);
  expect(s.calls[1]).toMatchObject({ cmd: 'pnpm', args: ['run', 'format:check'] });
  expect(s.calls[0]).toMatchObject({ cmd: 'git', args: ['status', '--porcelain'] });
  expect(s.saved.at(-1)).toBe(0);
});

test('failing step blocks, stops at first failure, increments attempts, includes output', () => {
  const s = setup();
  const d = runStop(s.ctx, s.exec(SRC, 'lint'));
  expect(d).toMatchObject({ kind: 'block', check: 'stop' });
  expect((d as { reason: string }).reason).toMatch(/^lint failed \(attempt 1 of 3\)\. Fix it, then finish again\.\nboom in lint/);
  expect(s.steps()).toEqual(['format:check', 'lint']);
  expect(s.saved).toEqual([1]);
});

test('output is the last 3500 chars, truncated marker added', () => {
  const s = setup();
  const exec: Exec = (cmd, args) => (cmd === 'git' ? { status: 0, output: SRC, timedOut: false } : { status: 1, output: `HEAD${'x'.repeat(4000)}TAIL\n\n`, timedOut: false });
  const r = (runStop(s.ctx, exec) as { reason: string }).reason;
  expect(r).toContain('…(truncated)\n');
  expect(r.endsWith('TAIL')).toBe(true);
  expect(r).not.toContain('HEAD');
  expect(r.length).toBeLessThan(3700);
});

test('three failures in a row block, the fourth gives up: allow, reset, stop-gave-up event', () => {
  const s = setup();
  const texts: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const d = runStop(s.ctx, s.exec(SRC, 'test'));
    texts.push((d as { reason: string }).reason);
    expect(texts[n - 1]).toMatch(new RegExp(`^test failed \\(attempt ${n} of 3\\)`));
  }
  expect(runStop(s.ctx, s.exec(SRC, 'test'))).toEqual({ kind: 'allow' });
  expect(s.ctx.state.stopAttempts).toBe(0);
  expect(readEvents(s.root).some((e) => e.check === 'stop' && e.decision === 'stop-gave-up')).toBe(true);
});

test('docs-only and clean trees allow, reset attempts, run nothing', () => {
  for (const porcelain of ['?? README.md\n M docs/a.ts\n?? notes.txt\n M LICENSE\n A  guide.mdx\n', '']) {
    const s = setup({ attempts: 2 });
    expect(runStop(s.ctx, s.exec(porcelain))).toEqual({ kind: 'allow' });
    expect(s.steps()).toEqual([]);
    expect(s.ctx.state.stopAttempts).toBe(0);
  }
});

test('rename uses the new path: doc renamed to code is not docs-only; code renamed to doc is', () => {
  const a = setup();
  runStop(a.ctx, a.exec('R  old.md -> src/new.ts\n'));
  expect(a.steps()).toEqual(ALL);
  const b = setup();
  runStop(b.ctx, b.exec('R  src/old.ts -> new.md\n'));
  expect(b.steps()).toEqual([]);
});

test('steps missing from package.json scripts are skipped silently', () => {
  const s = setup({ scripts: ['lint', 'test'] });
  expect(runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.steps()).toEqual(['lint', 'test']);
});

test('config drives steps, package manager and attempts cap', () => {
  const s = setup({ scripts: ['check'], yaml: 'stop:\n  steps: [check]\n  package_manager: npm\n  max_attempts: 1\n' });
  const d = runStop(s.ctx, s.exec(SRC, 'check'));
  expect((d as { reason: string }).reason).toMatch(/^check failed \(attempt 1 of 1\)/);
  expect(s.calls.at(-1)).toMatchObject({ cmd: 'npm', args: ['run', 'check'] });
});

test('each step gets the remaining share of timeout_s (injected clock)', () => {
  const s = setup({ yaml: 'stop:\n  timeout_s: 100\n' });
  let t = 1000;
  const now = () => (t += 10000);
  runStop(s.ctx, s.exec(SRC), now);
  const ms = s.calls.filter((c) => c.cmd !== 'git').map((c) => c.ms);
  expect(ms[0]).toBeGreaterThan(ms[1]);
  expect(ms.every((m) => m > 0 && m <= 100000)).toBe(true);
});

test('timeout from exec: context text, stop-timeout event, attempts unchanged', () => {
  const s = setup({ attempts: 1 });
  const d = runStop(s.ctx, s.exec(SRC, '', 'lint'));
  expect(d).toEqual({ kind: 'context', text: 'Stop gate timed out after 540s; checks did not finish.', check: 'stop' });
  expect(s.saved).toEqual([]);
  expect(s.ctx.state.stopAttempts).toBe(1);
  expect(readEvents(s.root)).toEqual([]); // the dispatcher logs the one `context` event
});

test('timeout when the budget is spent before a step starts', () => {
  const s = setup({ yaml: 'stop:\n  timeout_s: 1\n' });
  let t = 0;
  const d = runStop(s.ctx, s.exec(SRC), () => (t += 5000));
  expect(d.kind).toBe('context');
  expect(s.steps()).toEqual([]);
});

test('timeout is emitted as a Stop systemMessage through the dispatcher', async () => {
  const s = setup();
  const timeoutGate = { ...stopGate, run: (c: Ctx) => runStop(c, s.exec(SRC, '', 'lint')) };
  const out = await dispatch(JSON.stringify(s.ctx.input), [timeoutGate], {});
  expect(JSON.parse(out)).toEqual({ systemMessage: 'Stop gate timed out after 540s; checks did not finish.' });
});

test('stop_hook_active does not bypass the gate', () => {
  const s = setup({ hookActive: true });
  expect(runStop(s.ctx, s.exec(SRC, 'lint')).kind).toBe('block');
});

test('dispatcher logs exactly one event per block, timeout and give-up', async () => {
  const run = async (fail: string, timeout: string, attempts: number) => {
    const s = setup({ attempts });
    writeState(s.root, 's', s.ctx.state); // the dispatcher reads state from disk
    const g = { ...stopGate, run: (c: Ctx) => runStop(c, s.exec(SRC, fail, timeout)) };
    await dispatch(JSON.stringify(s.ctx.input), [g], {});
    return readEvents(s.root).map((e) => `${e.check}/${e.decision}`);
  };
  expect(await run('lint', '', 0)).toEqual(['stop/block']);
  expect(await run('', 'lint', 0)).toEqual(['stop/context']);
  expect(await run('lint', '', 3)).toEqual(['stop/stop-gave-up']);
});

test('failed or timed-out git status fails closed: steps run and stop-diff-failed is logged once', () => {
  for (const bad of [{ status: 128, output: 'fatal', timedOut: false }, { status: null, output: '', timedOut: true }]) {
    for (const baseHead of [undefined, 'abc']) {
      const s = setup({ baseHead });
      const base = s.exec('');
      expect(runStop(s.ctx, (cmd, args, ms) => (cmd === 'git' ? bad : base(cmd, args, ms)))).toEqual({ kind: 'allow' });
      expect(s.steps()).toEqual(ALL);
      expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed', reason: 'git status failed' }]);
    }
  }
});

test('committed code change on a clean tree runs the steps; committed docs only skips; no baseHead = porcelain only', () => {
  const a = setup({ baseHead: 'abc' });
  runStop(a.ctx, a.exec('', '', '', 'src/a.ts\nREADME.md\n'));
  expect(a.steps()).toEqual(ALL);
  expect(a.calls.find((c) => c.args[0] === 'diff')?.args).toEqual(['diff', '--name-only', 'abc', 'HEAD']);
  const b = setup({ baseHead: 'abc' });
  runStop(b.ctx, b.exec('', '', '', 'README.md\ndocs/x.ts\n'));
  expect(b.steps()).toEqual([]);
  const c = setup();
  runStop(c.ctx, c.exec('', '', '', 'src/a.ts\n'));
  expect(c.steps()).toEqual([]);
  expect(c.calls.some((x) => x.args[0] === 'diff')).toBe(false);
});

test('coverage hook point: called after steps pass only when checks.tdd (nothing in tdd.paths allows)', () => {
  const s = setup({ yaml: 'checks:\n  tdd: true\n' });
  expect(runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
});

test('diff failure or timeout fails closed: steps run and stop-diff-failed is logged', () => {
  for (const bad of [{ status: 128, output: 'fatal', timedOut: false }, { status: null, output: '', timedOut: true }]) {
    const s = setup({ baseHead: 'abc' });
    const base = s.exec('');
    runStop(s.ctx, (cmd, args, ms) => (args[0] === 'diff' ? bad : base(cmd, args, ms)));
    expect(s.steps()).toEqual(ALL);
    expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed' }]);
  }
});

test('git calls get a fixed 5 s timeout and do not eat the step budget', () => {
  const s = setup({ baseHead: 'abc', yaml: 'stop:\n  timeout_s: 4\n' });
  let t = 0;
  const base = s.exec('');
  const exec: Exec = (cmd, args, ms) => {
    if (args[0] === 'diff') {
      s.calls.push({ cmd, args, ms });
      t += 5000;
      return { status: null, output: '', timedOut: true };
    }
    return base(cmd, args, ms);
  };
  runStop(s.ctx, exec, () => t);
  expect(s.calls.filter((c) => c.cmd === 'git').map((c) => c.ms)).toEqual([5000, 5000]);
  expect(s.steps()).toEqual(ALL);
  expect(s.calls.find((c) => c.args[1] === 'lint')?.ms).toBe(4000);
  expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed' }]);
});

test('detectBaseHead: HEAD, empty tree only when there are no commits, else undefined', () => {
  const run = (map: Record<string, { status: number | null; stdout: string }>) => (args: string[]) => map[args[0]] ?? { status: 1, stdout: '' };
  expect(detectBaseHead('/x', run({ 'rev-parse': { status: 0, stdout: 'abc\n' } }))).toBe('abc');
  expect(detectBaseHead('/x', run({ 'rev-list': { status: 0, stdout: '' } }))).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  expect(detectBaseHead('/x', run({ 'rev-list': { status: 0, stdout: 'deadbeef\n' } }))).toBeUndefined();
  expect(detectBaseHead('/x', run({ 'rev-list': { status: 128, stdout: '' } }))).toBeUndefined();
  expect(detectBaseHead('/x', run({ 'rev-list': { status: null, stdout: '' } }))).toBeUndefined();
});

test('unborn HEAD: baseHead is the empty tree, and the first commit is diffed (clean porcelain)', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { appendFileSync } = await import('node:fs');
  const first = async (files: string[], ignore: string) => {
    const s = setup();
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: s.root, encoding: 'utf8' });
    git('init', '-q');
    appendFileSync(join(s.root, '.git/info/exclude'), ignore);
    await dispatch(JSON.stringify({ ...s.ctx.input, hook_event_name: 'UserPromptSubmit', prompt: 'x' }), [], {});
    const state = readState(s.root, 's');
    expect(state.baseHead).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    for (const f of files) if (f !== 'package.json') writeFileSync(join(s.root, f), 'export {};\n');
    git('add', ...files);
    git('commit', '-q', '-m', 'first');
    expect(git('status', '--porcelain')).toBe('');
    const ran: string[] = [];
    const exec: Exec = (cmd, args, ms) => {
      if (cmd !== 'git') {
        ran.push(args[1]);
        return { status: 0, output: '', timedOut: false };
      }
      const r = spawnSync(cmd, args, { cwd: s.root, encoding: 'utf8', timeout: ms });
      return { status: r.status, output: r.stdout ?? '', timedOut: false };
    };
    runStop({ ...s.ctx, state } as Ctx, exec);
    return ran;
  };
  expect(await first(['package.json', 'a.ts'], '.harness/\n')).toEqual(ALL);
  expect(await first(['README.md'], '.harness/\npackage.json\n')).toEqual([]);
});
