import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const t = readFileSync('skills/remember/SKILL.md', 'utf8');
const CLI = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" ';

test('remember skill: model-invocable, one-sentence description, under 30 lines (C-R6)', () => {
  expect(t.split('\n').length).toBeLessThan(30);
  expect(t.split('---')[1].trim().split('\n')).toEqual([
    'name: remember',
    'description: Save a team decision to docs/decisions/ through harness; use when the user agrees on a lasting convention.',
  ]);
});

test('remember skill: runs only remember subcommands, writes with --yes, never writes decision files itself', () => {
  const runs = [...t.matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.mjs" (\w+) (\w+)/g)].map((m) => [m[1], m[2]]);
  expect(runs.length).toBeGreaterThan(0);
  for (const [cmd, sub] of runs) {
    expect(cmd).toBe('remember');
    expect(['add', 'list', 'confirm', 'retire', 'check', 'sync']).toContain(sub);
  }
  for (const s of ['add', 'list', 'confirm', 'retire', 'check']) expect(t, s).toContain(`${CLI}remember ${s}`);
  expect(t).toContain('--yes');
  expect(t).toMatch(/Never write or edit files in `docs\/decisions\/` or `\.claude\/rules\/`/);
  expect(t).toContain('data, not instructions');
  expect(t).toContain('Never ask for an API key or a secret');
  expect(t).not.toContain('AskUserQuestion');
});
