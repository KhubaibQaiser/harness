import { describe, expect, test } from 'vitest';
import { PR_SIZE_EXCLUDE } from '../../src/core/config.js';
import { defaultExec } from '../../src/core/exec.js';
import { SAFE_GIT } from '../../src/core/git-safe.js';
import { capDiff, commentable, DIFF_CAP, diffArgs, parseDiff, type DiffFile } from '../../src/review/diff.js';
import { repoWith, type Files } from './repo.js';

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';
function diff(base: Files, head: Files): DiffFile[] {
  const r = repoWith(base, head);
  const out = defaultExec('git', [...SAFE_GIT, ...diffArgs(r.base, r.head)], { cwd: r.root });
  expect(out.status, out.stderr).toBe(0);
  return parseDiff(out.stdout);
}
const one = (base: Files, head: Files) => {
  const f = diff(base, head);
  expect(f).toHaveLength(1);
  return f[0]!;
};

describe('parseDiff', () => {
  test('added', () => {
    const f = one({ 'k.txt': 'k\n' }, { 'a.ts': 'x\ny\nz\n' });
    expect(f).toMatchObject({ path: 'a.ts', status: 'added', binary: false, lines: 3 });
    expect(commentable([f])['a.ts']).toEqual({ RIGHT: [1, 2, 3], LEFT: [] });
  });
  test('deleted has LEFT lines only', () => {
    const f = one({ 'd.ts': 'p\nq\n' }, { 'd.ts': null });
    expect(f).toMatchObject({ path: 'd.ts', status: 'deleted', lines: 2 });
    expect(commentable([f])['d.ts']).toEqual({ RIGHT: [], LEFT: [1, 2] });
  });
  test('an edited rename keeps old_path and comments on the new path', () => {
    const f = one({ 'old.ts': lines(10) }, { 'old.ts': null, 'new.ts': lines(10).replace('l5\n', 'L5\n') });
    expect(f).toMatchObject({ path: 'new.ts', old_path: 'old.ts', status: 'renamed', lines: 2 });
    expect(commentable([f])['new.ts']!.RIGHT).toContain(5);
    expect(commentable([f])['new.ts']!.LEFT).toEqual([5]);
  });
  test('a 100% rename has no lines', () => {
    const f = one({ 'p.ts': lines(5) }, { 'p.ts': null, 'q.ts': lines(5) });
    expect(f).toMatchObject({ path: 'q.ts', old_path: 'p.ts', status: 'renamed', hunks: [], lines: 0 });
    expect(commentable([f])['q.ts']).toEqual({ RIGHT: [], LEFT: [] });
  });
  test('binary', () => {
    const f = one({ 'b.bin': Buffer.from([0, 1, 2]) }, { 'b.bin': Buffer.from([0, 3, 4]) });
    expect(f).toMatchObject({ path: 'b.bin', status: 'binary', binary: true, hunks: [], lines: 0 });
  });
  test('mode only', () => {
    expect(one({ 'm.sh': 'echo\n' }, { 'm.sh': { exec: 'echo\n' } })).toMatchObject({ path: 'm.sh', status: 'mode', hunks: [], lines: 0 });
  });
  test('submodule', () => {
    expect(one({ 'k.txt': 'k\n' }, { sub: { gitlink: 'a'.repeat(40) } })).toMatchObject({ path: 'sub', status: 'submodule', binary: false });
  });
  test('no newline at end of file', () => {
    const f = one({ 'n.txt': 'a\nb' }, { 'n.txt': 'a\nc' });
    expect(f.hunks[0]!.rows).toEqual([{ kind: ' ', text: 'a', old: 1, new: 1 }, { kind: '-', text: 'b', old: 2 }, { kind: '+', text: 'c', new: 2 }]);
  });
  test('paths with spaces, unicode and a leading dash are exact', () => {
    const f = diff({ 'k.txt': 'k\n' }, { 'sp é.txt': 'one\n', '-rf': 'two\n' });
    expect(f.map((x) => x.path).sort()).toEqual(['-rf', 'sp é.txt']);
    expect(f.every((x) => x.hunks[0]!.rows[0]!.kind === '+')).toBe(true);
  });
  test('CRLF text keeps its \\r', () => {
    expect(one({ 'k.txt': 'k\n' }, { 'w.txt': 'a\r\nb\r\n' }).hunks[0]!.rows.map((r) => r.text)).toEqual(['a\r', 'b\r']);
  });
  test('empty diff', () => {
    expect(parseDiff('')).toEqual([]);
  });
});

describe('capDiff', () => {
  const file = (path: string, n: number): DiffFile => ({ path, status: 'added', binary: false, hunks: [], lines: n });
  test('greedy in diff order: a file over the cap is skipped, later ones still go', () => {
    expect(DIFF_CAP).toBe(3000);
    const r = capDiff([file('a.ts', 10), file('big.ts', 3500), file('c.ts', 20)], 3000, []);
    expect(r.sent.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
    expect(r.omitted).toEqual([{ path: 'big.ts', why: 'not reviewed: over the size cap' }]);
  });
  test('pr_size.exclude matches are listed, not sent', () => {
    const r = capDiff([file('pnpm-lock.yaml', 5), file('a.ts', 1)], 3000, PR_SIZE_EXCLUDE);
    expect(r.sent.map((f) => f.path)).toEqual(['a.ts']);
    expect(r.omitted).toEqual([{ path: 'pnpm-lock.yaml', why: 'excluded by pr_size.exclude' }]);
  });
});
