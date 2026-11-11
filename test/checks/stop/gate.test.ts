import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { defaultExec, type Exec, killTree, runStop as runStopReal, stopGate } from '../../../src/checks/stop/gate.js';
import { loadConfig } from '../../../src/core/config.js';
import { readEvents } from '../../../src/core/events.js';
import { readTiming } from '../../../src/core/timing.js';
import { readState, writeState } from '../../../src/core/state.js';
import { decisionSignals } from '../../../src/checks/decisions-stop.js';
import { decision, writeDecision } from '../../core/decisions-helpers.js';
import { type Ctx, detectBaseHead, dispatch, registry } from '../../../src/hooks/dispatch.js';

// Existing tests fake the exec; pretend every binary is on PATH (found as itself: on Windows the gate execs the found path).
const runStop = (c: Ctx, e: Exec, now?: () => number) => runStopReal(c, e, now, (cmd) => cmd);
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
    if (cmd === 'git') return { status: 0, output: args.includes('diff') ? committed : porcelain, timedOut: false };
    if (args[1] === timeout) return { status: null, output: '', timedOut: true };
    return args[1] === fail ? { status: 1, output: `boom in ${fail}`, timedOut: false } : { status: 0, output: '', timedOut: false };
  };
  const steps = () => calls.filter((c) => c.cmd !== 'git').map((c) => c.args[1]);
  return { root, ctx, calls, exec, steps, saved };
};
import { mkdirSync } from 'node:fs';
import { SAFE_DIFF, SAFE_GIT } from '../../../src/core/git-safe.js';
const require_mkdir = (root: string) => mkdirSync(join(root, '.harness'), { recursive: true });
const SRC = ' M src/a.ts\0';

test('registered last of the Stop checks, Stop only, not fail-closed', async () => {
  expect(registry.filter((c) => c.events.includes('Stop')).at(-1)).toBe(stopGate);
  expect(stopGate.events).toEqual(['Stop']);
  expect(stopGate.failClosed).toBeFalsy();
});

test('inactive when checks.stop is false', async () => {
  const s = setup({ yaml: 'checks:\n  stop: false\n' });
  const out = await dispatch(JSON.stringify(s.ctx.input), [stopGate], {});
  expect(out).toBe('');
});

test('all steps pass: runs in order via the package manager, allows, resets attempts', async () => {
  const s = setup({ attempts: 2 });
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.steps()).toEqual(ALL);
  expect(s.calls[1]).toMatchObject({ cmd: 'pnpm', args: ['run', 'format:check'] });
  expect(s.calls[0]).toMatchObject({ cmd: 'git', args: [...SAFE_GIT, 'status', '--porcelain', '-z'] });
  expect(s.saved.at(-1)).toBe(0);
});

test('failing step blocks, stops at first failure, increments attempts, includes output', async () => {
  const s = setup();
  const d = await runStop(s.ctx, s.exec(SRC, 'lint'));
  expect(d).toMatchObject({ kind: 'block', check: 'stop' });
  expect((d as { reason: string }).reason).toMatch(/^lint failed \(attempt 1 of 3\)\. Fix it, then finish again\.\nboom in lint/);
  expect(s.steps()).toEqual(['format:check', 'lint']);
  expect(s.saved).toEqual([1]);
});

test('output is the last 3500 chars, truncated marker added', async () => {
  const s = setup();
  const exec: Exec = (cmd, args) => (cmd === 'git' ? { status: 0, output: SRC, timedOut: false } : { status: 1, output: `HEAD${'x'.repeat(4000)}TAIL\n\n`, timedOut: false });
  const r = (await runStop(s.ctx, exec) as { reason: string }).reason;
  expect(r).toContain('…(truncated)\n');
  expect(r.endsWith('TAIL')).toBe(true);
  expect(r).not.toContain('HEAD');
  expect(r.length).toBeLessThan(3700);
});

test('three failures in a row block, the fourth gives up: allow, reset, stop-gave-up event', async () => {
  const s = setup();
  const texts: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const d = await runStop(s.ctx, s.exec(SRC, 'test'));
    texts.push((d as { reason: string }).reason);
    expect(texts[n - 1]).toMatch(new RegExp(`^test failed \\(attempt ${n} of 3\\)`));
  }
  expect(await runStop(s.ctx, s.exec(SRC, 'test'))).toEqual({ kind: 'allow' });
  expect(s.ctx.state.stopAttempts).toBe(0);
  expect(readEvents(s.root).some((e) => e.check === 'stop' && e.decision === 'stop-gave-up')).toBe(true);
});

test('docs-only and clean trees allow, reset attempts, run nothing', async () => {
  for (const porcelain of ['?? README.md\0 M docs/a.ts\0?? notes.txt\0 M LICENSE\0A  guide.mdx\0', '']) {
    const s = setup({ attempts: 2 });
    expect(await runStop(s.ctx, s.exec(porcelain))).toEqual({ kind: 'allow' });
    expect(s.steps()).toEqual([]);
    expect(s.ctx.state.stopAttempts).toBe(0);
  }
});

test('rename uses the new path: doc renamed to code is not docs-only; code renamed to doc is', async () => {
  const a = setup();
  await runStop(a.ctx, a.exec('R  src/new.ts\0old.md\0'));
  expect(a.steps()).toEqual(ALL);
  const b = setup();
  await runStop(b.ctx, b.exec('R  new.md\0src/old.ts\0'));
  expect(b.steps()).toEqual([]);
});

test('steps missing from package.json scripts are skipped silently', async () => {
  const s = setup({ scripts: ['lint', 'test'] });
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.steps()).toEqual(['lint', 'test']);
});

test('config drives steps, package manager and attempts cap', async () => {
  const s = setup({ scripts: ['check'], yaml: 'stop:\n  steps: [check]\n  package_manager: npm\n  max_attempts: 1\n' });
  const d = await runStop(s.ctx, s.exec(SRC, 'check'));
  expect((d as { reason: string }).reason).toMatch(/^check failed \(attempt 1 of 1\)/);
  expect(s.calls.at(-1)).toMatchObject({ cmd: 'npm', args: ['run', 'check'] });
});

test('each step gets the remaining share of timeout_s (injected clock)', async () => {
  const s = setup({ yaml: 'stop:\n  timeout_s: 100\n' });
  let t = 1000;
  const now = () => (t += 10000);
  await runStop(s.ctx, s.exec(SRC), now);
  const ms = s.calls.filter((c) => c.cmd !== 'git').map((c) => c.ms);
  expect(ms[0]).toBeGreaterThan(ms[1]);
  expect(ms.every((m) => m > 0 && m <= 100000)).toBe(true);
});

test('timeout from exec: context text, stop-timeout event, attempts unchanged', async () => {
  const s = setup({ attempts: 1 });
  const d = await runStop(s.ctx, s.exec(SRC, '', 'lint'));
  expect(d).toEqual({ kind: 'context', text: 'Stop gate timed out after 540s; checks did not finish.', check: 'stop' });
  expect(s.saved).toEqual([]);
  expect(s.ctx.state.stopAttempts).toBe(1);
  expect(readEvents(s.root)).toEqual([]); // the dispatcher logs the one `context` event
});

test('timeout when the budget is spent before a step starts', async () => {
  const s = setup({ yaml: 'stop:\n  timeout_s: 30\n' });
  let t = 0;
  const d = await runStop(s.ctx, s.exec(SRC), () => (t += 60000));
  expect(d.kind).toBe('context');
  expect(s.steps()).toEqual([]);
});

test('timeout is emitted as a Stop systemMessage through the dispatcher', async () => {
  const s = setup();
  const timeoutGate = { ...stopGate, run: (c: Ctx) => runStop(c, s.exec(SRC, '', 'lint')) };
  const out = await dispatch(JSON.stringify(s.ctx.input), [timeoutGate], {});
  expect(JSON.parse(out)).toEqual({ systemMessage: 'Stop gate timed out after 540s; checks did not finish.' });
});

test('stop_hook_active does not bypass the gate', async () => {
  const s = setup({ hookActive: true });
  expect((await runStop(s.ctx, s.exec(SRC, 'lint'))).kind).toBe('block');
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

test('failed or timed-out git status fails closed: steps run and stop-diff-failed is logged once', async () => {
  for (const bad of [{ status: 128, output: 'fatal', timedOut: false }, { status: null, output: '', timedOut: true }]) {
    for (const baseHead of [undefined, 'abc']) {
      const s = setup({ baseHead });
      const base = s.exec('');
      expect(await runStop(s.ctx, (cmd, args, ms) => (cmd === 'git' && args.includes('status') ? bad : base(cmd, args, ms)))).toEqual({ kind: 'allow' });
      expect(s.steps()).toEqual(ALL);
      expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed', reason: 'git status failed' }]);
    }
  }
});

test('committed code change on a clean tree runs the steps; committed docs only skips; no baseHead = porcelain only', async () => {
  const a = setup({ baseHead: 'abc' });
  await runStop(a.ctx, a.exec('', '', '', 'src/a.ts\0README.md\0'));
  expect(a.steps()).toEqual(ALL);
  expect(a.calls.find((c) => c.args.includes('diff'))?.args).toEqual([...SAFE_GIT, 'diff', ...SAFE_DIFF, '--name-only', '-z', 'abc', 'HEAD']);
  const b = setup({ baseHead: 'abc' });
  await runStop(b.ctx, b.exec('', '', '', 'README.md\0docs/x.ts\0'));
  expect(b.steps()).toEqual([]);
  const c = setup();
  await runStop(c.ctx, c.exec('', '', '', 'src/a.ts\0'));
  expect(c.steps()).toEqual([]);
  expect(c.calls.some((x) => x.args.includes('diff'))).toBe(false);
});

test('coverage hook point: called after steps pass only when checks.tdd (nothing in tdd.paths allows)', async () => {
  const s = setup({ yaml: 'checks:\n  tdd: true\n' });
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
});

test('diff failure or timeout fails closed: steps run and stop-diff-failed is logged', async () => {
  for (const bad of [{ status: 128, output: 'fatal', timedOut: false }, { status: null, output: '', timedOut: true }]) {
    const s = setup({ baseHead: 'abc' });
    const base = s.exec('');
    await runStop(s.ctx, (cmd, args, ms) => (args.includes('diff') ? bad : base(cmd, args, ms)));
    expect(s.steps()).toEqual(ALL);
    expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed' }]);
  }
});

test('git calls get a fixed 5 s timeout and do not eat the step budget', async () => {
  const s = setup({ baseHead: 'abc', yaml: 'stop:\n  timeout_s: 30\n' });
  let t = 0;
  const base = s.exec('');
  const exec: Exec = (cmd, args, ms) => {
    if (args.includes('diff')) {
      s.calls.push({ cmd, args, ms });
      t += 5000;
      return { status: null, output: '', timedOut: true };
    }
    return base(cmd, args, ms);
  };
  await runStop(s.ctx, exec, () => t);
  expect(s.calls.filter((c) => c.cmd === 'git').map((c) => c.ms)).toEqual([5000, 5000]);
  expect(s.steps()).toEqual(ALL);
  expect(s.calls.find((c) => c.args[1] === 'lint')?.ms).toBe(30000);
  expect(readEvents(s.root)).toMatchObject([{ check: 'stop', decision: 'stop-diff-failed' }]);
});

test('detectBaseHead: HEAD, empty tree only when there are no commits, else undefined', async () => {
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
    const s = setup({ yaml: 'checks:\n  stop: true\n' }); // a config, so the hook prints no config-not-found warning
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
    await runStop({ ...s.ctx, state } as Ctx, exec);
    return ran;
  };
  expect(await first(['package.json', 'a.ts'], '.harness/\n')).toEqual(ALL);
  expect(await first(['README.md'], '.harness/\npackage.json\n')).toEqual([]);
});

test('git status parsed with -z: rename keeps the new path, odd names stay code', async () => {
  const a = setup();
  await runStop(a.ctx, a.exec('R  new.md\0old.md\0'));
  expect(a.steps()).toEqual([]);
  const b = setup();
  await runStop(b.ctx, b.exec(' M docs/x.md\0 M a "b".ts\0'));
  expect(b.steps()).toEqual(ALL);
  expect(b.calls[0].args).toEqual([...SAFE_GIT, 'status', '--porcelain', '-z']);
});

test('stop-no-git logged once per session', async () => {
  const s = setup();
  const bad = { status: 128, output: 'fatal: not a git repository', timedOut: false };
  const base = s.exec('');
  const exec: Exec = (cmd, args, ms) => (cmd === 'git' ? bad : base(cmd, args, ms));
  await runStop(s.ctx, exec);
  await runStop(s.ctx, exec);
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-no-git')).toHaveLength(1);
  expect(s.steps()).toEqual([...ALL, ...ALL]);
});

test('git status failure in a repo logs stop-diff-failed each time', async () => {
  const s = setup();
  const base = s.exec('');
  const exec: Exec = (cmd, args, ms) => (cmd === 'git' && args.includes('status') ? { status: 128, output: 'fatal', timedOut: false } : base(cmd, args, ms));
  await runStop(s.ctx, exec);
  await runStop(s.ctx, exec);
  expect(readEvents(s.root).map((e) => e.decision)).toEqual(['stop-diff-failed', 'stop-diff-failed']);
});

test('killTree picks the process-group kill on POSIX and taskkill on Windows', () => {
  const calls: unknown[][] = [];
  const run = { kill: (...a: unknown[]) => calls.push(['kill', ...a]), taskkill: (...a: unknown[]) => calls.push(['taskkill', ...a]) };
  killTree(42, 'linux', run as never);
  killTree(42, 'win32', run as never);
  expect(calls).toEqual([['kill', -42, 'SIGKILL'], ['taskkill', 42]]);
});

test.skipIf(process.platform === 'win32')('timed-out step kills its process group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-kill-'));
  const t0 = Date.now();
  const r = await defaultExec(dir)('sh', ['-c', 'sleep 30 & echo $! > child.pid; wait'], 500);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2500);
  const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
  await new Promise((res) => setTimeout(res, 200));
  expect(() => process.kill(pid, 0)).toThrow(); // the grandchild died with the group
}, 10000);

test.skipIf(process.platform === 'win32')('a grandchild holding the pipes does not hang the gate', async () => {
  const t0 = Date.now();
  // perl setsid detaches the grandchild from the process group; it keeps stdout open
  const r = await defaultExec(tmpdir())('sh', ['-c', "perl -MPOSIX -e 'POSIX::setsid(); sleep 20' & wait"], 500);
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(500 + 3000);
}, 10000);

test('spawn error resolves with status null and does not throw', async () => {
  const r = await defaultExec(tmpdir())('definitely-not-a-command-xyz', [], 1000);
  expect(r.status).toBeNull();
  expect(r.output).toMatch(/ENOENT/);
});

test('output is bounded to a rolling tail', async () => {
  const r = await defaultExec(tmpdir())('node', ['-e', "for(let i=0;i<20000;i++)console.log('line '+i+' '+'x'.repeat(100)); console.log('THE-END')"], 20000);
  expect(r.status).toBe(0);
  expect(r.output.length).toBeLessThan(200 * 1024);
  expect(r.output).toContain('THE-END');
}, 30000);

const PY = 'stop:\n  package_manager: none\n  steps:\n    - name: lint\n      run: [ruff, check, .]\n';

test('command step runs as written and a failure blocks with its label', async () => {
  const s = setup({ yaml: PY });
  const exec = s.exec(SRC, '.');
  const d = await runStop(s.ctx, exec);
  expect(s.calls.at(-1)).toMatchObject({ cmd: 'ruff', args: ['check', '.'] });
  expect(d).toMatchObject({ kind: 'block' });
  expect((d as { reason: string }).reason).toContain('lint failed (attempt 1 of');
});

const HINT = "Install it there, or edit stop.steps in `.harness/config.yaml`.";
const MISSING = `Every Stop step was skipped: \`ruff\` is not on the PATH Claude Code's hooks see (it can differ from your terminal's). ${HINT}`;

test('missing command does not block: one warning and one stop-tool-missing event per session per step', async () => {
  const s = setup({ yaml: PY });
  const d = await runStopReal(s.ctx, s.exec(SRC), Date.now, () => null);
  expect(d).toEqual({ kind: 'context', check: 'stop', text: MISSING });
  expect(s.steps()).toEqual([]);
  expect(s.ctx.state.stopAttempts).toBe(0);
  expect(await runStopReal(s.ctx, s.exec(SRC), Date.now, () => null)).toEqual({ kind: 'allow' });
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-tool-missing').map((e) => e.reason)).toEqual(['lint: ruff']);
});

test('missing tool reaches the user as a Stop systemMessage, not a block', async () => {
  const s = setup({ yaml: PY });
  const out = await runStopReal(s.ctx, s.exec(SRC), Date.now, () => null);
  const { emit } = await import('../../../src/hooks/io.js');
  expect(JSON.parse(emit('Stop', out))).toEqual({ systemMessage: MISSING });
});

test('missing package manager binary is skipped the same way; other steps still run and can block', async () => {
  const s = setup({ yaml: 'stop:\n  steps:\n    - lint\n    - name: own\n      run: [node, -e, x]\n' });
  const which = (cmd: string) => (cmd === 'pnpm' ? null : cmd);
  const d = await runStopReal(s.ctx, s.exec(SRC, 'x'), Date.now, which);
  expect(d).toMatchObject({ kind: 'block' });
  expect((d as { reason: string }).reason).toContain('own failed (attempt 1 of');
  // The block wins and the warning was not shown, so the step is not marked: the next Stop that passes warns.
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-tool-missing')).toEqual([]);
  expect(s.ctx.state.stopToolMissing ?? []).toEqual([]);
  const ok = await runStopReal(s.ctx, s.exec(SRC), Date.now, which);
  expect(ok).toEqual({ kind: 'context', check: 'stop', text: `Stop step \`lint\` was skipped: \`pnpm\` is not on the PATH Claude Code's hooks see (it can differ from your terminal's). ${HINT}` });
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-tool-missing').map((e) => e.reason)).toEqual(['lint: pnpm']);
});

test('package manager missing for every step: one warning that says every step was skipped', async () => {
  const s = setup();
  const d = await runStopReal(s.ctx, s.exec(SRC), Date.now, () => null);
  expect(d).toEqual({ kind: 'context', check: 'stop', text: `Every Stop step was skipped: \`pnpm\` is not on the PATH Claude Code's hooks see (it can differ from your terminal's). ${HINT}` });
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-tool-missing')).toHaveLength(4);
});

test('no steps at all: allowed, stop-nothing-to-run logged once per session', async () => {
  const s = setup({ yaml: 'stop:\n  package_manager: none\n' });
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.steps()).toEqual([]);
  expect(readEvents(s.root).filter((e) => e.decision === 'stop-nothing-to-run')).toHaveLength(1);
});

test('no steps with tdd on: allowed, coverage gate not run', async () => {
  const s = setup({ yaml: 'stop:\n  package_manager: none\nchecks:\n  tdd: true\n' });
  expect(s.ctx.config.checks.tdd).toBe(true);
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
  expect(s.calls.every((c) => c.cmd === 'git' && c.args.includes('status'))).toBe(true);
});

test('each step run writes one timing line (step, outcome); events.jsonl is unchanged', async () => {
  const s = setup({ scripts: ['lint', 'test'], yaml: 'stop:\n  steps: [lint, test]\n' });
  const d = await runStop(s.ctx, s.exec(SRC, 'test'));
  expect(d.kind).toBe('block');
  const t = readTiming(s.root);
  expect(t.map((x) => [x.event, x.step, x.outcome])).toEqual([['Stop', 'lint', 'allow'], ['Stop', 'test', 'block']]);
  expect(t.every((x) => x.session === 's' && Number.isFinite(x.ms))).toBe(true);
  expect(readEvents(s.root)).toEqual([]);
});

test('a timed-out step and a spent budget log outcome timeout, not block', async () => {
  const a = setup({ scripts: ['lint'], yaml: 'stop:\n  steps: [lint]\n' });
  await runStop(a.ctx, a.exec(SRC, '', 'lint'));
  expect(readTiming(a.root).map((x) => x.outcome)).toEqual(['timeout']);
  const b = setup({ scripts: ['lint'], yaml: 'stop:\n  steps: [lint]\n  timeout_s: 30\n' });
  let t = 0;
  await runStop(b.ctx, b.exec(SRC), () => (t += 60000));
  expect(readTiming(b.root).map((x) => x.outcome)).toEqual(['timeout']);
});

// Team-decision nudge (spec §8, C10): a note on the gate's allow path only.
const HIT = { decisionHits: [{ pattern: 'P1', excerpt: 'from now on use zod' }] };
const NUDGE = /^Harness: this session may hold a team decision \(you said "from now on use zod"\)/m;
const text = (d: unknown) => (d as { text?: string }).text ?? '';

test('nudge: a blocked Stop holds it; the next passing Stop shows it once', async () => {
  const s = setup();
  s.ctx.state = { ...s.ctx.state, ...HIT };
  expect(await runStop(s.ctx, s.exec(SRC, 'lint'))).toMatchObject({ kind: 'block' });
  expect(s.ctx.state.decisionNudged).toBeUndefined();
  const d = await runStop(s.ctx, s.exec(SRC));
  expect(d).toMatchObject({ kind: 'context', check: 'stop' });
  expect(text(d)).toMatch(NUDGE);
  expect(s.ctx.state.decisionNudged).toBe(true);
  expect(await runStop(s.ctx, s.exec(SRC))).toEqual({ kind: 'allow' });
});

test('nudge: a session that changed only docs/decisions/ still gets it', async () => {
  const s = setup();
  s.ctx.state = { ...s.ctx.state, ...HIT };
  expect(text(await runStop(s.ctx, s.exec('?? docs/decisions/0001-zod.md\0')))).toMatch(NUDGE);
  expect(s.steps()).toEqual([]);
});

test('nudge: joined with the tool-missing warning in one note', async () => {
  const s = setup({ yaml: PY });
  s.ctx.state = { ...s.ctx.state, ...HIT };
  const d = await runStopReal(s.ctx, s.exec(SRC), Date.now, () => null);
  expect(text(d).split('\n')).toHaveLength(2);
  expect(text(d)).toMatch(new RegExp(`^${MISSING.slice(0, 20)}`));
  expect(text(d)).toMatch(NUDGE);
});

test('nudge: none with checks.decisions: false or checks.stop: false', async () => {
  const off = setup({ yaml: 'checks:\n  decisions: false\n' });
  off.ctx.state = { ...off.ctx.state, ...HIT };
  expect(await runStop(off.ctx, off.exec(SRC))).toEqual({ kind: 'allow' });
  const stopOff = setup({ yaml: 'checks:\n  stop: false\n' });
  writeState(stopOff.root, 's', { ...stopOff.ctx.state, ...HIT });
  expect(await dispatch(JSON.stringify(stopOff.ctx.input), [stopGate], {})).toBe('');
});

test('nudge: an A-only hit on a blocked Stop is held for the next passing Stop', async () => {
  const s = setup();
  const signals = (last: string) => {
    s.ctx.input = { ...s.ctx.input, last_assistant_message: last };
    decisionSignals.run(s.ctx);
  };
  signals("Going forward, I'll run lint first.");
  expect(await runStop(s.ctx, s.exec(SRC, 'lint'))).toMatchObject({ kind: 'block' });
  signals('Fixed lint.');
  expect(text(await runStop(s.ctx, s.exec(SRC)))).toContain('(you said "Going forward, I\'ll run lint first.")');
});

test('nudge: the gave-up allow shows it too', async () => {
  const s = setup();
  s.ctx.state = { ...s.ctx.state, ...HIT };
  for (let n = 1; n <= 3; n++) expect(await runStop(s.ctx, s.exec(SRC, 'test'))).toMatchObject({ kind: 'block' });
  expect(text(await runStop(s.ctx, s.exec(SRC, 'test')))).toMatch(NUDGE);
});

test('a team-decision warning is a note: the gate allows with context, never blocks, and stopAttempts is untouched', async () => {
  const s = setup({ attempts: 1 });
  writeDecision(s.root, decision('2026-11-01-w', { verified_on: new Date().toISOString().slice(0, 10), paths: ['src/**'] }));
  const d = await runStop(s.ctx, s.exec(SRC));
  expect(d).toMatchObject({ kind: 'context', check: 'stop' });
  expect((d as { text: string }).text).toContain('team decision `2026-11-01-w`');
  expect(s.ctx.state.stopAttempts).toBe(0); // the pass resets it, as for any allow
});
