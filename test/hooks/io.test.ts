import { expect, test } from 'vitest';
import { emit, parseInput } from '../../src/hooks/io.js';

test('parseInput returns null for empty or non-JSON input', () => {
  expect(parseInput('')).toBeNull();
  expect(parseInput('not json')).toBeNull();
});
test('parseInput returns null for non-objects or missing event name', () => {
  expect(parseInput('[1]')).toBeNull();
  expect(parseInput('null')).toBeNull();
  expect(parseInput('{"hook_event_name":1}')).toBeNull();
});
test('parseInput returns the input object', () => {
  expect(parseInput('{"hook_event_name":"Stop","session_id":"s","cwd":"/r"}')?.hook_event_name).toBe('Stop');
});
test('emit PreToolUse deny uses hookSpecificOutput', () => {
  const out = JSON.parse(emit('PreToolUse', { kind: 'deny', reason: 'r', check: 'guard' }));
  expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' });
});
test('emit PreToolUse ask uses permissionDecision ask', () => {
  const out = JSON.parse(emit('PreToolUse', { kind: 'ask', reason: 'r', check: 'c' }));
  expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
});
test('emit Stop block uses decision/reason', () => {
  expect(JSON.parse(emit('Stop', { kind: 'block', reason: 'r', check: 'stop' }))).toEqual({ decision: 'block', reason: 'r' });
});
test('emit deny on a non-PreToolUse event blocks', () => {
  expect(JSON.parse(emit('ConfigChange', { kind: 'deny', reason: 'r', check: 'c' }))).toEqual({ decision: 'block', reason: 'r' });
});
test('emit allow writes nothing', () => expect(emit('PreToolUse', { kind: 'allow' })).toBe(''));
test('emit context on PreToolUse uses additionalContext', () => {
  expect(JSON.parse(emit('PreToolUse', { kind: 'context', text: 't', check: 'c' }))).toEqual({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 't' },
  });
});
test('emit context on Stop uses systemMessage', () => {
  expect(JSON.parse(emit('Stop', { kind: 'context', text: 't', check: 'c' }))).toEqual({ systemMessage: 't' });
});
