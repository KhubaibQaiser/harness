import { expect, test } from 'vitest';
import type { Picks } from '../../src/ai/picks.js';
import { finalizeReport, validateReport } from '../../src/ai/report.js';

const S = "Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.";
const p = { catalog_version: 1, findings: [{ id: 'f1', severity: 'nit', title: 't' }], items: [] } as Picks;
const parts: Record<string, string> = {
  Findings: '## Findings\n- f1: something\n',
  Roadmap: '## Roadmap\n30 days: a. 60 days: b. 90 days: c.\n',
  'Deliberate exclusions': '## Deliberate exclusions\nnone\n',
  Limits: '## Limits\nOnly what was scanned.\n',
};
const md = (skip = ''): string => Object.entries(parts).filter(([k]) => k !== skip).map(([, v]) => v).join('\n');

test('a complete report passes', () => expect(validateReport(md(), p)).toEqual([]));
test.each(Object.keys(parts))('missing %s fails by name', (s) => expect(validateReport(md(s), p)).toEqual([`report: missing section "## ${s}"`]));
test('roadmap must mention 30, 60 and 90', () => {
  const bad = md().replace('60 days: b. ', '');
  expect(validateReport(bad, p)).toEqual(['report: "## Roadmap" must mention 60 days']);
});
test('a finding id absent from the report fails', () => expect(validateReport(md().replace('f1', 'x'), p)).toEqual(['report: finding "f1" is not in "## Findings"']));
test('finalizeReport adds the sentence once, under Limits', () => {
  const once = finalizeReport(md('Deliberate exclusions') + '\n## Deliberate exclusions\nnone\n');
  expect(once.split(S)).toHaveLength(2);
  expect(once.indexOf(S)).toBeGreaterThan(once.indexOf('## Limits'));
  expect(once.indexOf(S)).toBeLessThan(once.indexOf('## Deliberate exclusions'));
  expect(finalizeReport(once)).toBe(once);
});
