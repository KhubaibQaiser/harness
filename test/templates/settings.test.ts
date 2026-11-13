import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const s = JSON.parse(readFileSync('templates/settings.fragment.json', 'utf8'));
const ARGS = ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'];
const BLOCK = ['PreToolUse', 'UserPromptSubmit', 'ConfigChange'];

test('hooks: events, matchers, exec form, timeouts and onFailure (spec section 2)', () => {
  expect(Object.keys(s.hooks)).toEqual(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'ConfigChange', 'Stop', 'SessionEnd', 'SessionStart']);
  expect(s.hooks.PreToolUse[0].matcher).toBe('Bash|PowerShell|Monitor|Read|Grep|Edit|Write|MultiEdit|NotebookEdit');
  expect(s.hooks.PostToolUse[0].matcher).toBe('Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit');
  expect(s.hooks.SessionStart[0].matcher).toBe('compact');
  for (const e of ['UserPromptSubmit', 'ConfigChange', 'Stop', 'SessionEnd']) expect(s.hooks[e][0]).not.toHaveProperty('matcher');
  for (const [event, groups] of Object.entries<any[]>(s.hooks)) {
    expect(groups).toHaveLength(event === 'PreToolUse' || event === 'PostToolUse' ? 2 : 1);
    expect(groups[0].hooks).toEqual([
      { type: 'command', command: 'node', args: ARGS, timeout: event === 'Stop' ? 600 : 10, ...(BLOCK.includes(event) ? { onFailure: 'block' } : {}) },
    ]);
  }
  // AskUserQuestion has its own group with no onFailure, so a broken dispatcher never blocks the agent's questions (fail-open:
  // a crashed PreToolUse saves no token, so nothing can clear at PostToolUse).
  for (const event of ['PreToolUse', 'PostToolUse']) {
    expect(s.hooks[event][1]).toEqual({ matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node', args: ARGS, timeout: 10 }] });
  }
});

test('permissions.deny is the spec section 2 list, in order', () => {
  const push = (tool: string) => [
    `${tool}(git push *--force*)`, `${tool}(git push * -f*)`, `${tool}(git push * +*)`,
    // `git push * -f*` needs a word between push and -f, so a leading -f or +ref (live check c6, 2026-11-11) needs its own rule.
    `${tool}(git push -f*)`, `${tool}(git push +*)`,
    `${tool}(git push * main)`, `${tool}(git push * main *)`, `${tool}(git push *:main*)`,
    `${tool}(git push * master)`, `${tool}(git push * master *)`, `${tool}(git push *:master*)`,
  ];
  expect(s.permissions.deny).toEqual([
    'Read(./.env)', 'Read(./.env.*)', 'Read(./**/.env)', 'Read(./**/.env.*)',
    'Edit(./.harness/hooks/**)', 'Edit(./.harness/state/**)', 'Edit(./.harness/logs/**)', 'Edit(./.harness/backup/**)',
    'Edit(./.harness/config.yaml)', 'Edit(./.harness/manifest.json)', 'Edit(./.harness/reviews/**)',
    'Edit(./.claude/settings.json)', 'Edit(./.claude/settings.local.json)',
    ...push('Bash'), ...push('PowerShell'),
  ]);
  expect(s.permissions.deny).toHaveLength(35);
});
