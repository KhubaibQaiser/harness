import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { prSizeEntry } from '../../../src/checks/pr-size/entry.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
import { writeProgress } from '../../../src/checks/pr-size/progress.js';
import { makeRepo } from '../../install/helpers.js';

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
/** main with origin/main and origin/HEAD, then a `feat` branch with one 15-line commit. */
function repo(config?: string) {
  const root = makeRepo(config ? { 'README.md': 'hi\n', '.harness/config.yaml': config } : { 'README.md': 'hi\n' }, { branch: 'main', remoteHead: 'main' });
  git(root, 'checkout', '-q', '-b', 'feat');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), Array.from({ length: 15 }, (_, i) => `l${i}\n`).join(''));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'c');
  return root;
}
const run = (argv: string[], cwd: string, g?: Git) => {
  const lines: string[] = [];
  const code = prSizeEntry(['--pr-size', ...argv], cwd, (l) => lines.push(l), g);
  return { code, lines, json: lines.length ? JSON.parse(lines[0]!) : undefined };
};
const USAGE = 'usage: dispatch.mjs --pr-size [--base <name>] [--head <name>] [--worktree]';

describe('--worktree', () => {
  test('exits 0 with head "working tree" and counts uncommitted work', () => {
    const root = repo();
    writeFileSync(join(root, 'new.ts'), 'a\nb\n');
    const r = run(['--worktree'], root);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ head: 'working tree', lines: 17, files: 2 });
  });
});

describe('prSizeEntry', () => {
  test('within the limit: exit 0 and the spec §8 JSON line', () => {
    const r = run([], repo());
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.json).toEqual({ base: 'origin/main', head: 'HEAD', lines: 15, files: 1, target_lines: 200, max_lines: 400, max_files: 20, over: false, top: [{ path: 'src/a.ts', lines: 15 }], excluded: [] });
  });

  test('over the configured limit: exit 1 and over true', () => {
    const r = run([], repo('pr_size:\n  target_lines: 5\n  max_lines: 10\n'));
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ over: true, max_lines: 10, lines: 15 });
  });

  test('N5: the branch\'s recorded raise is the max (the pr-ship check); one outside the §14.4 ranges is ignored', () => {
    const root = repo('pr_size:\n  target_lines: 5\n  max_lines: 10\n');
    const seed = (lines: number) => writeProgress(root, 'feat', { base: 'origin/main', fired: [], lines: 0, files: 0, ts: 't', raise: { lines, files: 20, ts: 't' } });
    seed(20);
    for (const argv of [[], ['--worktree'], ['--head', 'feat']]) {
      const r = run(argv, root);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.json).toMatchObject({ over: false, max_lines: 20, max_files: 20, raised: true, lines: 15 });
    }
    expect(run(['--head', 'main'], root).json.raised).toBeUndefined(); // another branch's raise doesn't count
    seed(10); // not above max_lines: ignored
    expect(run([], root)).toMatchObject({ code: 1, json: { over: true, max_lines: 10 } });
    expect(run([], root).json.raised).toBeUndefined();
  });

  test('top holds at most 10 entries', () => {
    const root = repo();
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `f${i}.ts`), 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'more');
    const r = run([], root);
    expect(r.json.files).toBe(13);
    expect(r.json.top).toHaveLength(10);
  });

  test('--base=<name> form is accepted; an unknown base is exit 2 with an error', () => {
    const root = repo();
    expect(run(['--base=main'], root).code).toBe(0);
    const r = run(['--base', 'nope'], root);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatch(/nope/);
    expect(Object.keys(r.json)).toEqual(['error']);
  });

  test.each([['--base'], ['--head'], ['--bogus'], ['--base', 'main', 'extra']])('bad arguments %j give the usage error', (...argv) => {
    const r = run(argv, repo());
    expect(r.code).toBe(2);
    expect(r.json).toEqual({ error: USAGE });
  });

  test('--base=--output=x is refused as a non-plain name before git is called', () => {
    const calls: string[][] = [];
    const g: Git = (args) => (calls.push(args), { status: 0, stdout: '' });
    const r = run(['--base=--output=x'], repo(), g);
    expect(r.code).toBe(2);
    expect(r.json.error).toMatch(/plain branch name/);
    expect(calls).toEqual([]);
  });

  test('an invalid config is exit 2 naming the file', () => {
    const r = run([], repo('pr_size:\n  max_lines: -3\n'));
    expect(r.code).toBe(2);
    expect(r.json.error).toMatch(/^`\.harness\/config\.yaml` is invalid: .*max_lines/);
  });

  test('the built bundle prints the JSON and does not wait for stdin', () => {
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'hooks', 'dispatch.mjs'), '--pr-size'], { cwd: repo(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ lines: 15, over: false });
  });
});

test('outside a git repo it prints a JSON error and exits 2, never throws', () => {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'harness-prsize-nogit-'));
  const code = prSizeEntry(['--pr-size'], dir, (l) => lines.push(l));
  expect(code).toBe(2);
  expect(JSON.parse(lines[0]!)).toHaveProperty('error');
});

test('a git seam that throws gives a JSON error and exit 2, never an uncaught throw', () => {
  const lines: string[] = [];
  const boom: Git = () => { throw new Error('spawn exploded\nsecond line'); };
  const code = prSizeEntry(['--pr-size'], makeRepo({ 'a.ts': 'x' }), (l) => lines.push(l), boom);
  expect(code).toBe(2);
  expect(JSON.parse(lines[0]!).error).toBe('could not measure: spawn exploded');
});

test('--worktree ignores --head, even a bad one', () => {
  const r = run(['--worktree', '--head', '--bad'], repo());
  expect(r.code).toBe(0);
  expect(r.json.head).toBe('working tree');
});

describe('--pr-size-raise', () => {
  const raise = (argv: string[], cwd: string) => {
    const lines: string[] = [];
    const code = prSizeEntry(['--pr-size-raise', ...argv], cwd, (l) => lines.push(l));
    return { code, json: JSON.parse(lines[0]!) };
  };
  test('valid values print the branch and limits, exit 0, and write nothing', () => {
    const root = repo();
    expect(raise(['--lines', '600'], root)).toEqual({ code: 0, json: { branch: 'feat', lines: 600, files: 20 } });
    expect(raise(['--lines', '600', '--files', '30'], root)).toEqual({ code: 0, json: { branch: 'feat', lines: 600, files: 30 } });
    expect(existsSync(join(root, '.harness', 'state'))).toBe(false);
  });

  test('a bad value, an unknown word or a detached HEAD exits 2 with error', () => {
    const root = repo();
    expect(raise(['--lines', '400'], root)).toEqual({ code: 2, json: { error: '--lines must be an integer from 401 to 100000' } });
    expect(raise(['--lines', '600', '--files', '19'], root)).toEqual({ code: 2, json: { error: '--files must be an integer from 20 to 10000' } });
    expect(raise(['--lines', '600', '--x'], root).code).toBe(2);
    git(root, 'checkout', '-q', '--detach');
    expect(raise(['--lines', '600'], root)).toEqual({ code: 2, json: { error: expect.stringMatching(/detached/) } });
  });
});
