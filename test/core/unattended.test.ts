import { expect, test } from 'vitest';
import { isUnattended } from '../../src/core/unattended.js';

test.each([
  [{ CLAUDE_CODE_REMOTE: 'true' }, {}, true],
  [{ CI: 'true' }, {}, true],
  [{ HARNESS_UNATTENDED: '1' }, {}, true],
  [{}, { permission_mode: 'dontAsk' }, true],
  [{}, { permission_mode: 'bypassPermissions' }, true],
  [{}, { permission_mode: 'default' }, false],
  [{}, { agent_id: 'a' }, false],
])('isUnattended(%o, %o) = %s', (env, input, expected) => {
  expect(isUnattended({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', ...input }, env)).toBe(expected);
});
