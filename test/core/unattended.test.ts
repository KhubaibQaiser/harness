import { expect, test } from 'vitest';
import { isUnattended, unattendedEnv } from '../../src/core/unattended.js';

test.each([
  [{ CLAUDE_CODE_REMOTE: 'true' }, {}, true],
  [{ CI: 'true' }, {}, true],
  [{ HARNESS_UNATTENDED: '1' }, {}, true],
  [{}, { permission_mode: 'dontAsk' }, true],
  [{}, { permission_mode: 'bypassPermissions' }, true],
  [{}, { permission_mode: 'default' }, false],
  [{}, { agent_id: 'a' }, false],
  [{ CI: '1' }, {}, true],
  [{ HARNESS_UNATTENDED: 'true' }, {}, true],
  [{ CI: 'false' }, {}, false],
  [{ CI: '' }, {}, false],
  [{ CLAUDE_CODE_REMOTE: '0' }, {}, false],
  [{ CLAUDE_CODE_REMOTE: '1' }, {}, false],
])('isUnattended(%o, %o) = %s', (env, input, expected) => {
  expect(isUnattended({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', ...input }, env)).toBe(expected);
});

test('unattendedEnv reads the env parts only', () => {
  expect(unattendedEnv({ CI: 'true' })).toBe(true);
  expect(unattendedEnv({ HARNESS_UNATTENDED: 'true' })).toBe(true);
  expect(unattendedEnv({ CLAUDE_CODE_REMOTE: 'true' })).toBe(true);
  expect(unattendedEnv({ CI: 'false', CLAUDE_CODE_REMOTE: '1' })).toBe(false);
});
