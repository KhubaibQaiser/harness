import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { evalsSection, readEvalResults } from '../../src/report/evals.js';

const run = (s: number[]) => ({ aggregates: { score: 0 }, arms: { with: s.map((score) => ({ score })) } });
function put(name: string, body: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'evr-'));
  const d = join(root, '.harness/reports/evals', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'result.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return root;
}

test('pass^k needs every run at the threshold; delta is rules minus bare', () => {
  const root = put('2026-11-05-claude-x-rules', {
    costUsd: 0.5, threshold: 1,
    cases: [{ name: 'tdd-rules', ...run([1, 1, 1]) }, { name: 'tdd-bare', ...run([1, 0, 1]) }],
  });
  const [r] = readEvalResults(root);
  expect(r).toMatchObject({ date: '2026-11-05', model: 'claude-x', kind: 'rules', costUsd: 0.5 });
  expect(r!.cases.map((c) => c.passK)).toEqual([true, false]);
  expect(r!.cases[0]).toMatchObject({ variant: 'rules', rule: 'tdd' });
  expect(r!.deltaByRule).toEqual({ tdd: 1 });
});

test('passK is null when per-run scores are missing', () => {
  const root = put('2026-11-05-claude-x-skills', { cases: [{ name: 'a-pos1', aggregates: { score: 1 } }] });
  const [r] = readEvalResults(root);
  expect(r!.cases[0]!.passK).toBeNull();
});

test('malformed input is skipped calmly', () => {
  expect(readEvalResults(put('2026-11-05-claude-x-rules', '{nope'))).toEqual([]);
  expect(readEvalResults(put('bad-folder', { cases: [] }))).toEqual([]);
  expect(readEvalResults(put('2026-11-05-claude-x-rules', { cases: 'x' }))).toEqual([]);
});

test('html eval section names the model and escapes', () => {
  const evals = [{ date: '2026-11-05', model: 'claude-<b>x', kind: 'rules', cases: [{ name: '<i>', mean: 1, passK: true }], deltaByRule: {}, costUsd: null }];
  const html = evalsSection(evals as never);
  expect(html).toContain('claude-&lt;b&gt;x');
  expect(html).not.toContain('<b>x');
});

test('a case with no score at all is unavailable, never 0%', () => {
  const root = put('2026-11-05-claude-x-skills', { cases: [{ name: 'a-pos1' }] });
  const [r] = readEvalResults(root);
  expect(r!.cases[0]!.mean).toBeNull();
  const html = evalsSection([r!]);
  expect(html).toContain('unavailable');
  expect(html).not.toContain('0%');
});

test('partial results are flagged', () => {
  const [r] = readEvalResults(put('2026-11-05-claude-x-skills', { partial: true, cases: [] }));
  expect(r!.partial).toBe(true);
  expect(evalsSection([r!])).toContain('Partial result');
});

test('a rule named __proto__ keeps its delta', () => {
  const root = put('2026-11-05-claude-x-rules', { cases: [{ name: '__proto__-rules', ...run([1]) }, { name: '__proto__-bare', ...run([0]) }] });
  expect(Object.entries(readEvalResults(root)[0]!.deltaByRule)).toEqual([['__proto__', 1]]);
});
