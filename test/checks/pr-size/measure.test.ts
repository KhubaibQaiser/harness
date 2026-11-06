import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { type Git, headBranch, isOver, measure, realGit, type SizeConfig } from '../../../src/checks/pr-size/measure.js';
import { defaults } from '../../../src/core/config.js';
import { makeRepo } from '../../install/helpers.js';

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawnSync: vi.fn(real.spawnSync) };
});

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('');
const cfg = (generated: string[] = [], base_ref = 'origin/main'): SizeConfig => ({ pr_size: defaults().pr_size, multi_file_gate: { generated }, stop: { ...defaults().stop, base_ref } });
/** Writes `files` (null deletes) and commits everything on the current branch. */
function commit(root: string, files: Record<string, string | Buffer | null>, msg = 'c') {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    if (body === null) rmSync(p);
    else (mkdirSync(dirname(p), { recursive: true }), writeFileSync(p, body));
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', msg);
}
/** main with origin/main and origin/HEAD, then a `feat` branch checked out. */
function repo(files: Record<string, string> = { 'README.md': 'hi\n' }) {
  const root = makeRepo(files, { branch: 'main', remoteHead: 'main' });
  git(root, 'checkout', '-q', '-b', 'feat');
  return root;
}
const fakeGit = (reply: ReturnType<Git> = { status: 0, stdout: '' }) => {
  const calls: string[][] = [];
  const g: Git = (args) => (calls.push(args), reply);
  return { calls, g };
};

describe('counting', () => {
  test('a 10-line source and a 5-line test count 15 lines in 2 files against origin/main', () => {
    const root = repo();
    commit(root, { 'src/a.ts': lines(10), 'test/a.test.ts': lines(5) });
    expect(measure(root, {}, cfg())).toEqual({ base: 'origin/main', head: 'HEAD', lines: 15, files: 2, top: [{ path: 'src/a.ts', lines: 10 }, { path: 'test/a.test.ts', lines: 5 }], excluded: [] });
  });

  test('lockfiles, ignore files, snapshots and generated paths are excluded; .npmignore and .harnessignore count', () => {
    const root = repo();
    const ex = ['pnpm-lock.yaml', '.gitignore', '.prettierignore', '.dockerignore', '.eslintignore', 'pkg/.gitignore', '__snapshots__/a.snap', 'x.snap', 'gen/a.ts'];
    commit(root, { ...Object.fromEntries(ex.map((p) => [p, lines(3)])), '.npmignore': lines(1), '.harnessignore': lines(2) });
    const s = measure(root, {}, cfg(['gen/**']));
    expect(s).toMatchObject({ lines: 3, files: 2, excluded: [...ex].sort() });
  });

  test('binary, pure rename and whole-file deletion are each 1 file and 0 lines', () => {
    const root = repo({ 'old.ts': lines(50), 'ren.ts': lines(20) });
    git(root, 'mv', 'ren.ts', 'moved.ts');
    commit(root, { 'old.ts': null, 'bin.dat': Buffer.from([1, 0, 2, 0, 3]) });
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 0, files: 3, top: [{ path: 'bin.dat', lines: 0 }, { path: 'moved.ts', lines: 0 }, { path: 'old.ts', lines: 0 }] });
  });

  // Windows git does not track the executable bit.
  test.skipIf(process.platform === 'win32')('a mode-only change is 1 file and 0 lines', () => {
    const root = repo({ 'run.sh': lines(3) });
    chmodSync(join(root, 'run.sh'), 0o755);
    commit(root, {});
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 0, files: 1, top: [{ path: 'run.sh', lines: 0 }] });
  });

  test("a name with a space, an apostrophe and an ampersand survives -z parsing on every OS", () => {
    const root = repo();
    commit(root, { "it's a & b.ts": lines(2) });
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 2, files: 1, top: [{ path: "it's a & b.ts", lines: 2 }] });
  });

  // Newline, tab and double quote are not valid in Windows file names.
  test.skipIf(process.platform === 'win32')('names with a newline, a tab and a quote survive -z parsing', () => {
    const root = repo();
    commit(root, { 'a\nb.ts': lines(1), 'c\td.ts': lines(2), 'e"f.ts': lines(3) });
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 6, files: 3, top: [{ path: 'e"f.ts', lines: 3 }, { path: 'c\td.ts', lines: 2 }, { path: 'a\nb.ts', lines: 1 }] });
  });

  test('a path with a space and a non-ASCII name is counted under its real name', () => {
    const root = repo();
    commit(root, { 'dir with space/ü.ts': lines(4) });
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 4, files: 1, top: [{ path: 'dir with space/ü.ts', lines: 4 }] });
  });

  test('uncommitted and untracked changes are not counted', () => {
    const root = repo({ 'README.md': 'hi\n' });
    commit(root, { 'a.ts': lines(2) });
    writeFileSync(join(root, 'README.md'), lines(9));
    writeFileSync(join(root, 'new.ts'), lines(9));
    git(root, 'add', 'README.md');
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 2, files: 1 });
  });

  test('merging main into feat after main moved adds nothing from main', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(3) });
    git(root, 'checkout', '-q', 'main');
    commit(root, { 'm.ts': lines(30) });
    git(root, 'update-ref', 'refs/remotes/origin/main', 'main');
    git(root, 'checkout', '-q', 'feat');
    git(root, 'merge', '-q', '--no-edit', 'main');
    expect(measure(root, {}, cfg())).toMatchObject({ lines: 3, files: 1 });
  });
});

describe('base and head', () => {
  test('--base main resolves to origin/main', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(1) });
    expect(measure(root, { base: 'main' }, cfg())).toMatchObject({ base: 'origin/main', lines: 1 });
  });

  test('a stacked base is found on the remote, or only locally', () => {
    const root = makeRepo({ 'README.md': 'hi\n' }, { branch: 'main', remoteHead: 'main' }); // no `feat`: it would block `feat/a`
    git(root, 'checkout', '-q', '-b', 'feat/a');
    commit(root, { 'a.ts': lines(5) });
    git(root, 'checkout', '-q', '-b', 'feat/b');
    commit(root, { 'b.ts': lines(2) });
    expect(measure(root, { base: 'feat/a' }, cfg())).toMatchObject({ base: 'feat/a', lines: 2 });
    git(root, 'update-ref', 'refs/remotes/origin/feat/a', 'feat/a');
    expect(measure(root, { base: 'feat/a' }, cfg())).toMatchObject({ base: 'origin/feat/a', lines: 2 });
  });

  test('a missing base is unmeasured', () => {
    expect(measure(repo(), { base: 'feat/zz' }, cfg())).toEqual({ error: 'base `feat/zz` not found; fetch it first' });
  });

  test('with origin/HEAD unset, stop.base_ref is used; with neither, no base', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(1) });
    git(root, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    expect(measure(root, {}, cfg())).toMatchObject({ base: 'origin/main', lines: 1 });
    git(root, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(measure(root, {}, cfg())).toEqual({ error: 'no base: origin/HEAD is not set and stop.base_ref (origin/main) was not found; fetch it first' });
  });

  test('with origin/HEAD pointing at a missing ref and no stop.base_ref, the reason names both tries', () => {
    const root = repo();
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone');
    expect(measure(root, {}, cfg([], 'upstream/dev'))).toEqual({ error: 'no base: origin/HEAD (origin/gone) and stop.base_ref (upstream/dev) were not found; fetch it first' });
  });

  test('head feat works from another checked-out branch; a missing head is unmeasured', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(6) });
    git(root, 'checkout', '-q', 'main');
    expect(measure(root, { head: 'feat' }, cfg())).toMatchObject({ head: 'feat', lines: 6 });
    expect(measure(root, { head: 'nope' }, cfg())).toEqual({ error: 'head `nope` not found', base: 'origin/main' });
  });

  test('a detached HEAD measures HEAD, and headBranch is null', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(2) });
    expect(headBranch(realGit(root), 2000)).toEqual({ name: 'feat' });
    git(root, 'checkout', '-q', '--detach');
    expect(measure(root, {}, cfg())).toMatchObject({ head: 'HEAD', lines: 2 });
    expect(headBranch(realGit(root), 2000)).toEqual({ name: null });
    expect(headBranch(realGit(root), 0)).toEqual({ name: null, error: 'git timed out' });
  });
});

describe('trust boundary', () => {
  test.each(['--output=x', 'a..b', '-x', 'a'.repeat(300)])('%s is not a plain branch name, and no git runs', (n) => {
    const { calls, g } = fakeGit();
    expect(measure('/nonexistent', { base: n }, cfg(), { git: g })).toEqual({ error: '`--base` is not a plain branch name' });
    expect(measure('/nonexistent', { head: n }, cfg(), { git: g })).toEqual({ error: '`--head` is not a plain branch name' });
    expect(calls).toEqual([]);
  });

  test('every lookup ends options before the ref', () => {
    const { calls, g } = fakeGit({ status: 1, stdout: '' });
    measure('/nonexistent', { base: 'main' }, cfg(), { git: g });
    expect(calls).toEqual(['refs/remotes/origin/main', 'refs/heads/main', 'main'].map((r) => ['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`]));
  });
});

describe('failures', () => {
  test('ENOENT is git not found; ETIMEDOUT is git timed out', () => {
    const err = (code: string) => fakeGit({ status: null, stdout: '', error: Object.assign(new Error(code), { code }) }).g;
    expect(measure('/x', {}, cfg(), { git: err('ENOENT') })).toEqual({ error: 'git not found' });
    expect(measure('/x', {}, cfg(), { git: err('ETIMEDOUT') })).toEqual({ error: 'git timed out' });
  });

  test('with 3 s per call the measurement stops at the 6 s budget, making no call with no time left', () => {
    let t = 0;
    const timeouts: number[] = [];
    const g: Git = (_args, ms) => (timeouts.push(ms), (t += 3000), { status: 0, stdout: 'abc\n' });
    expect(measure('/x', {}, cfg(), { git: g, now: () => t })).toMatchObject({ error: 'git timed out' });
    expect(timeouts).toEqual([2000, 2000]);
    expect(t).toBe(6000);
  });

  test.each(['EACCES', 'EAGAIN', 'ENOBUFS'])('a %s spawn error is named, never read as a missing ref', (code) => {
    const { calls, g } = fakeGit({ status: null, stdout: '', error: Object.assign(new Error(code), { code }) });
    expect(measure('/x', { base: 'main' }, cfg(), { git: g })).toEqual({ error: `git failed (${code})` });
    expect(measure('/x', {}, cfg(), { git: g })).toEqual({ error: `git failed (${code})` });
    expect(calls).toHaveLength(2);
  });

  test('a git killed by a signal is named, never read as a missing ref', () => {
    expect(measure('/x', { base: 'main' }, cfg(), { git: fakeGit({ status: null, stdout: '' }).g })).toEqual({ error: 'git failed (killed)' });
  });

  test('the diff runs through spawnSync with the 64 MB buffer', () => {
    const root = repo();
    commit(root, { 'a.ts': lines(1) });
    vi.mocked(spawnSync).mockClear();
    measure(root, {}, cfg());
    const diffs = vi.mocked(spawnSync).mock.calls.filter(([, args]) => (args as string[]).includes('diff'));
    expect(diffs).toHaveLength(2);
    for (const [, , o] of diffs) expect(o).toMatchObject({ maxBuffer: 64 * 1024 * 1024 });
  });

  test('a failing diff is git diff failed', () => {
    const g: Git = (args) => (args[0] === 'rev-parse' || args[0] === 'symbolic-ref' ? { status: 0, stdout: 'origin/main\n' } : { status: 128, stdout: '' });
    expect(measure('/x', {}, cfg(), { git: g })).toEqual({ error: 'git diff failed', base: 'origin/main' });
  });

  test('the diffs are exactly the spec commands on resolved SHAs', () => {
    const { calls, g } = fakeGit({ status: 0, stdout: 'sha1\n' });
    measure('/x', { base: 'main', head: 'feat' }, cfg(), { git: g });
    expect(calls.slice(-2)).toEqual([
      ['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', 'sha1...sha1'],
      ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '--diff-filter=D', '--no-ext-diff', 'sha1...sha1'],
    ]);
  });
});

test('isOver is lines > max_lines or files > max_files', () => {
  const d = defaults().pr_size;
  expect(isOver({ lines: 400, files: 20 }, d)).toBe(false);
  expect(isOver({ lines: 401, files: 20 }, d)).toBe(true);
  expect(isOver({ lines: 400, files: 21 }, d)).toBe(true);
});

test('review focus 1: a 2 MB blob arrives whole through realGit', () => {
  const big = 'x'.repeat(2 * 1024 * 1024);
  const root = makeRepo({ 'big.txt': big }, { branch: 'main' });
  const r = realGit(root)(['show', 'HEAD:big.txt'], 2000);
  expect(r.error).toBeUndefined();
  expect(r.stdout.length).toBe(big.length);
});

describe('working tree', () => {
  const wt = { worktree: true };
  const write = (root: string, rel: string, body: string | Buffer) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), body));

  test('committed 10 + staged 3 + unstaged 2 + untracked 4 = 19 lines; ignored files do not count', () => {
    const root = repo({ 'README.md': 'hi\n', '.gitignore': 'ign.txt\n', 'u.ts': lines(5) });
    commit(root, { 'a.ts': lines(10) });
    write(root, 'staged.ts', lines(3));
    git(root, 'add', 'staged.ts');
    write(root, 'u.ts', lines(5) + lines(2));
    write(root, 'new.ts', lines(4));
    write(root, 'ign.txt', lines(50));
    expect(measure(root, wt, cfg())).toMatchObject({ head: 'working tree', lines: 19, files: 4 });
  });

  test('untracked files under .harness/reports/ do not count', () => {
    const root = repo();
    write(root, '.harness/reports/2026-11-05.html', lines(40));
    write(root, 'new.ts', lines(2));
    expect(measure(root, wt, cfg())).toMatchObject({ lines: 2, files: 1 });
  });

  test('an untracked lockfile is excluded', () => {
    const root = repo();
    write(root, 'pnpm-lock.yaml', lines(9));
    expect(measure(root, wt, cfg())).toMatchObject({ lines: 0, files: 0, excluded: ['pnpm-lock.yaml'] });
  });

  test('untracked binary, 2 MB file and uncommitted deletion are each 1 file and 0 lines', () => {
    const root = repo({ 'old.ts': lines(30) });
    write(root, 'bin.dat', Buffer.from([1, 0, 2]));
    write(root, 'big.txt', 'x\n'.repeat(1024 * 1024));
    rmSync(join(root, 'old.ts'));
    expect(measure(root, wt, cfg())).toMatchObject({ lines: 0, files: 3 });
  });

  test('a last line without a newline counts; an empty file is 0 lines', () => {
    const root = repo();
    write(root, 'a.txt', 'a\nb');
    write(root, 'e.txt', '');
    expect(measure(root, wt, cfg())).toMatchObject({ lines: 2, files: 2 });
  });

  // Creating symlinks needs privileges on Windows.
  test.skipIf(process.platform === 'win32')('a symlink to a file outside the repo is 1 file and 0 lines', () => {
    const root = repo();
    const outside = join(makeRepo({ 'x.txt': lines(40) }), 'x.txt');
    symlinkSync(outside, join(root, 'link.txt'));
    expect(measure(root, wt, cfg())).toMatchObject({ lines: 0, files: 1 });
  });

  test('3,000 untracked one-line files: files >= 3000, only 2000 read, under 2 s', () => {
    const root = repo();
    for (let i = 0; i < 3000; i++) writeFileSync(join(root, `f${i}.txt`), 'x\n');
    const t = Date.now();
    const s = measure(root, wt, cfg());
    expect(s).toMatchObject({ lines: 2000 });
    expect((s as { files: number }).files).toBeGreaterThanOrEqual(3000);
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test('reading untracked files counts toward the total budget', () => {
    const root = repo();
    write(root, 'a.txt', 'x\n');
    let clock = 0;
    const g: Git = (args, ms) => {
      const r = realGit(root)(args, ms);
      if (args[0] === 'ls-files') clock = 10000; // the listing used up the whole budget
      return r;
    };
    expect(measure(root, wt, cfg(), { git: g, now: () => clock, budgetMs: 6000 })).toMatchObject({ error: 'git timed out' });
  });
});
