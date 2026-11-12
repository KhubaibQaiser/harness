import { expect, test } from 'vitest';
import { evalArgs, planLines } from '../../src/eval/run.js';
import type { CaseInfo } from '../../src/eval/build.js';

const o = { runs: 3, model: 'claude-x', maxCost: 2, out: '/o', scaffold: false, tools: [] as string[] };
const cases: CaseInfo[] = [
  { name: 'tdd-rules', kind: 'rules', variant: 'rules', rule: 'tdd' },
  { name: 'tdd-bare', kind: 'rules', variant: 'bare', rule: 'tdd' },
];

test('evalArgs has the fixed flags as an array', () => {
  const a = evalArgs('/d', o).join(' ');
  for (const s of ['plugin eval /d', '--ablation none', '--no-publish', '--trust-plugin', '--json /o/result.json', '--report /o/report.html', '--output-dir /o', '--model claude-x', '--max-cost-usd 2', '--runs 3']) expect(a).toContain(s);
  expect(a).not.toContain('--scaffold');
  expect(a).not.toContain('--allow-tools');
});

test('evalArgs adds scaffold and tool grants', () => {
  const a = evalArgs('/d', { ...o, scaffold: true, tools: ['Bash', 'Write', 'Edit'] }).join(' ');
  expect(a).toContain('--scaffold');
  expect(a).toContain('--allow-tools Bash Write Edit');
});

test('plan without an earlier result', () => {
  const p = planLines(cases, 3, 'claude-x', 2, null).join('\n');
  expect(p).toContain('No estimate yet; the $2 ceiling caps the spend');
  expect(p).toContain('judge calls: 0');
  expect(p).toContain('Spend can pass the ceiling by up to one agent run.');
  expect(p).toContain('claude-x');
  expect(p).toContain('agent runs: 6');
});

test('plan with an earlier result', () => {
  const p = planLines(cases, 3, 'claude-x', 2, { usd: 0.6, missing: [] }).join('\n');
  expect(p).toContain('Estimate from your last run: ~$0.60');
  expect(p).not.toContain('no estimate yet');
});

test('plan with history for some kinds names the ones without', () => {
  const p = planLines(cases, 3, 'claude-x', 2, { usd: 0.6, missing: ['gates', 'skills'] }).join('\n');
  expect(p).toContain('Estimate from your last run: ~$0.60, without gates, skills (no estimate yet; the $2 ceiling caps the spend)');
});
