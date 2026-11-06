import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { isSafeSessionId, readState, statePath } from '../../src/core/state.js';
import { readHookEnv } from '../../src/core/hook-env.js';
import { type Check, dispatch, runHook } from '../../src/hooks/dispatch.js';
import type { Decision, HookEvent } from '../../src/hooks/types.js';

const root = mkdtempSync(join(tmpdir(), 'h-dp-'));
mkdirSync(join(root, '.harness'));
writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n');
const mk = (name: string, d: Decision, events: HookEvent[] = ['PreToolUse', 'PostToolUse', 'Stop']): Check => ({ name, events, run: () => d });
const denyAll = mk('deny-all', { kind: 'deny', reason: 'no', check: 'deny-all' });
const askAll = mk('ask-all', { kind: 'ask', reason: 'sure?', check: 'ask-all' });
const throwing = (extra: Partial<Check> = {}): Check => ({ name: 'boom', events: ['PreToolUse'], run: () => { throw new Error('bad'); }, ...extra });
const payload = (o: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Edit', ...o });
const pre = payload;
const out = (s: string) => JSON.parse(s) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string }; decision?: string };
const decisionOf = (s: string) => out(s).hookSpecificOutput?.permissionDecision ?? out(s).decision;

test('empty, non-JSON or unknown events allow silently', async () => {
  for (const raw of ['', 'x', JSON.stringify({ hook_event_name: 'Nope', session_id: 's', cwd: root })]) expect(await dispatch(raw, [denyAll], {})).toBe('');
});
test('Cursor-imported calls exit silently', async () => {
  for (const o of [{ conversation_id: 'c' }, { generation_id: 'g' }, { model_id: 'm' }, { workspace_roots: [] }, { tool_name: 'Shell' }])
    expect(await dispatch(pre(o), [denyAll], {})).toBe('');
});
test('deny beats ask', async () => {
  expect(decisionOf(await dispatch(pre(), [askAll, denyAll], {}))).toBe('deny');
});
test('PreToolUse stops running checks at the first deny', async () => {
  let ran = false;
  const later: Check = { name: 'later', events: ['PreToolUse', 'PostToolUse'], run: () => ((ran = true), { kind: 'allow' }) };
  expect(decisionOf(await dispatch(pre(), [denyAll, later], {}))).toBe('deny');
  expect(ran).toBe(false);
  await dispatch(pre({ hook_event_name: 'PostToolUse' }), [denyAll, later], {});
  expect(ran).toBe(true);
});
const pureDeny = (name: string): Check => ({ ...mk(name, { kind: 'deny', reason: `r-${name}`, check: name }), pure: true });
test('co-denies are logged', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'checks:\n  guard: true\n');
  const res = await dispatch(pre({ cwd: r }), [pureDeny('guard'), pureDeny('protect')], {});
  expect(out(res).hookSpecificOutput?.permissionDecisionReason).toBe('r-guard');
  const ev = readEvents(r).filter((e) => e.decision === 'deny');
  expect(ev).toHaveLength(2);
  expect(ev[0]!.co).toBeUndefined();
  expect(ev[1]).toMatchObject({ check: 'protect', co: true });
});
test('impure checks do not run after a deny', async () => {
  let ran = false;
  const impure: Check = { name: 'impure', events: ['PreToolUse'], run: () => ((ran = true), { kind: 'allow' }) };
  await dispatch(pre(), [pureDeny('guard'), impure], {});
  expect(ran).toBe(false);
});
test('unattended turns ask into deny with prefix', async () => {
  const r = await dispatch(pre(), [askAll], { CI: 'true' });
  expect(decisionOf(r)).toBe('deny');
  expect(out(r).hookSpecificOutput?.permissionDecisionReason).toBe('Unattended run: sure?');
});
test('ask alone stays ask when attended', async () => {
  expect(decisionOf(await dispatch(pre(), [askAll], {}))).toBe('ask');
});
test('throwing check fails open unless failClosed', async () => {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  expect(await dispatch(pre(), [throwing()], {})).toBe('');
  expect(err).toHaveBeenCalledWith(expect.stringContaining('harness: check boom failed: bad'));
  const r = await dispatch(pre(), [throwing({ failClosed: true })], {});
  expect(decisionOf(r)).toBe('deny');
  expect(out(r).hookSpecificOutput?.permissionDecisionReason).toBe('harness check boom failed: bad');
  err.mockRestore();
});
test('non-allow decisions are logged', async () => {
  await dispatch(pre(), [denyAll], {});
  expect(readEvents(root).at(-1)).toMatchObject({ check: 'deny-all', decision: 'deny', session: 's' });
});
test('only checks whose events include the hook event run', async () => {
  const stopOnly = mk('stop-only', { kind: 'deny', reason: 'x', check: 'stop-only' }, ['Stop']);
  expect(await dispatch(pre(), [stopOnly], {})).toBe('');
});
test('context decisions are joined', async () => {
  const c = (n: string): Check => mk(n, { kind: 'context', text: n, check: n }, ['PostToolUse']);
  const r = await dispatch(payload({ hook_event_name: 'PostToolUse' }), [c('a'), c('b')], {});
  expect(out(r).hookSpecificOutput?.additionalContext).toBe('a\nb');
});
test('ask on Stop becomes block; ask elsewhere is ignored and logged', async () => {
  expect(decisionOf(await dispatch(payload({ hook_event_name: 'Stop' }), [askAll], {}))).toBe('block');
  expect(await dispatch(payload({ hook_event_name: 'PostToolUse' }), [askAll], {})).toBe('');
  expect(readEvents(root).at(-1)).toMatchObject({ check: 'ask-all', decision: 'ask-ignored' });
});
test('unsafe session ids allow silently and run nothing', async () => {
  for (const id of ['../x', '.', '..', 'a/b', '']) expect(await dispatch(pre({ session_id: id }), [denyAll], {})).toBe('');
  expect(isSafeSessionId('ok-1._x')).toBe(true);
  expect(isSafeSessionId('..')).toBe(false);
});
test('session state is written on first hook and ctx.save persists', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'checks:\n  guard: true\n');
  const saver: Check = { name: 'saver', events: ['PreToolUse'], run: (ctx) => { ctx.save({ ...ctx.state, files: ['a'] }); return { kind: 'allow' }; } };
  expect(existsSync(join(r, '.harness/state/s.json'))).toBe(false);
  await dispatch(pre({ cwd: r }), [], {});
  const t = readState(r, 's').startedAt;
  await dispatch(pre({ cwd: r }), [saver], {});
  expect(readState(r, 's')).toMatchObject({ startedAt: t, files: ['a'] });
});
const tmpRoot = () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'checks:\n  guard: true\n');
  return r;
};
test('config warnings go to stderr on UserPromptSubmit only', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'bogus: 1\n');
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await dispatch(pre({ cwd: r }), [], {});
  expect(err.mock.calls.filter((c) => String(c[0]).includes('bogus'))).toHaveLength(0);
  await dispatch(payload({ cwd: r, hook_event_name: 'UserPromptSubmit' }), [], {});
  await dispatch(payload({ cwd: r, hook_event_name: 'UserPromptSubmit' }), [], {});
  expect(err.mock.calls.filter((c) => String(c[0]).includes('bogus'))).toHaveLength(2);
  err.mockRestore();
});
test('fail-closed deny survives unwritable .harness', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  writeFileSync(join(r, '.harness'), 'not a dir');
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const guard: Check = { ...denyAll, failClosed: true };
  expect(decisionOf(await dispatch(pre({ cwd: r }), [guard], {}))).toBe('deny');
  expect(err).toHaveBeenCalledWith(expect.stringMatching(/^harness: .* failed: /));
  err.mockRestore();
});
test('malformed check results and non-Error throws are treated as throws', async () => {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const bad = (extra: Partial<Check> = {}): Check => ({ name: 'bad', events: ['PreToolUse'], run: () => undefined as unknown as Decision, ...extra });
  expect(await dispatch(pre(), [bad()], {})).toBe('');
  expect(decisionOf(await dispatch(pre(), [bad({ failClosed: true })], {}))).toBe('deny');
  const thrower = (v: unknown, extra: Partial<Check> = {}): Check => ({ name: 't', events: ['PreToolUse'], run: () => { throw v; }, ...extra });
  expect(await dispatch(pre(), [thrower(null)], {})).toBe('');
  expect(out(await dispatch(pre(), [thrower(undefined, { failClosed: true })], {})).hookSpecificOutput?.permissionDecisionReason).toBe('harness check t failed: undefined');
  err.mockRestore();
});
test('corrupt state file is rewritten on first hook', async () => {
  const r = tmpRoot();
  mkdirSync(join(r, '.harness/state'));
  writeFileSync(statePath(r, 's'), '{oops');
  await dispatch(pre({ cwd: r }), [], {});
  expect(() => JSON.parse(readFileSync(statePath(r, 's'), 'utf8'))).not.toThrow();
});
test('bundle exits 1 with empty stdout for empty and garbage stdin', () => {
  for (const input of ['', 'garbage{']) {
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { input, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  }
});
test('--self-test prints ok and the Node version without reading stdin', async () => {
  // stdin stays open and is never written to or ended: a read of it would hang until the timeout kills the child
  const c = spawn(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs'), '--self-test'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  let stdout = '';
  c.stdout.on('data', (d) => (stdout += d));
  const [code, signal] = await new Promise<[number | null, string | null]>((res, rej) => {
    c.on('error', rej); // a spawn failure (EMFILE) fails the test instead of going uncaught
    c.on('close', (cd, sg) => res([cd, sg]));
  });
  expect(signal).toBeNull();
  expect(code).toBe(0);
  expect(stdout).toMatch(/^ok v\d+\.\d+\.\d+\n?$/);
});

/** Restores a stderr spy at the end of the test, so expected failure messages don't print into the suite output. */
const after = (spy: { mockRestore: () => void }) => onTestFinished(() => spy.mockRestore());
const boom = async (): Promise<string> => { throw new Error('bad'); };
test('runHook: a throw on PreToolUse prints a deny', async () => {
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  after(err);
  const r = await runHook(pre(), boom);
  expect(r.code).toBe(0);
  expect(out(r.out).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'harness dispatcher failed: bad' });
});
test('runHook: a throw on UserPromptSubmit or ConfigChange exits 1 with no output', async () => {
  after(vi.spyOn(process.stderr, 'write').mockReturnValue(true));
  for (const e of ['UserPromptSubmit', 'ConfigChange']) expect(await runHook(payload({ hook_event_name: e }), boom)).toEqual({ out: '', code: 1 });
});
test('runHook: unparseable stdin exits 1, fields missing on PreToolUse denies, unknown event is silent', async () => {
  after(vi.spyOn(process.stderr, 'write').mockReturnValue(true));
  for (const raw of ['', 'garbage{']) expect(await runHook(raw, async () => 'x')).toEqual({ out: '', code: 1 });
  const miss = await runHook('{"hook_event_name":"PreToolUse"}', (r) => dispatch(r, [], {}));
  expect(miss.code).toBe(0);
  expect(decisionOf(miss.out)).toBe('deny');
  expect(await runHook(JSON.stringify({ hook_event_name: 'Nope', session_id: 's', cwd: root }), (r) => dispatch(r, [], {}))).toEqual({ out: '', code: 0 });
});
test('UserPromptSubmit writes hook-env.json, PreToolUse alone does not', async () => {
  after(vi.spyOn(process.stderr, 'write').mockReturnValue(true));
  const r = mkdtempSync(join(tmpdir(), 'h-dp-env-'));
  await dispatch(pre({ cwd: r }), [], {});
  expect(readHookEnv(r)).toBeNull();
  await dispatch(payload({ cwd: r, hook_event_name: 'UserPromptSubmit' }), [], {});
  const e = readHookEnv(r)!;
  expect([e.node, e.execPath, e.platform]).toEqual([process.version, process.execPath, process.platform]);
  expect(new Date(e.ts).toISOString()).toBe(e.ts);
});

test('records baseHead (git HEAD) when the session state is first created', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readState } = await import('../../src/core/state.js');
  const root = mkdtempSync(join(tmpdir(), 'h-bh-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n'); // so the hook prints no config-not-found warning
  const input = JSON.stringify({ session_id: 'bh', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'x' });
  await dispatch(input, [], {});
  expect(existsSync(join(root, '.harness/state/bh.json'))).toBe(true);
  const head = git('rev-parse', 'HEAD');
  expect(readState(root, 'bh').baseHead).toBe(head);
  git('commit', '-q', '--allow-empty', '-m', 'two');
  await dispatch(input, [], {});
  expect(readState(root, 'bh').baseHead).toBe(head);
});

// I2: an invalid config fails closed instead of silently falling back to defaults.
const BAD_CONFIGS: [string, string, RegExp][] = [
  ['bad YAML', 'checks:\n  tdd: [\n', /not valid YAML \(.*line/],
  ['top level not a mapping', '- a\n- b\n', /top level must be a mapping/],
  ['unknown key', 'checks:\n  tdd_x: true\n', /unknown key "checks\.tdd_x"/],
  ['wrong type', 'checks:\n  tdd: "true"\n', /"checks\.tdd" must be a boolean/],
  ['out of range', 'stop:\n  max_attempts: 99\n', /"stop\.max_attempts" must be an integer from 1 to 10/],
  ['not a mapping', 'checks: true\n', /"checks" must be a mapping/],
];
const reasonOf = (s: string) => out(s).hookSpecificOutput?.permissionDecisionReason ?? (JSON.parse(s) as { reason?: string }).reason;
test.each(BAD_CONFIGS)('invalid config (%s): edits deny, the config edit falls through to the checks, Bash runs, Stop blocks then gives up', async (_n, yaml, key) => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-bad-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), yaml);
  const allowAll = mk('allow-all', { kind: 'allow' });
  const edit = await dispatch(pre({ cwd: r, tool_input: { file_path: join(r, 'src/a.ts') } }), [allowAll], {});
  expect(decisionOf(edit)).toBe('deny');
  expect(reasonOf(edit)).toMatch(key);
  expect(reasonOf(edit)).toContain('ask the user to correct .harness/config.yaml');
  // The config file itself: the usual checks decide (here a stand-in for protect).
  expect(reasonOf(await dispatch(pre({ cwd: r, tool_input: { file_path: join(r, '.harness/config.yaml') } }), [denyAll], {}))).toBe('no');
  expect(await dispatch(pre({ cwd: r, tool_name: 'Bash', tool_input: { command: 'ls' } }), [allowAll], {})).toBe('');
  const stop = () => dispatch(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: r }), [allowAll], {});
  for (let i = 0; i < 3; i++) expect(reasonOf(await stop())).toMatch(key); // default max_attempts is 3
  expect(await stop()).toBe('');
});
test('a valid config does not trip the invalid-config gate', async () => {
  expect(await dispatch(pre({ tool_input: { file_path: join(root, 'src/a.ts') } }), [mk('allow-all', { kind: 'allow' })], {})).toBe('');
  expect(await dispatch(pre({ tool_name: 'Bash', tool_input: { command: 'echo x > src/b.js' } }), [mk('allow-all', { kind: 'allow' })], {})).toBe('');
});
// N2: shell writes and deletes are edits too.
test.each(BAD_CONFIGS)('invalid config (%s): Bash writes, deletes, moves and restores in the repo deny; reads, outside writes and the config pass', async (_n, yaml, key) => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-badsh-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), yaml);
  const allowAll = mk('allow-all', { kind: 'allow' });
  const bash = (command: string) => dispatch(pre({ cwd: r, tool_name: 'Bash', tool_input: { command } }), [allowAll], {});
  for (const c of ['rm src/a.test.js', 'echo x > src/b.js', 'sed -i.bak s/1/2/ src/a.js', 'mv src/a.js src/c.js', 'cp x src/d.js', 'git checkout -- src/a.js', 'git checkout .', 'bash -c "echo x > src/e.js"', 'tee src/f.js < x']) {
    const out = await bash(c);
    expect(decisionOf(out), c).toBe('deny');
    expect(reasonOf(out), c).toMatch(key);
  }
  for (const c of ['ls', 'cat src/a.js', 'echo x > /tmp/harness-out.txt', 'echo x > /dev/null', 'harness doctor']) expect(await bash(c), c).toBe('');
  // a shell write to the config itself is left to the usual checks (protect denies the agent)
  expect(reasonOf(await dispatch(pre({ cwd: r, tool_name: 'Bash', tool_input: { command: 'echo "version: 1" > .harness/config.yaml' } }), [denyAll], {}))).toBe('no');
});

test('invalid config: a PowerShell shell write in the repo is denied by config', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-badps-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'checks: true\n');
  const o = out(await dispatch(pre({ cwd: r, tool_name: 'PowerShell', tool_input: { command: 'echo x > src/a.ts' } }), [mk('allow-all', { kind: 'allow' })], {}));
  expect(o.hookSpecificOutput?.permissionDecision).toBe('deny');
  expect(o.hookSpecificOutput?.permissionDecisionReason).toContain('ask the user to correct .harness/config.yaml');
});
test('context notices are joined and shown as systemMessage', async () => {
  const c1 = mk('c1', { kind: 'context', text: 't1', notice: 'n1', check: 'c1' });
  const c2 = mk('c2', { kind: 'context', text: 't2', notice: 'n2', check: 'c2' });
  const o = JSON.parse(await dispatch(payload({ hook_event_name: 'PostToolUse' }), [c1, c2], {}));
  expect(o.systemMessage).toBe('n1\nn2');
  expect(o.hookSpecificOutput.additionalContext).toBe('t1\nt2');
});
test('a notice with control or hidden characters is escaped', async () => {
  const c = mk('c', { kind: 'context', text: 't', notice: 'a‮b\u001b[31m', check: 'c' });
  const o = JSON.parse(await dispatch(payload({ hook_event_name: 'PostToolUse' }), [c], {}));
  expect(o.systemMessage).toBe('a\\u202eb\\u001b[31m');
});
test('at Stop a block keeps the context text as systemMessage', async () => {
  const b = mk('b', { kind: 'block', reason: 'r', check: 'b' });
  const c = mk('c', { kind: 'context', text: 'warn', check: 'c' });
  const o = JSON.parse(await dispatch(payload({ hook_event_name: 'Stop' }), [b, c], {}));
  expect(o.decision).toBe('block');
  expect(o.reason).toBe('r');
  expect(o.systemMessage).toBe('warn');
});
test('at PreToolUse a deny plus a context check has no systemMessage', async () => {
  const c = mk('c', { kind: 'context', text: 'warn', notice: 'n', check: 'c' });
  const o = JSON.parse(await dispatch(pre(), [denyAll, c], {}));
  expect(o.systemMessage).toBeUndefined();
  expect(decisionOf(JSON.stringify(o))).toBe('deny');
});
