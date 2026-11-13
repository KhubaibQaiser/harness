import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { loadConfig } from '../../src/core/config.js';

// The gh allow-list walks every segment of a line that names gh or hub. It must stay linear: the whole-line test for a
// run-time-built GraphQL query runs once per line, not once per segment (a 84 KB line took 207 ms when it did).
// Target about 50 ms on a laptop; the ceilings leave room for slow CI machines.
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const time = (c: string) => {
  decideCommand(c, ctx); // warm up
  const t = performance.now();
  const d = decideCommand(c, ctx);
  return { kind: d.kind, ms: performance.now() - t };
};

it.each([
  ['1500 gh api graphql reads', Array(1500).fill("gh api graphql -f query='query { viewer { login } }'").join(' && '), 'allow'],
  ['2000 gh reads', Array(2000).fill('gh pr view 1 --json title').join(' ; '), 'allow'],
  ['2000 gh and hub reads mixed with git', Array(2000).fill('git status; gh run list; hub browse').join(' ; '), 'allow'],
] as const)('%s', (_name, c, want) => {
  const { kind, ms } = time(c);
  expect(kind).toBe(want);
  expect(ms).toBeLessThan(150);
});
