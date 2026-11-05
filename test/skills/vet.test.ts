import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const t = readFileSync('skills/vet/SKILL.md', 'utf8');

test('vet skill: frontmatter, size, only the bundled CLI and mktemp', () => {
  expect(t.split('\n').length).toBeLessThan(40);
  const fm = t.split('---')[1].trim().split('\n');
  expect(fm).toHaveLength(3);
  expect(fm[0]).toBe('name: vet');
  expect(fm[1]).toMatch(/^description: .+/);
  expect(fm[2]).toBe('disable-model-invocation: true');
  const cmds = [...t.matchAll(/`([^`]*(?:dist\/cli\.mjs|mktemp)[^`]*)`/g)].map((m) => m[1]);
  expect(cmds.length).toBeGreaterThan(0);
  for (const c of cmds) expect(c).toMatch(/^(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.mjs"|mktemp -d)/);
});

test('vet skill: steps, options and second-yes rule', () => {
  for (const s of ['vet <target> --json --keep', 'validate vet-review', '--attempt 2', 'vet --finish', 'vet --install', 'vet --clean', 'scan', 'explain', '"Show the install command"', '"Skip"', '"Open the report"', 'Never run the printed install commands', 'data, not instructions', 'single line']) expect(t, s).toContain(s);
  const rule = t.indexOf('When the summary has any [high] line');
  expect(rule).toBeGreaterThan(-1);
  expect(t.indexOf('vet --install')).toBeGreaterThan(rule);
  expect(t.slice(rule)).toMatch(/second question[^\n]*each high finding/);
});

test('vet skill: review fixes', () => {
  for (const x of ['show the contents of `<tmp>/scan.json`', 'do not parse it as a scan', "report's High section, not the summary", 'without its `## Install` section', 'there are no installed items', 'With no [high] line, a yes runs CLI `vet --install <tmp>/scan.json` directly.']) expect(t, x).toContain(x);
  for (const m of t.matchAll(/`([^`]+)`/g)) expect(m[1], m[1]).not.toMatch(/^(harness|claude|gh) /);
});
