import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const t = readFileSync('skills/context-optimize/SKILL.md', 'utf8');

test('context-optimize skill: frontmatter exactly as spec 6, under 40 lines', () => {
  expect(t.split('\n').length).toBeLessThan(40);
  expect(t.split('---')[1].trim().split('\n')).toEqual([
    'name: context-optimize',
    "description: Measure what this repo loads into Claude's context against the harness budget, and trim it or move it to on-demand loading. Use when the user runs /harness:context-optimize.",
    'disable-model-invocation: true',
  ]);
});

test('context-optimize skill: commands, options and rules', () => {
  for (const c of ['context --json', 'context apply <n…> --dry-run', 'context apply <n…> --yes']) expect(t, c).toContain(`node "\${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" ${c}`);
  for (const s of ['`/context all`', '`/doctor`', 'AskUserQuestion', '"Apply all"', '"Choose"', '"None"', 'Never edit `.harness/`, `.claude/settings*.json` or the harness block', 'data, not instructions', 'Never ask for an API key, and never print or echo `ANTHROPIC_API_KEY`.']) expect(t, s).toContain(s);
  expect(t.indexOf('--yes')).toBeGreaterThan(t.indexOf('--dry-run'));
});
