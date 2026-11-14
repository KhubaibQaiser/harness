import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { filterOffs, TREE_EXCLUDES, treeHash } from '../../src/done/tree.js';
import { commit, git, repoWith } from '../review/repo.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = (files: Record<string, string> = { 'a.txt': 'a\n' }) => { const { root } = repoWith({ 'README.md': 'r\n' }, files); dirs.push(root); return root; };
// Ground truth: hash everything from disk through a brand-new index.
const truth = (root: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-truth-'));
  dirs.push(d);
  const env = { ...process.env, GIT_INDEX_FILE: join(d, 'index') };
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  return execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
};
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

test('a fresh repo (no refs, no index) hashes', () => {
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

test('a same-size edit made right after git add is seen (racy index)', () => {
  const root = mk({ 'a.txt': 'AAAA\n' });
  put(root, 'a.txt', 'BBBB\n');
  git(root, 'add', 'a.txt');
  put(root, 'a.txt', 'CCCC\n');
  expect(treeHash(root)).toBe(truth(root));
});

test('assume-unchanged, skip-worktree and core.ignoreStat do not hide an edit', () => {
  const root = mk({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  git(root, 'update-index', '--assume-unchanged', 'a.txt');
  git(root, 'update-index', '--skip-worktree', 'b.txt');
  git(root, 'config', 'core.ignoreStat', 'true');
  git(root, 'add', 'c.txt');
  for (const f of ['a.txt', 'b.txt', 'c.txt']) put(root, f, `edited ${f}\n`);
  expect(treeHash(root)).toBe(truth(root));
});

test('a clean filter from info/attributes plus config never runs, and the raw bytes are hashed', () => {
  const root = mk();
  const out = mkdtempSync(join(tmpdir(), 'h-filter-'));
  dirs.push(out);
  const marker = join(out, 'ran').replace(/\\/g, '/');
  const script = join(out, 'clean.js').replace(/\\/g, '/');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('const');`);
  writeFileSync(join(root, '.git', 'info', 'attributes'), '*.txt filter=x\n');
  git(root, 'config', 'filter.x.clean', `node "${script}"`);
  put(root, 'a.txt', 'one\n');
  const h1 = treeHash(root);
  put(root, 'a.txt', 'two\n');
  expect(treeHash(root)).not.toBe(h1);
  expect(existsSync(marker)).toBe(false);
});

test('a subdirectory root hashes the whole repo', () => {
  const root = mk({ 'a.txt': 'a\n', 'sub/x.txt': 'x\n' });
  const h = treeHash(root);
  expect(treeHash(join(root, 'sub'))).toBe(h);
  put(root, 'a.txt', 'changed\n');
  expect(treeHash(join(root, 'sub'))).toBe(treeHash(root));
  expect(treeHash(root)).not.toBe(h);
});

test('GIT_CONFIG_COUNT/KEY/VALUE in the environment are ignored', () => {
  const root = mk({ 'a.txt': 'a\r\nb\r\n' });
  const h = treeHash(root);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' });
    expect(treeHash(root)).toBe(h);
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('a timeout throws and leaves no temp folder behind', () => {
  const root = mk();
  const left = () => readdirSync(tmpdir()).filter((n) => n.startsWith('harness-tree-')).length;
  const before = left();
  expect(() => treeHash(root, { timeoutMs: 1 })).toThrow();
  expect(left()).toBe(before);
});

const headTree = (root: string) => git(root, 'rev-parse', 'HEAD^{tree}').trim();

test('a tracked file that matches an ignore rule is hashed, and an edit to it moves the hash', () => {
  const root = mk({ '.gitignore': 'dist/\n' });
  put(root, 'dist/app.js', 'v1\n');
  git(root, 'add', '-f', 'dist/app.js');
  git(root, 'commit', '-q', '-m', 'dist');
  const h = treeHash(root);
  expect(h).toBe(headTree(root));
  put(root, 'dist/app.js', 'v2\n');
  expect(treeHash(root)).not.toBe(h);
});

test('editing a tracked file listed in .git/info/exclude changes the hash', () => {
  const root = mk({ 'src/a.txt': 'a\n' });
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'src/\n');
  const h = treeHash(root);
  expect(h).toBe(headTree(root));
  put(root, 'src/a.txt', 'edited\n');
  expect(treeHash(root)).not.toBe(h);
});

test.skipIf(process.platform === 'win32')('core.fileMode=false keeps an executable file at 100755 on a clean checkout', () => {
  const { root } = repoWith({ 'README.md': 'r\n' }, { 'run.sh': { exec: '#!/bin/sh\n' } });
  dirs.push(root);
  git(root, 'config', 'core.fileMode', 'false');
  expect(treeHash(root)).toBe(headTree(root));
});

test('core.symlinks=false with the link checked out as a plain file equals HEAD', () => {
  const { root } = repoWith({ 'README.md': 'r\n', 'a.txt': 'a\n' }, { 'ln': { link: 'a.txt' } });
  dirs.push(root);
  git(root, 'config', 'core.symlinks', 'false');
  rmSync(join(root, 'ln'), { force: true });
  put(root, 'ln', 'a.txt');
  expect(treeHash(root)).toBe(headTree(root));
});

test('an uninitialised submodule (gitlink, empty dir) equals HEAD', () => {
  const { root } = repoWith({ 'README.md': 'r\n' }, { sub: { gitlink: '1234567890123456789012345678901234567890' } });
  dirs.push(root);
  mkdirSync(join(root, 'sub'), { recursive: true });
  expect(treeHash(root)).toBe(headTree(root));
});

test('a filter name containing = is blanked too', () => {
  const root = mk();
  const out = mkdtempSync(join(tmpdir(), 'h-filter-'));
  dirs.push(out);
  const marker = join(out, 'ran').replace(/\\/g, '/');
  const script = join(out, 'clean.js').replace(/\\/g, '/');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('const');`);
  writeFileSync(join(root, '.git', 'info', 'attributes'), '*.txt filter=x=y\n');
  git(root, 'config', 'filter.x=y.clean', `node "${script}"`);
  put(root, 'a.txt', 'one\n');
  treeHash(root);
  expect(existsSync(marker)).toBe(false);
});

test('an lfs extension makes stock LFS non-stock, whatever the case of its subsection', () => {
  const stock = 'filter.lfs.clean\ngit-lfs clean -- %f\0';
  expect(filterOffs(stock)).toEqual([]);
  expect(filterOffs(`${stock}lfs.Extension.E.clean\nx\0`).map(([k]) => k)).toContain('filter.lfs.clean');
});

test('a garbage HEAD ref throws instead of reading as unborn', () => {
  const root = mk();
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), 'garbage\n');
  expect(() => treeHash(root)).toThrow(/git/);
});

test('a detached HEAD at a missing object throws', () => {
  const root = mk();
  writeFileSync(join(root, '.git', 'HEAD'), '1234567890123456789012345678901234567890\n');
  expect(() => treeHash(root)).toThrow(/git/);
});

const orphanMsg = /can't be computed on an orphan branch; commit first/;

test('an orphan branch in a repo with commits throws', () => {
  const root = mk({ 'a.txt': 'a\n' });
  git(root, 'checkout', '-q', '--orphan', 'fresh');
  put(root, 'new.txt', 'n\n');
  expect(() => treeHash(root)).toThrow(orphanMsg);
});

test('an orphan branch with .git/info/exclude hiding a tracked edit still throws, never a stale hash', () => {
  const root = mk({ 'src/s.txt': 's\n' });
  git(root, 'checkout', '-q', '--orphan', 'fresh');
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'src/\n');
  put(root, 'src/s.txt', 'edited\n');
  expect(() => treeHash(root)).toThrow(orphanMsg);
});

// Exercises the real `git config --get-regexp` listing: git keeps the subsection's case, so `Lfs.Extension.E` lists as `lfs.Extension.E`.
test.skipIf(process.platform === 'win32')('stock lfs plus an lfs extension spelled Lfs.Extension never runs git-lfs (POSIX: the fake git-lfs is a sh script)', () => {
  const root = mk();
  const bin = mkdtempSync(join(tmpdir(), 'h-lfs-'));
  dirs.push(bin);
  const marker = join(bin, 'ran');
  writeFileSync(join(bin, 'git-lfs'), `#!/bin/sh\n: > '${marker}'\nexit 1\n`, { mode: 0o755 });
  git(root, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  git(root, 'config', 'filter.lfs.process', 'git-lfs filter-process');
  git(root, 'config', 'Lfs.Extension.E.clean', 'x');
  put(root, '.gitattributes', '* filter=lfs\n');
  put(root, 'a.txt', 'edited\n');
  const savedPath = process.env.PATH;
  let err: unknown;
  try {
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
    treeHash(root);
  } catch (e) { err = e; } finally { process.env.PATH = savedPath; }
  expect(existsSync(marker)).toBe(false);
  expect(err).toBeUndefined();
});
