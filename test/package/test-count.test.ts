import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const file = (name: string, passed: number, extra: object = {}) => ({ name, status: 'passed', assertionResults: Array.from({ length: passed }, () => ({ status: 'passed' })), ...extra });
const run = (files: object[], floor: object, platform = 'darwin') => {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'));
  writeFileSync(join(dir, 'r.json'), JSON.stringify({ testResults: files }));
  writeFileSync(join(dir, 'f.json'), JSON.stringify({ darwin: floor, win32: { unit: 1 } }));
  const r = spawnSync('node', ['scripts/check-test-count.mjs', join(dir, 'r.json'), join(dir, 'f.json'), platform], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('passes at the floor and above, counting per project by path', () => {
  const files = [file('/r/test/core/a.test.ts', 3), file('/r/test/e2e/b.test.ts', 2), file('C:\\r\\test\\e2e\\c.test.ts', 1)];
  expect(run(files, { unit: 3, e2e: 3 }).code).toBe(0);
  expect(run(files, { unit: 2, e2e: 1 }).code).toBe(0);
});

test('fails below the floor and names the project and counts', () => {
  const r = run([file('/r/test/core/a.test.ts', 3), file('/r/test/e2e/b.test.ts', 2)], { unit: 3, e2e: 3 });
  expect(r.code).toBe(1);
  expect(r.out).toContain('e2e: 2 passed, floor is 3');
  expect(r.out).not.toContain('unit:');
});

test('fails when a test file reports a load error, even above the floor', () => {
  const bad = { name: '/r/test/core/broken.test.ts', status: 'failed', message: 'Cannot find module x', assertionResults: [] };
  const r = run([file('/r/test/core/a.test.ts', 5), bad], { unit: 1 });
  expect(r.code).toBe(1);
  expect(r.out).toContain('load error: /r/test/core/broken.test.ts');
});

test('a malformed report fails instead of passing', () => {
  expect(run([], { unit: 1 }).code).toBe(1);
});

test('the floor is looked up by platform, and a platform without one fails clearly', () => {
  const files = [file('/r/test/core/a.test.ts', 2)];
  expect(run(files, { unit: 9 }, 'win32').code).toBe(0); // win32's floor is 1
  const r = run(files, { unit: 1 }, 'linux');
  expect(r.code).toBe(1);
  expect(r.out).toContain('no floor for linux');
});

// CI shards a platform's suite; the floor job downloads every shard's report into one directory and checks their sum.
const runShards = (shards: object[][], floor: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'));
  shards.forEach((files, i) => { mkdirSync(join(dir, 'r', `test-report-${i}`), { recursive: true }); writeFileSync(join(dir, 'r', `test-report-${i}`, 'test-report.json'), JSON.stringify({ testResults: files })); });
  writeFileSync(join(dir, 'f.json'), JSON.stringify({ darwin: floor }));
  const r = spawnSync('node', ['scripts/check-test-count.mjs', join(dir, 'r'), join(dir, 'f.json'), 'darwin'], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('a directory of shard reports is summed, and one shard alone fails the full floor', () => {
  const a = [file('/r/test/core/a.test.ts', 3)];
  const b = [file('/r/test/core/b.test.ts', 4), file('/r/test/e2e/c.test.ts', 2)];
  expect(runShards([a, b], { unit: 7, e2e: 2 }).code).toBe(0);
  const one = runShards([b], { unit: 7, e2e: 2 });
  expect(one.code).toBe(1);
  expect(one.out).toContain('unit: 4 passed, floor is 7');
});

test('a test file in two reports fails instead of counting twice', () => {
  const a = [file('/r/test/core/a.test.ts', 4)];
  const r = runShards([a, a], { unit: 8 });
  expect(r.code).toBe(1);
  expect(r.out).toContain('in more than one report: /r/test/core/a.test.ts');
});

test('an empty report directory fails', () => {
  expect(runShards([], { unit: 1 }).code).toBe(1);
});

test('the committed floor is a number per project and ci checks it once per platform, over every shard, after the tests', () => {
  const floor = JSON.parse(readFileSync('.github/test-floor.json', 'utf8')).darwin;
  expect(Object.keys(floor).sort()).toEqual(['e2e', 'unit']);
  for (const n of Object.values(floor)) expect(Number.isInteger(n) && (n as number) > 0).toBe(true);
  const jobs = parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs;
  const checks = Object.entries(jobs).filter(([, j]: any) => JSON.stringify(j.steps).includes('check-test-count')).map(([n]) => n);
  expect(checks).toEqual(['test-floor']); // never inside a shard, which would check a part of the suite
  const floor_ = jobs['test-floor'];
  expect(floor_.needs).toBe('test');
  expect(floor_.if).toBe('${{ !cancelled() }}');
  expect(floor_.strategy.matrix.include.map((m: any) => m.platform)).toEqual(['darwin', 'win32']);
  expect(floor_.steps.find((s: any) => /download-artifact@/.test(s.uses ?? '')).with.pattern).toBe('test-report-${{ matrix.os }}-*');
  expect(floor_.steps.at(-1).run).toBe('node scripts/check-test-count.mjs reports .github/test-floor.json ${{ matrix.platform }}');
  const up = jobs.test.steps.find((s: any) => /upload-artifact@/.test(s.uses ?? ''));
  expect(up.with).toMatchObject({ name: 'test-report-${{ matrix.os }}-${{ strategy.job-index }}', path: 'node_modules/.cache/test-report.json', 'if-no-files-found': 'error', 'include-hidden-files': true });
});
