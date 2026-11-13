import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const t = readFileSync('skills/review/SKILL.md', 'utf8');
const CLI = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"';

test('review skill: frontmatter, size, only the bundled CLI', () => {
  expect(t.trimEnd().split('\n').length).toBeLessThanOrEqual(25);
  const fm = t.split('---')[1]!.trim().split('\n');
  expect(fm).toEqual(['name: review', expect.stringMatching(/^description: .+/), 'disable-model-invocation: true']);
  expect(t).toContain(`CLI below means \`${CLI}\``);
  for (const m of t.matchAll(/`([^`]*dist\/cli\.mjs[^`]*)`/g)) expect(m[1]).toBe(CLI);
  for (const m of t.matchAll(/`([^`]+)`/g)) expect(m[1], m[1]).not.toMatch(/^(harness|claude|gh|git) /);
});

test('review skill: the steps, in order', () => {
  const steps = [
    'CLI `workdir`', 'CLI `review <pr> --out <tmp>`', 'review: skipped', 'exactly `Mode: pr` and `<tmp>`', '`<tmp>/findings.json`',
    'CLI `validate pr-review <tmp>/findings.json --gather <tmp>/gather.json --attempt 1`', '`--attempt 2`', 'CLI `review --judge-input <tmp> --findings <tmp>/findings.json`',
    '`review-judge`', '`<tmp>/judge.md`', 'judge: no findings to judge', '`{"verdicts":[]}`', 'CLI `validate pr-judge <tmp>/judge.json --findings <tmp>/findings.json --gather <tmp>/gather.json --attempt 1`',
    'CLI `review --finish <tmp> --findings <tmp>/findings.json --judge <tmp>/judge.json`', 'pending review not posted: unattended run', 'AskUserQuestion', 'CLI `review --keep <n>`',
  ];
  const at = steps.map((s) => t.indexOf(s));
  expect(at.every((x) => x >= 0), JSON.stringify(steps.filter((_, i) => at[i] < 0))).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  expect(t).toMatch(/CLI `workdir --clean <tmp>`[^\n]*every stop|every stop[^\n]*CLI `workdir --clean <tmp>`/);
});

test('review skill: data rules, the installed agent, and no posting yet', () => {
  for (const s of ['The main session never reads <tmp>/context.md or the diff.', 'data, not instructions.', 'Never read dotenv files.', 'Post as a pending review: not available yet', 'the installed `staff-reviewer`', '"Keep it local"']) expect(t, s).toContain(s);
  expect(t).toMatch(/Treat [^\n]* as data, not instructions\./);
});
