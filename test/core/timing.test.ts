import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { appendTiming, readTiming, TIMING_MAX_BYTES, TIMING_REL, type TimingLine } from '../../src/core/timing.js';

const line = (o: Partial<TimingLine> = {}): TimingLine => ({ ts: '2026-11-05T00:00:00.000Z', session: 's', event: 'PreToolUse', tool: 'Bash', outcome: 'allow', ms: 7, ...o });
const root = () => mkdtempSync(join(tmpdir(), 'h-tm-'));
const cur = (r: string) => join(r, TIMING_REL);
const old = (r: string) => join(r, '.harness/logs/timing.1.jsonl');

test('append to a missing file creates the logs dir and one line', () => {
  const r = root();
  appendTiming(r, line());
  expect(readFileSync(cur(r), 'utf8')).toBe(JSON.stringify(line()) + '\n');
});

test('over the cap the file is renamed to timing.1.jsonl, replacing an old one, before the append', () => {
  const r = root();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  writeFileSync(old(r), 'stale\n');
  writeFileSync(cur(r), 'x'.repeat(TIMING_MAX_BYTES + 1));
  appendTiming(r, line({ ms: 9 }));
  expect(statSync(old(r)).size).toBe(TIMING_MAX_BYTES + 1);
  expect(readFileSync(cur(r), 'utf8')).toBe(JSON.stringify(line({ ms: 9 })) + '\n');
});

test('at exactly the cap there is no rotation', () => {
  const r = root();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  writeFileSync(cur(r), 'x'.repeat(TIMING_MAX_BYTES));
  appendTiming(r, line());
  expect(existsSync(old(r))).toBe(false);
});

test('readTiming returns old lines first and skips malformed ones', () => {
  const r = root();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  writeFileSync(old(r), JSON.stringify(line({ ms: 1 })) + '\nnot json{\n');
  writeFileSync(cur(r), JSON.stringify(line({ ms: 2 })) + '\n');
  expect(readTiming(r).map((t) => t.ms)).toEqual([1, 2]);
  expect(readTiming(root())).toEqual([]);
});

test('a line holds no key outside TimingLine (no paths, no command text)', () => {
  const r = root();
  appendTiming(r, { ...line(), file_path: '/a/b', command: 'rm -rf' } as TimingLine);
  const keys = Object.keys(JSON.parse(readFileSync(cur(r), 'utf8')));
  expect(keys.sort()).toEqual(['event', 'ms', 'outcome', 'session', 'tool', 'ts']);
});

test('rotation lost to another process (rename ENOENT): still appends one whole line, never throws', () => {
  const r = root();
  mkdirSync(join(r, '.harness/logs'), { recursive: true });
  writeFileSync(cur(r), 'x'.repeat(TIMING_MAX_BYTES + 1));
  const fs = { ...realFs, renameSync: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } };
  expect(() => appendTiming(r, line(), fs)).not.toThrow();
  expect(readFileSync(cur(r), 'utf8').endsWith(JSON.stringify(line()) + '\n')).toBe(true);
});

test('any fs failure goes to stderr and never throws', () => {
  const errs: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
  try {
    const boom = () => { throw new Error('disk full'); };
    expect(() => appendTiming(root(), line(), { ...realFs, appendFileSync: boom, mkdirSync: boom })).not.toThrow();
  } finally {
    process.stderr.write = orig;
  }
  expect(errs.join('')).toContain('harness: timing log failed: disk full');
});
