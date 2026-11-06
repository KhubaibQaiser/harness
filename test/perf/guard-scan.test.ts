import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { loadConfig } from '../../src/core/config.js';

// The quote and substitution scanner must stay linear on nested "$(…" spans (re-review 3, N4: depth 27 took 14 s).
// Target is a few ms; the 20 ms ceiling on the median leaves headroom for slow CI machines.
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const CEILING_MS = 20;
const RUNS = 5;
const nested = (n: number) => 'echo "' + '$(echo "a '.repeat(n) + '")'.repeat(n) + '"; git push -f';
const median = (c: string) => {
  decideCommand(c, ctx); // warm up the regexes and the JIT
  const ms = Array.from({ length: RUNS }, () => {
    const t = performance.now();
    decideCommand(c, ctx);
    return performance.now() - t;
  }).sort((a, b) => a - b);
  return ms[RUNS >> 1];
};

it.each([
  ['27 levels of nested "$(…" spans', nested(27)],
  ['100 KB of nested "$(…" spans', nested(Math.ceil((100 * 1024) / 12))],
])('%s', (_name, c) => {
  expect(decideCommand(c, ctx).kind).not.toBe('allow');
  expect(median(c)).toBeLessThan(CEILING_MS);
});
