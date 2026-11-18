import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { loadConfig } from '../../src/core/config.js';
import { medianOf } from './overhead.js';

// The gh allow-list walks every segment of a line that names gh or hub. It must stay linear: the whole-line test for a
// run-time-built GraphQL query runs once per line, not once per segment (a 84 KB line took 207 ms when it did).
// Target about 50 ms on a laptop; the ceilings leave room for slow CI machines. Each case takes the median of 5 after a
// warm-up (it was one sample). The ceiling has not failed in CI (9-16 Nov), but the gh allow-list (#217, 13 Nov) doubled
// these cases on a laptop (1500 graphql reads 16-21 to 40-46 ms), so the margin is smaller than it was.
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const time = (name: string, c: string) => {
  const { ms, result } = medianOf(`gh-writes ${name}`, () => decideCommand(c, ctx), 5, true);
  return { kind: result.kind, ms };
};

it.each([
  ['1500 gh api graphql reads', Array(1500).fill("gh api graphql -f query='query { viewer { login } }'").join(' && '), 'allow'],
  ['2000 gh reads', Array(2000).fill('gh pr view 1 --json title').join(' ; '), 'allow'],
  ['2000 gh and hub reads mixed with git', Array(2000).fill('git status; gh run list; hub browse').join(' ; '), 'allow'],
] as const)('%s', (name, c, want) => {
  const { kind, ms } = time(name, c);
  expect(kind).toBe(want);
  expect(ms).toBeLessThan(150);
});
