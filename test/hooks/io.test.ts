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
test('emit PreToolUse block maps to permissionDecision deny', () => {
  const out = JSON.parse(emit('PreToolUse', { kind: 'block', reason: 'r', check: 'c' }));
  expect(out.hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' });
});
test('emit context on SessionEnd uses systemMessage', () => {
  expect(JSON.parse(emit('SessionEnd', { kind: 'context', text: 't', check: 'c' }))).toEqual({ systemMessage: 't' });
});
test.each(['PostToolUse', 'UserPromptSubmit', 'SessionStart'])('emit context on %s uses additionalContext', (event) => {
  expect(JSON.parse(emit(event, { kind: 'context', text: 't', check: 'c' }))).toEqual({
    hookSpecificOutput: { hookEventName: event, additionalContext: 't' },
  });
});
test('emit ask on a non-PreToolUse event blocks', () => {
  expect(JSON.parse(emit('Stop', { kind: 'ask', reason: 'r', check: 'c' }))).toEqual({ decision: 'block', reason: 'r' });
});
test('parseInput returns null when session_id or cwd is not a string', () => {
  expect(parseInput('{"hook_event_name":"Stop","cwd":"/r"}')).toBeNull();
  expect(parseInput('{"hook_event_name":"Stop","session_id":"s"}')).toBeNull();
  expect(parseInput('{"hook_event_name":"Stop","session_id":1,"cwd":"/r"}')).toBeNull();
  expect(parseInput('{"hook_event_name":"Stop","session_id":"s","cwd":null}')).toBeNull();
});
test('emit context with a notice adds systemMessage beside additionalContext', () => {
  const out = JSON.parse(emit('PostToolUse', { kind: 'context', text: 'a', notice: 'b', check: 'x' }));
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a' }, systemMessage: 'b' });
});
test('emit context without a notice is unchanged', () => {
  const out = JSON.parse(emit('PostToolUse', { kind: 'context', text: 'a', check: 'x' }));
  expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'a' } });
});
test('emit context at Stop keeps the text as systemMessage and ignores the notice', () => {
  expect(JSON.parse(emit('Stop', { kind: 'context', text: 'a', notice: 'b', check: 'x' }))).toEqual({ systemMessage: 'a' });
});
