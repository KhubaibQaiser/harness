import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TREE_EXCLUDES, treeHash } from '../../src/done/tree.js';
import { commit, git, repoWith } from '../review/repo.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = (files: Record<string, string> = { 'a.txt': 'a\n' }) => { const { root } = repoWith({ 'README.md': 'r\n' }, files); dirs.push(root); return root; };
const put = (root: string, rel: string, s: string) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

test('same content, same hash; a tracked edit or a new untracked file changes it; an ignored file does not', () => {
  const root = mk({ 'a.txt': 'a\n', '.gitignore': 'ignored.txt\n' });
  const h = treeHash(root);
  expect(h).toMatch(/^[0-9a-f]{40,64}$/);
  expect(treeHash(root)).toBe(h);
  put(root, 'ignored.txt', 'x');
  expect(treeHash(root)).toBe(h);
  put(root, 'new.txt', 'x');
  const h2 = treeHash(root);
  expect(h2).not.toBe(h);
  put(root, 'a.txt', 'changed\n');
  expect(treeHash(root)).not.toBe(h2);
});

test('file names with spaces and unicode hash and count', () => {
  const root = mk();
  const h = treeHash(root);
  put(root, 'dir with space/é ü.txt', 'x');
  expect(treeHash(root)).not.toBe(h);
});

test('harness-local writes do not change the hash without a .gitignore', () => {
  const root = mk();
  const before = treeHash(root);
  for (const p of ['.harness/logs/events.jsonl', '.harness/results/a.json', '.harness/state/evidence.jsonl', '.harness/verdicts/x.json', '.harness/tmp/w/task.json']) put(root, p, 'x');
  expect(treeHash(root)).toBe(before);
  expect(TREE_EXCLUDES).toContain('.harness/tmp');
  expect(TREE_EXCLUDES).toContain('.harness/state');
});

test('GIT_INDEX_FILE, GIT_DIR and GIT_WORK_TREE in the environment are ignored', () => {
  const root = mk();
  const other = mk({ 'other.txt': 'o\n' });
  const h = treeHash(root);
  const saved = { ...process.env };
  try {
    process.env.GIT_INDEX_FILE = join(other, '.git', 'index');
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    expect(treeHash(root)).toBe(h);
  } finally {
    for (const k of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('the real index is left byte-for-byte unchanged', () => {
  const root = mk();
  put(root, 'untracked.txt', 'u');
  const idx = join(root, '.git', 'index');
  const before = readFileSync(idx);
  treeHash(root);
  expect(readFileSync(idx).equals(before)).toBe(true);
  expect(git(root, 'status', '--porcelain')).toContain('?? untracked.txt');
});

test('an unborn repo (no index) hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-tree-'));
  dirs.push(root);
  git(root, 'init', '-q');
  put(root, 'a.txt', 'a');
  const h = treeHash(root);
  commit(root, {});
  expect(treeHash(root)).toBe(h);
});

test('outside a repo it throws', () => {
  const d = mkdtempSync(join(tmpdir(), 'h-tree-norepo-'));
  dirs.push(d);
  expect(() => treeHash(d)).toThrow(/git/);
});
