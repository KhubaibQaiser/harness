import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const interview = read('skills/init/interview.md');
const init = read('skills/init/SKILL.md');
const update = read('skills/update/SKILL.md');

test('the interview asks for a named preset after scope and before the gaps', () => {
  const ask = interview.indexOf('Use a named preset?');
  expect(ask).toBeGreaterThan(interview.indexOf('Scope first'));
  expect(ask).toBeLessThan(interview.indexOf('Gaps:'));
  const line = interview.split('\n').find((l) => l.includes('Use a named preset?'))!;
  const none = line.indexOf('"No preset (neutral catalog, the default)" first');
  expect(none).toBeGreaterThan(line.indexOf('Use a named preset?'));
  expect(none).toBeLessThan(line.indexOf('harness preset list'));
  expect(line.indexOf('then each preset')).toBeGreaterThan(none);
});

test('init step 4 passes the preset and answers to select and names the preset rows', () => {
  const step = init.slice(init.indexOf('4. Select'), init.indexOf('5. Apply'));
  expect(step).toContain('--preset <id> --answers <answers.json>');
  expect(step).toMatch(/preset/i);
  expect(step).toContain('came from the preset');
});

test('the update skill says answering "No preset" turns it off', () => {
  expect(update).toMatch(/"No preset"[^\n]*(off|removes)/);
});

test('the skills stay within their length budget', () => {
  // Lengths on main before Task 8, plus the brief's 4 lines each; raise these only with the owner's say.
  const BASE = { init: 37, interview: 23 };
  expect(init.split('\n').length).toBeLessThanOrEqual(BASE.init + 4);
  expect(interview.split('\n').length).toBeLessThanOrEqual(BASE.interview + 4);
});
