import { rmSync } from 'node:fs';
import { afterAll, expect, test } from 'vitest';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { diffTamper } from '../../src/done/tamper-diff.js';
import { repoWith } from '../review/repo.js';

// verify runs this on every task: git spawns must not grow with the number of package.json files.
const pkgs = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`pkgs/p${i}/package.json`, JSON.stringify({ name: `p${i}`, scripts: { test: `vitest --config ci${i}.ts` } })]));
const r = repoWith({ ...pkgs, 'src/a.ts': 'a\n' }, { 'src/a.ts': 'b\n' });
afterAll(() => rmSync(r.root, { recursive: true, force: true }));

test('300 package.json files and a one-line source change: at most 3 git spawns per side, under 1.5 s', () => {
  let spawns = 0;
  const ex: Exec = (c, a, x) => { spawns++; return defaultExec(c, a, x); };
  const t0 = performance.now();
  const res = diffTamper(r.root, ex, r.base, r.head, {});
  const ms = performance.now() - t0;
  expect(res.findings).toEqual([]);
  expect(spawns).toBeLessThanOrEqual(6);
  expect(ms, `diffTamper took ${ms.toFixed(0)} ms`).toBeLessThan(1500);
});
