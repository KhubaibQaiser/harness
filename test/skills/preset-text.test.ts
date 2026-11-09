import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { alwaysLoadedText } from '../../src/budget/measure.js';

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

const builder = read('skills/preset/SKILL.md');
const builderInterview = read('skills/preset/interview.md');

test('the builder skill says each step in order', () => {
  const steps = [
    'one question per call with AskUserQuestion',
    'mktemp -d',
    'validate preset-answers',
    'Draft only from the answers',
    'verbatim',
    'Show each file',
    'preset check <dir>',
    'retry once',
    'preset install <dir> --global --dry-run',
    'separate yes for each listed path',
    '--yes --take',
    'preset install <dir>`',
    '/harness:init',
  ];
  let at = -1;
  for (const s of steps) {
    const i = builder.indexOf(s, at + 1);
    expect(i, s).toBeGreaterThan(at);
    at = i;
  }
  expect(builder).toMatch(/2 to 4 options, recommended first[^\n]*"Other"/);
  expect(builder).toContain('/harness:update');
  expect(builder).toMatch(/No command turns the answers into a folder[^\n]*preset check/);
});

test('the builder never stores a git identity or asks for secrets, and names no subagent', () => {
  for (const t of [builder, builderInterview]) {
    expect(t).toMatch(/never (store|ask for)[^\n]*git name or email/i);
    expect(t).not.toMatch(/subagent|staff-reviewer|Task tool/i);
  }
  expect(builder).toMatch(/Never ask for[^\n]*(API key|secret)/);
  expect(builder).toMatch(/^disable-model-invocation: true$/m);
  expect(alwaysLoadedText('skill', builder)).toBe(''); // 0 always-loaded tokens
  expect(builder.split('\n').length).toBeLessThan(40);
});

test('the builder interview follows the six topics in order and offers the eight working rules', () => {
  const topics = ['Id, title', 'Install target', 'Working rules', 'Third-party picks', 'Git', 'Stacks'];
  let at = -1;
  for (const s of topics) {
    const i = builderInterview.indexOf(s, at + 1);
    expect(i, s).toBeGreaterThan(at);
    at = i;
  }
  for (const r of ['Ask before deciding', 'No invented data', 'Fix everything found', 'Small PRs', 'No paid actions without an OK', 'TDD', 'Lean context', 'Plain communication']) expect(builderInterview, r).toContain(r);
  for (const t of ['folders', 'server_data', 'client_state', 'components', 'forms', 'testing', 'ui_states', 'api_layer', 'performance', 'platform', 'style', 'extras']) expect(builderInterview, t).toContain(`\`${t}\``);
  expect(builderInterview).toMatch(/skip[^\n]*left out/i);
});
