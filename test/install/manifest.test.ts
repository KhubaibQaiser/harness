import { expect, test } from 'vitest';
import { renameRecorded } from '../../src/install/manifest.js';

const F = '.harness/state/test-results/root.json', T = '.harness/results/root.json';

test('renameRecorded rewrites a block that holds the old path', () => {
  const r = renameRecorded({ rel: 'package.json', kind: 'update', hash: 'h', blocks: [` --outputFile=${F}`, ' other'] }, F, T);
  expect(r).toEqual({ found: true, entry: { rel: 'package.json', kind: 'update', hash: 'h', blocks: [` --outputFile=${T}`, ' other'] } });
});

test("renameRecorded rewrites a hunk's from and leaves its to", () => {
  const r = renameRecorded({ rel: 'v.ts', kind: 'update', hash: 'h', replace: [{ from: `json: '${F}'\n`, to: `x '${F}'\n` }], formatted: true }, F, T);
  expect(r.found).toBe(true);
  expect(r.entry.replace).toEqual([{ from: `json: '${T}'\n`, to: `x '${F}'\n` }]);
});

test('renameRecorded leaves an entry without the old path unchanged', () => {
  const e = { rel: 'v.ts', kind: 'update' as const, hash: 'h', blocks: ['a'], replace: [{ from: 'b', to: 'c' }] };
  expect(renameRecorded(e, F, T)).toEqual({ found: false, entry: e });
});
