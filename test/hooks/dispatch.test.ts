import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { isSafeSessionId, readState, statePath } from '../../src/core/state.js';
import { type Check, dispatch } from '../../src/hooks/dispatch.js';
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
test('bundle exits 0 with empty stdout for empty and garbage stdin', () => {
  for (const input of ['', 'garbage{']) {
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { input, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
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
