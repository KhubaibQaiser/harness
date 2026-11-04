import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { gitStep } from '../../src/cli/git.js';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { makeRepo } from '../install/helpers.js';

const g = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const put = (root: string, rel: string, text: string) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), text));
const manifest = { version: '1.2.3', createdAt: 'x', files: [{ rel: '.harness/config.yaml', kind: 'create', hash: 'h' }, { rel: '.claude/settings.json', kind: 'update', hash: 'h' }] };

/** A repo with harness files written but not committed. */
function installed(opts: { branch?: string; remoteHead?: string; trailer?: string } = {}) {
  const root = makeRepo({ 'a.txt': 'a\n' }, opts);
  put(root, '.harness/config.yaml', `catalog_version: 7\n${opts.trailer ? `git:\n  commit_trailer: "${opts.trailer}"\n` : ''}`);
  put(root, '.claude/settings.json', '{}\n');
  put(root, '.harness/manifest.json', JSON.stringify(manifest));
  return root;
}
const run = (root: string, args: string[], exec: Exec = noGh) => {
  const lines: string[] = [];
  const code = gitStep(args, { root, env: {}, out: (s) => lines.push(s), exec });
  return { code, out: lines.join('\n') };
};
// gh never runs for real: it is reported missing.
const noGh: Exec = (cmd, args) => (cmd === 'gh' ? { status: 127, stdout: '', missing: true } : defaultExec(cmd, args));

test('branch refuses unrelated dirty paths', () => {
  const root = installed();
  put(root, 'mine.ts', 'x');
  const r = run(root, ['branch']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('Commit or stash these first: mine.ts.');
  expect(g(root, 'branch', '--show-current')).toBe('main');
});

test('branch creates the catalog branch when only harness files are dirty', () => {
  const root = installed();
  expect(run(root, ['branch']).code).toBe(0);
  expect(g(root, 'branch', '--show-current')).toBe('chore/ai-workflow-7');
});

test('branch refuses an existing branch', () => {
  const root = installed();
  g(root, 'branch', 'chore/ai-workflow-7');
  const r = run(root, ['branch']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('Branch chore/ai-workflow-7 already exists. Delete it or rename it, then run again.');
});

test('commit refuses the default branch', () => {
  const root = installed();
  const r = run(root, ['commit']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('You are on main. Run harness git branch first.');
});

test('commit uses the repo identity and no trailer', () => {
  const root = installed();
  put(root, 'mine.ts', 'x'); // not in the manifest: must stay unstaged
  g(root, 'checkout', '-q', '-b', 'chore/ai-workflow-7');
  expect(run(root, ['commit']).code).toBe(0);
  expect(g(root, 'log', '-1', '--format=%an <%ae>')).toBe('test <test@example.com>');
  expect(g(root, 'log', '-1', '--format=%B').replace(/\r/g, '')).toBe('chore: add AI workflow (harness 1.2.3, catalog 7)');
  expect(g(root, 'show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).sort()).toEqual(['.claude/settings.json', '.harness/config.yaml', '.harness/manifest.json']);
});

test('commit refuses when identity is unset', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  g(root, 'config', 'user.name', '');
  const r = run(root, ['commit']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('Set your git user.name and user.email, then run again.');
});

test('commit_trailer is appended when set', () => {
  const root = installed({ trailer: 'Co-Authored-By: Someone <s@example.com>' });
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
  expect(g(root, 'log', '-1', '--format=%B').replace(/\r/g, '')).toBe('chore: add AI workflow (harness 1.2.3, catalog 7)\n\nCo-Authored-By: Someone <s@example.com>');
});

test('push refuses the default branch even if renamed', () => {
  const root = installed({ branch: 'trunk', remoteHead: 'trunk' });
  const r = run(root, ['push']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('You are on trunk. Harness never pushes the default branch.');
  g(root, 'checkout', '-q', '-b', 'main');
  expect(run(root, ['push']).out).toBe('You are on main. Harness never pushes the default branch.');
});

test('pr without gh prints the command and exits 0', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'chore/ai-workflow-7');
  const r = run(root, ['pr', '--title', "it's a title"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`gh pr create --base main --head chore/ai-workflow-7 --title 'it'\\''s a title' --body-file .harness/report.md`);
});

test('pr runs gh pr create when gh is signed in', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => cmd === 'gh' ? (calls.push([cmd, ...args]), { status: 0, stdout: 'https://example.com/pr/1\n' }) : defaultExec(cmd, args);
  expect(run(root, ['pr'], exec).code).toBe(0);
  expect(calls.at(-1)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'b', '--title', 'chore: add AI workflow', '--body-file', '.harness/report.md']);
});

test('a network failure prints the sandbox line', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const exec: Exec = (cmd, args) => (cmd === 'git' && args.includes('push') ? { status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' } : defaultExec(cmd, args));
  const r = run(root, ['push'], exec);
  expect(r.code).toBe(1);
  expect(r.out).toContain("Claude Code's sandbox blocks");
  expect(r.out).toContain('git push');
});
