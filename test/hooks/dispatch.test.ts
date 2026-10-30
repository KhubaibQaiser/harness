import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { readEvents } from '../../src/core/events.js';
import { isSafeSessionId, readState } from '../../src/core/state.js';
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
test('config warnings go to stderr once per process', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-dp-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'bogus: 1\n');
  const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await dispatch(pre({ cwd: r }), [], {});
  await dispatch(pre({ cwd: r }), [], {});
  expect(err.mock.calls.filter((c) => String(c[0]).includes('bogus'))).toHaveLength(1);
  err.mockRestore();
});
