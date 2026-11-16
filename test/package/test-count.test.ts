import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

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

test('the committed floor is a number per project and ci runs the check after the tests', () => {
  const floor = JSON.parse(readFileSync('.github/test-floor.json', 'utf8')).darwin;
  expect(Object.keys(floor).sort()).toEqual(['e2e', 'unit']);
  for (const n of Object.values(floor)) expect(Number.isInteger(n) && (n as number) > 0).toBe(true);
  const raw = readFileSync('.github/workflows/ci.yml', 'utf8');
  const test_ = raw.slice(raw.indexOf('  test:'), raw.indexOf('  stop-srt:'));
  expect(test_.indexOf('node scripts/check-test-count.mjs')).toBeGreaterThan(test_.indexOf('run: pnpm test\n'));
  expect(raw.slice(raw.indexOf('  stop-srt:'))).not.toContain('check-test-count');
});
