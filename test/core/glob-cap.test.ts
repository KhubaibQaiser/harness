// picomatch <= 4.0.7 has an extglob ReDoS with no fixed version (GHSA-fc5q-39xc-vjpf). A glob from agent text is
// compiled only when small; a risky one is never compiled and counts as a match, so the gate asks or denies.
import { expect, test } from 'vitest';
import { riskyGlob } from '../../src/core/paths.js';
import '../../src/checks/guard.js'; // load order: guard-readings and guard import each other
import { globReadings } from '../../src/checks/guard-readings.js';
import { globHits } from '../../src/checks/decisions-protect.js';
import { OVER_BUDGET, skillSpecs, skillsAcc, TOO_COMPLEX } from '../../src/report/metrics/skills.js';

const SLOW = ['+(a)'.repeat(12), '+(*)'.repeat(10), `${'+(*)'.repeat(12)}.json`, 'a'.repeat(257) + '*'];
// A hang check, not a speed test: the measured hangs ran 3 s or more; shared CI runners are slow, so the bound is loose.
const fast = <T>(f: () => T, ms = 1000): T => {
  const t = Date.now();
  const r = f();
  expect(Date.now() - t).toBeLessThan(ms);
  return r;
};

test('riskyGlob: over 3 extglob groups or over 256 characters', () => {
  for (const g of SLOW) expect(riskyGlob(g), g).toBe(true);
  for (const g of ['*.ts', 'src/**/*.test.ts', '@(a|b)', '+(a)+(b)!(c)', 'g?t', '{a,b}/*', '[!x]*', 'a'.repeat(256)]) expect(riskyGlob(g), g).toBe(false);
});

test('guard: a risky command-position glob is read as capped (the guard asks), fast', () => {
  // the guard reads a command word as a glob only with * ? [ or {; +(a)… alone is never compiled there
  for (const g of SLOW) expect(fast(() => globReadings(`${g} x`)).capped, g).toBe(/[*?[{]/.test(g));
  expect(globReadings('g?t push').texts).toContain('git push'); // a normal glob still expands as before
});

test('decisions-protect: a risky glob hits, fast; a normal one is matched as before', () => {
  for (const g of SLOW) expect(fast(() => globHits('/r', `/r/${g}`, ['docs/decisions'])), g).toBe(true);
  expect(globHits('/r', '/r/docs/dec*', ['docs/decisions'])).toBe(true);
  expect(globHits('/r', '/r/src/*.ts', ['docs/decisions'])).toBe(false);
});

test('report: any extglob or more than 2 star runs in a segment is unmeasured, never compiled, and returns fast on long paths', () => {
  const long = ['/r/' + 'a'.repeat(4096), '/r/' + 'a'.repeat(24) + '/x.ts', '/r/' + 'a'.repeat(40) + '.ts'];
  // the reviewer's bypasses of the hook cap: 2 groups, and no extglob at all
  for (const g of ['+(*)+(*)', '*a'.repeat(14) + 'b', '+(a)', '@(x)', 'src/*a*a*b.ts']) {
    const [spec] = skillSpecs('/r', [{ name: 's', paths: ['src/**/*.ts', g] }], [], []);
    expect(spec!.label, g).toBe('unmeasured (pattern too complex)');
    expect(spec!.relevant, g).toBeNull();
  }
  // under the bound: compiled, and still fast on long one-character paths
  const [ok] = skillSpecs('/r', [{ name: 's', paths: ['a*a*b', '**/*.ts', 'src/**/*.test.*', '*.{ts,tsx}'] }], [], []);
  expect(ok!.label).toBe('paths');
  expect(fast(() => ok!.relevant!(long))).toBe(true);
  expect(ok!.relevant!(['/r/' + 'a'.repeat(4096) + 'b'])).toBe(false); // a path over 512 characters is never matched
});

test('report: more than 2 globstars (anywhere, braces included) is unmeasured, and returns fast on a deep path', () => {
  const deep = ['/r/' + 'a/'.repeat(255)];
  for (const g of ['**/a/**/a/**/a/**/b', '**/a/**/a/**/a/**/a/**/b', '**/*/**/*/**/*/**/*/**/b', '**/*a*/**/*a*/**/*a*/**/*a*/**/b', 'src/**/*a*/**/*a*/**/*a*/**/b', 'a**/a**/a**/b', '{**/a,**/b}/**/c']) {
    const [spec] = skillSpecs('/r', [{ name: 's', paths: [g] }], [], []);
    expect(spec!.label, g).toBe(TOO_COMPLEX);
    expect(spec!.relevant, g).toBeNull();
  }
  // a real 2-globstar glob stays measured, and fast on the same deep path
  for (const g of ['src/**/a*a/**/*.test.ts', '**/*a*/**/*a*b', '**/a/**/b']) {
    const [ok] = skillSpecs('/r', [{ name: 's', paths: [g] }], [], []);
    expect(ok!.label, g).toBe('paths');
    expect(fast(() => ok!.relevant!(deep)), g).toBe(false);
  }
});

test('report: more than 4 star runs across the whole glob (braces included) is unmeasured; real globs stay measured and fast', () => {
  const deep = ['/r/' + ('a'.repeat(50) + '/').repeat(10), '/r/' + 'a/'.repeat(255)];
  for (const g of ['*a*/'.repeat(5) + 'b', '{a,*}/'.repeat(40), 'src/*a*/*a*/*a*/*a*/*.ts']) {
    const [spec] = skillSpecs('/r', [{ name: 's', paths: [g] }], [], []);
    expect(spec!.label, g).toBe(TOO_COMPLEX);
    expect(spec!.relevant, g).toBeNull();
  }
  for (const g of ['src/**/*.test.*', '**/*.{ts,tsx}', '*a*/**/*a*/**/b', '**/*a*a/**/*a*a/b']) {
    const [ok] = skillSpecs('/r', [{ name: 's', paths: [g] }], [], []);
    expect(ok!.label, g).toBe('paths');
    fast(() => ok!.relevant!(deep), 2000); // 2-42 ms alone; slack for a loaded or Windows runner, still below the 3 s hangs
  }
});

test('report: skill matching stops after its time budget and labels the rest unmeasured', () => {
  let t = 0;
  const clock = () => t;
  const specs = skillSpecs('/r', [{ name: 'slow', paths: ['src/**'] }, { name: 'later', paths: ['src/**'] }], [], []);
  specs[0]!.relevant = () => ((t += 2500), true); // one match that spends the whole budget
  const acc = skillsAcc(specs, { budgetMs: 2000, now: clock });
  acc.endSession!({ id: 's1', turns: 1, compactions: 0, edited: ['/r/src/a.ts'] });
  acc.endSession!({ id: 's2', turns: 1, compactions: 0, edited: ['/r/src/a.ts'] });
  const rows = Object.fromEntries(acc.result().map((r) => [r.name, r]));
  expect(rows.slow!.label).toBe(OVER_BUDGET);
  expect(rows.later!.label).toBe(OVER_BUDGET);
  expect(rows.later!.relevantIn).toBe(0); // never matched once the budget ran out
});

test('report: more than 16 paths globs in one skill is unmeasured', () => {
  const [many] = skillSpecs('/r', [{ name: 's', paths: Array.from({ length: 17 }, (_, i) => `src/${i}/*.ts`) }], [], []);
  expect(many!.label).toBe(TOO_COMPLEX);
  const [ok] = skillSpecs('/r', [{ name: 's', paths: Array.from({ length: 16 }, (_, i) => `src/${i}/*.ts`) }], [], []);
  expect(ok!.label).toBe('paths');
});

test('report: the budget is checked between paths, so 1000 slow-shaped paths and 8 patterns stop right after the budget (fake clock)', () => {
  const pats = ['*a*/**/*a*/**/b', '**/*a*/*a*/**/b', '*a*/**/*a*/**/c', '**/*a*/*a*/**/c', '*a*/**/*a*/**/d', '**/*a*/*a*/**/d', '*a*/**/*a*/**/e', '**/*a*/*a*/**/e'];
  const edited = Array.from({ length: 1000 }, (_, i) => `/r/${('a'.repeat(50) + '/').repeat(9)}${'a'.repeat(40)}${i}`);
  const specs = skillSpecs('/r', [{ name: 'slow', paths: pats }, { name: 'next', paths: pats }, { name: 'none' }], [], []);
  expect(specs[0]!.label).toBe('paths');
  // fake clock: each path checked costs 10 ms, so the run is the same on any machine
  let t = 0, checked = 0;
  for (const sp of specs) {
    const real = sp.relevant;
    if (real) sp.relevant = (ps, stop) => real(ps, () => (checked++, (t += 10), stop!()));
  }
  const acc = skillsAcc(specs, { budgetMs: 15, now: () => t }); // small, so one real slow-shaped match runs (about 0.3-0.7 s here)
  const wall = Date.now();
  for (let i = 0; i < 3; i++) acc.endSession!({ id: `s${i}`, turns: 1, compactions: 0, edited });
  expect(Date.now() - wall).toBeLessThan(10_000); // a hang check only; the fake clock below is the real assertion
  // the first skill matches one path, then stops on the next check (20 ms > 15 ms); nothing else is ever matched
  expect(checked).toBe(2);
  const rows = Object.fromEntries(acc.result().map((r) => [r.name, r]));
  expect([rows.slow!.label, rows.next!.label, rows.none!.label]).toEqual([OVER_BUDGET, OVER_BUDGET, 'none']);
  expect([rows.slow!.relevantIn, rows.next!.relevantIn]).toEqual([0, 0]);
});

test('report: a skill cut off by the budget feeds no counts, so it stays out of the chart and totals', () => {
  let t = 0;
  const specs = skillSpecs('/r', [{ name: 'a', paths: ['src/**'] }], [], []);
  const real = specs[0]!.relevant!;
  let calls = 0;
  specs[0]!.relevant = (ps, stop) => (++calls === 2 ? (t += 2500) : 0, real(ps, stop));
  const acc = skillsAcc(specs, { budgetMs: 2000, now: () => t });
  const use = { k: 'assistant', side: false, ts: 0, tools: [{ name: 'Skill', skill: 'a' }] } as never;
  for (let i = 0; i < 3; i++) {
    const s = { id: `s${i}`, turns: 1, compactions: 0, edited: ['/r/src/a.ts'] };
    acc.rec!(s, { k: 'listing', side: false, names: ['a'] } as never);
    acc.rec!(s, use);
    acc.endSession!(s);
  }
  const [row] = acc.result();
  expect(row!.label).toBe(OVER_BUDGET);
  expect([row!.relevantIn, row!.invokedRelevant, row!.invokedOther]).toEqual([0, 0, 0]); // the first session's counts are dropped too
  expect([row!.sessions, row!.sessionsWithListing, row!.listedIn]).toEqual([3, 3, 3]); // listing counts keep going after the cut-off, so "Listed in" is complete
});

test('report: a normal paths glob is matched as before', () => {
  const [normal] = skillSpecs('/r', [{ name: 'b', paths: ['src/**/*.ts'] }], [], []);
  expect(normal!.label).toBe('paths');
  expect(normal!.relevant!(['/r/src/a.ts'])).toBe(true);
  expect(normal!.relevant!(['/r/docs/a.md'])).toBe(false);
});
