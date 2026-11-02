import * as realFs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { RETRY, renameWithRetry, resetRetryBudget, retryTransient, writeAtomic } from '../../src/core/atomic.js';
import { applyChanges, type FsLike } from '../../src/install/apply.js';
import { recordCliPath } from '../../src/core/cli-path.js';

const err = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
const saved = { ...RETRY };
let slept: number[] = [];
// Windows behaviour on every OS: the platform and the sleep are seams.
beforeEach(() => {
  slept = [];
  resetRetryBudget();
  Object.assign(RETRY, { platform: 'win32', sleep: (ms: number) => void slept.push(ms) });
});
afterEach(() => void Object.assign(RETRY, saved));

test('on Windows a transient EPERM/EACCES/EBUSY rename is retried with a short, growing, bounded backoff', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let n = 0;
    renameWithRetry('a', 'b', () => { if (n++ < 3) throw err(code); });
    expect(n).toBe(4);
  }
  expect(slept.slice(0, 3)).toEqual([5, 10, 20]);
  slept = [];
  let n = 0;
  expect(() => renameWithRetry('a', 'b', () => { n++; throw err('EPERM'); })).toThrow('EPERM'); // never silent
  expect(n).toBe(15);
  expect(Math.max(...slept)).toBe(250);
  expect(slept.reduce((a, b) => a + b, 0)).toBeLessThan(2500);
});

test('other errors, and any error off Windows, are thrown at once', () => {
  let n = 0;
  expect(() => renameWithRetry('a', 'b', () => { n++; throw err('ENOENT'); })).toThrow('ENOENT');
  expect(n).toBe(1);
  RETRY.platform = 'linux';
  n = 0;
  expect(() => renameWithRetry('a', 'b', () => { n++; throw err('EPERM'); })).toThrow('EPERM');
  expect(n).toBe(1);
  expect(slept).toEqual([]);
});

test('retryTransient retries a read the same way', () => {
  let n = 0;
  expect(retryTransient(() => { if (n++ < 2) throw err('EBUSY'); return 'ok'; })).toBe('ok');
  expect(n).toBe(3);
});

test('writeAtomic: a write survives transient rename errors whole; when retries run out it throws, removes its temp file and leaves the old file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-atomic-'));
  const f = join(dir, 's.json');
  writeFileSync(f, '{"old":true}');
  let fails = 3;
  const flaky = { ...realFs, renameSync: (a: realFs.PathLike, b: realFs.PathLike) => { if (fails-- > 0) throw err('EPERM'); realFs.renameSync(a, b); } };
  writeAtomic(f, JSON.stringify({ files: Array.from({ length: 2000 }, (_, i) => i) }), flaky);
  expect(JSON.parse(readFileSync(f, 'utf8')).files).toHaveLength(2000);
  fails = Infinity;
  expect(() => writeAtomic(f, '{"new":true}', flaky)).toThrow('EPERM');
  expect(readFileSync(f, 'utf8')).toContain('"files"'); // the last good content, never partial
  expect(readdirSync(dir).filter((x) => x.endsWith('.tmp'))).toEqual([]);
});

test('applyChanges retries a transient rename of a file it writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-atomic-apply-'));
  let fails = 2;
  const fs = { ...realFs, renameSync: (a: realFs.PathLike, b: realFs.PathLike) => { if (fails-- > 0) throw err('EBUSY'); realFs.renameSync(a, b); } } as FsLike;
  applyChanges(root, [{ kind: 'create', rel: 'a.txt', content: 'hello\n' }], '1.0.0', undefined, fs);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('hello\n');
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(true);
});

test('recording the CLI path never throws, even when every write fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-atomic-cli-'));
  realFs.mkdirSync(join(root, '.harness'));
  const cli = join(root, 'node_modules/@khubaibqaiser/harness/dist/cli.mjs');
  realFs.mkdirSync(join(cli, '..'), { recursive: true });
  writeFileSync(cli, '');
  realFs.mkdirSync(join(root, '.harness/state/cli-path'), { recursive: true }); // a directory where the file goes: the write fails
  expect(() => recordCliPath(root, cli)).not.toThrow();
});

// Round 12 N5: one retry budget per process (a hook), well under the 10 s hook timeout.
test('all retries in one process share a total wait budget, then errors are thrown at once', () => {
  resetRetryBudget(300);
  const always = () => { throw err('EPERM'); };
  expect(() => renameWithRetry('a', 'b', always)).toThrow('EPERM');
  const first = slept.reduce((a, b) => a + b, 0);
  expect(first).toBeLessThanOrEqual(300);
  slept = [];
  let n = 0;
  expect(() => renameWithRetry('a', 'b', () => { n++; throw err('EPERM'); })).toThrow('EPERM');
  expect(n).toBe(1); // budget spent: no more waiting
  resetRetryBudget();
});
test('the default budget is 3 s per process', () => {
  resetRetryBudget();
  for (let i = 0; i < 5; i++) expect(() => renameWithRetry('a', 'b', () => { throw err('EPERM'); })).toThrow();
  expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000);
  resetRetryBudget();
});
// N6: a failed temp write leaves no temp file.
test('writeAtomic removes its temp file when writing it fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-atomic-w-'));
  const f = join(dir, 'x.json');
  const broken = { ...realFs, writeFileSync: (p: realFs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView) => { realFs.writeFileSync(p, String(d).slice(0, 3)); throw err('ENOSPC'); } };
  expect(() => writeAtomic(f, '{"a":1}', broken)).toThrow('ENOSPC');
  expect(readdirSync(dir)).toEqual([]);
});
