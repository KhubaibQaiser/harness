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

test('kept results are frozen at every level, so a caller cannot change what the next caller gets', () => {
  const f = remember((c: string) => [{ name: c, lines: [1, 2] as [number, number] }, [c]] as const);
  const r = f('a') as unknown as [{ name: string; lines: number[] }, string[]];
  expect(() => { r[0].name = 'b'; }).toThrow(TypeError); // ESM is strict mode
  expect(() => { r[0].lines.push(3); }).toThrow(TypeError);
  expect(() => { r[1][0] = 'b'; }).toThrow(TypeError);
  expect(() => { (r as unknown[]).pop(); }).toThrow(TypeError);
  expect(f('a')).toEqual([{ name: 'a', lines: [1, 2] }, ['a']]);
});

test('freezing calls no getter: a lazy body stays unbuilt until read', () => {
  let built = 0;
  const f = remember((c: string) => [{ get text() { return (built++, c); } }]);
  const r = f('a');
  expect(built).toBe(0);
  expect(r[0].text).toBe('a');
  expect(built).toBe(1);
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
