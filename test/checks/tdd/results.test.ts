import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readResults, relatedTests, type TestFileResult } from '../../../src/checks/tdd/results.js';

const fx = (n: string) => readFileSync(join(import.meta.dirname, '../../fixtures/results', n), 'utf8').replaceAll('/ROOT', root);
const root = mkdtempSync(join(tmpdir(), 'res-'));
const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(join(root, 'd-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
};

test('vitest and jest fixtures parse to the same structure', () => {
  const v = readResults(root, dir({ 'v.json': fx('vitest.json') }));
  const j = readResults(root, dir({ 'j.json': fx('jest.json') }));
  const strip = (r: TestFileResult[]) => r.map(({ writtenAt: _w, ...x }) => x);
  expect(strip(v)).toEqual([
    { file: 'src/a.test.ts', status: 'failed', tests: [{ fullName: 'adds', status: 'passed' }, { fullName: 'fails', status: 'failed' }] },
  ]);
  expect(strip(j)).toEqual(strip(v));
  expect(v[0]!.writtenAt).toBeGreaterThan(0);
});

test('skips malformed and unreadable files, missing dir gives []', () => {
  const d = dir({ 'bad.json': '{nope', 'odd.json': '{"testResults":5}', 'ok.json': fx('jest.json') });
  mkdirSync(join(d, 'sub.json'));
  expect(readResults(root, d).map((r) => r.file)).toEqual(['src/a.test.ts']);
  expect(readResults(root, join(root, 'missing'))).toEqual([]);
});

test('skips results outside the root; reads one file per package', () => {
  const out = JSON.stringify({ testResults: [{ name: '/elsewhere/x.test.ts', status: 'passed', assertionResults: [] }] });
  const pkg = (p: string) => JSON.stringify({ testResults: [{ name: `${root}/${p}/a.test.ts`, status: 'passed', assertionResults: [] }] });
  const r = readResults(root, dir({ 'out.json': out, 'a.json': pkg('pkgA'), 'b.json': pkg('pkgB') }));
  expect(r.map((x) => x.file).sort()).toEqual(['pkgA/a.test.ts', 'pkgB/a.test.ts']);
});

test('relatedTests finds colocated and __tests__ tests', () => {
  const t = (file: string): TestFileResult => ({ file, status: 'passed', tests: [], writtenAt: 1 });
  const all = [t('src/foo.test.ts'), t('src/__tests__/foo.test.ts'), t('src/bar.test.ts')];
  expect(relatedTests(root, 'src/foo.ts', all).map((x) => x.file)).toEqual(['src/foo.test.ts', 'src/__tests__/foo.test.ts']);
});
