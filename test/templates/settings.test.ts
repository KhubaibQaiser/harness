import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const s = JSON.parse(readFileSync('templates/settings.fragment.json', 'utf8'));
const CMD = 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"';

test('hooks: events, matchers, command and timeouts', () => {
  expect(Object.keys(s.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionEnd', 'Stop', 'UserPromptSubmit']);
  expect(s.hooks.ConfigChange).toBeUndefined();
  expect(s.hooks.PreToolUse[0].matcher).toBe('Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit');
  expect(s.hooks.PostToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit');
  for (const e of ['UserPromptSubmit', 'Stop', 'SessionEnd']) expect(s.hooks[e][0]).not.toHaveProperty('matcher');
  for (const [event, groups] of Object.entries<any[]>(s.hooks)) {
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks).toEqual([{ type: 'command', command: CMD, timeout: event === 'Stop' ? 600 : 10 }]);
  }
});

test('permissions.deny has every required entry', () => {
  expect(s.permissions.deny).toEqual(
    expect.arrayContaining([
      'Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)',
      'Edit(./.harness/hooks/**)', 'Edit(./.harness/state/**)', 'Edit(./.harness/logs/**)', 'Edit(./.claude/settings.json)',
    ]),
  );
});
