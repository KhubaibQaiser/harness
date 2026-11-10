import { expect, test } from 'vitest';
import { pieces, remember, WORK_BUDGET_CHARS, WorkBudget, withWorkBudget, workSpent } from '../../src/core/shell-words.js';

// Round 28: a kept result charges the run what computing it cost, so the work budget stops where it did uncached.
test('remember returns the kept result and charges its work again', () => {
  let calls = 0;
  const f = remember((c: string) => (calls++, pieces(c).length));
  const spent = withWorkBudget(() => { f('a; b'); const one = workSpent(); f('a; b'); return [one, workSpent()]; });
  expect(calls).toBe(1);
  expect(spent).toEqual([4, 8]);
});

test('a kept result still throws WorkBudget once the run passes the budget', () => {
  const f = remember((c: string) => pieces(c).length);
  const big = 'x'.repeat(WORK_BUDGET_CHARS / 2 + 1);
  expect(() => withWorkBudget(() => { f(big); f(big); })).toThrow(WorkBudget);
});

test('a result kept outside a run is computed again inside one, and the variant picks its own set', () => {
  let calls = 0, v = 0;
  const f = remember((c: string) => (calls++, pieces(c).length + v * 10), () => v);
  f('a');
  withWorkBudget(() => f('a'));
  expect(calls).toBe(2);
  v = 1;
  expect(f('a')).toBe(11);
});
