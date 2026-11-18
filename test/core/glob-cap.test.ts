// picomatch <= 4.0.7 has an extglob ReDoS with no fixed version (GHSA-fc5q-39xc-vjpf). A glob from agent text is
// compiled only when small; a risky one is never compiled and counts as a match, so the gate asks or denies.
import { expect, test } from 'vitest';
import { riskyGlob } from '../../src/core/paths.js';
import '../../src/checks/guard.js'; // load order: guard-readings and guard import each other
import { globReadings } from '../../src/checks/guard-readings.js';
import { globHits } from '../../src/checks/decisions-protect.js';
import { skillSpecs } from '../../src/report/metrics/skills.js';

const SLOW = ['+(a)'.repeat(12), '+(*)'.repeat(10), `${'+(*)'.repeat(12)}.json`, 'a'.repeat(257) + '*'];
const fast = <T>(f: () => T): T => {
  const t = Date.now();
  const r = f();
  expect(Date.now() - t).toBeLessThan(200);
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

test('report: a normal paths glob is matched as before', () => {
  const [normal] = skillSpecs('/r', [{ name: 'b', paths: ['src/**/*.ts'] }], [], []);
  expect(normal!.label).toBe('paths');
  expect(normal!.relevant!(['/r/src/a.ts'])).toBe(true);
  expect(normal!.relevant!(['/r/docs/a.md'])).toBe(false);
});
