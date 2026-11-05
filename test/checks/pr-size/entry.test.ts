import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { prSizeEntry } from '../../../src/checks/pr-size/entry.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
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
const USAGE = 'usage: dispatch.mjs --pr-size [--base <name>] [--head <name>]';

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
