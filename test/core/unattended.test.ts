import { expect, test } from 'vitest';
import { isUnattended, scrubOnly, unattendedEnv } from '../../src/core/unattended.js';

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
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, {}, true],
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 'true' }, {}, true],
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }, { permission_mode: 'default' }, true],
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' }, {}, false],
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '' }, {}, false],
  [{ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: 'yes' }, {}, false],
])('isUnattended(%o, %o) = %s', (env, input, expected) => {
  expect(isUnattended({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', ...input }, env)).toBe(expected);
});

test('unattendedEnv reads the env parts only', () => {
  expect(unattendedEnv({ CI: 'true' })).toBe(true);
  expect(unattendedEnv({ HARNESS_UNATTENDED: 'true' })).toBe(true);
  expect(unattendedEnv({ CLAUDE_CODE_REMOTE: 'true' })).toBe(true);
  expect(unattendedEnv({ CI: 'false', CLAUDE_CODE_REMOTE: '1' })).toBe(false);
});

test('unattendedEnv counts the scrub', () => {
  expect(unattendedEnv({ CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' })).toBe(true);
});

test('scrubOnly: the scrub alone is true; any other cause, or no scrub, is false', () => {
  const inp = (o = {}) => ({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/r', ...o });
  const S = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' };
  expect(scrubOnly(inp(), S)).toBe(true);
  for (const extra of [{ HARNESS_UNATTENDED: '1' }, { CI: 'true' }, { CLAUDE_CODE_REMOTE: 'true' }]) expect(scrubOnly(inp(), { ...S, ...extra })).toBe(false);
  for (const permission_mode of ['dontAsk', 'bypassPermissions']) expect(scrubOnly(inp({ permission_mode }), S)).toBe(false);
  expect(scrubOnly(inp(), {})).toBe(false);
});
