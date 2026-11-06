import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { gitStep } from '../../src/cli/git.js';
import { type Git } from '../../src/checks/pr-size/measure.js';
import { writeProgress } from '../../src/checks/pr-size/progress.js';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { makeRepo } from '../install/helpers.js';

const g = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const put = (root: string, rel: string, text: string) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), text));
const manifest = { version: '1.2.3', createdAt: 'x', files: [{ rel: '.harness/config.yaml', kind: 'create', hash: 'h' }, { rel: '.claude/settings.json', kind: 'update', hash: 'h' }] };

/** A repo with harness files written but not committed. */
function installed(opts: { branch?: string; remoteHead?: string; trailer?: string; tracked?: Record<string, string>; extra?: string[]; preset?: string } = {}) {
  const root = makeRepo({ 'a.txt': 'a\n', ...opts.tracked }, opts);
  g(root, 'config', 'init.defaultBranch', opts.branch ?? 'main'); // hermetic: never the machine's global default
  for (const rel of opts.extra ?? []) put(root, rel, 'x');
  put(root, '.harness/config.yaml', `catalog_version: 7\n${opts.trailer ? `git:\n  commit_trailer: "${opts.trailer}"\n` : ''}${opts.preset ?? ''}`);
  put(root, '.claude/settings.json', '{}\n');
  put(root, '.harness/manifest.json', JSON.stringify({ ...manifest, files: [...manifest.files, ...(opts.extra ?? []).map((rel) => ({ rel, kind: 'create', hash: 'h' }))] }));
  return root;
}
const run = (root: string, args: string[], exec: Exec = noGh, git?: Git) => {
  const lines: string[] = [];
  const code = gitStep(args, { root, env: {}, out: (s) => lines.push(s), exec, git });
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
  put(root, '.harness/report.md', 'r');
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => cmd === 'gh' ? (calls.push([cmd, ...args]), { status: 0, stdout: 'https://example.com/pr/1\n' }) : defaultExec(cmd, args);
  expect(run(root, ['pr'], exec).code).toBe(0);
  expect(calls.at(-1)).toEqual(['gh', 'pr', 'create', '--base', 'main', '--head', 'b', '--title', 'chore: add AI workflow', '--body-file', join(root, '.harness/report.md')]);
});

test('a network failure names both the sandbox and the network', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const exec: Exec = (cmd, args) => (cmd === 'git' && args.includes('push') ? { status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' } : defaultExec(cmd, args));
  const r = run(root, ['push'], exec);
  expect(r.code).toBe(1);
  expect(r.out).toContain('the sandbox or the network blocked');
  expect(r.out).toContain('git push');
});

test('a repo with no origin/HEAD takes init.defaultBranch, and stays correct on the feature branch', () => {
  const root = installed({ branch: 'trunk' });
  g(root, 'config', 'init.defaultBranch', 'trunk');
  expect(run(root, ['branch']).code).toBe(0);
  const r = run(root, ['commit']);
  expect(r.code).toBe(0);
  expect(run(root, ['pr']).out).toContain('--base trunk --head chore/ai-workflow-7');
});

test('an unknowable default branch stops with the set-head hint', () => {
  const root = installed({ branch: 'develop' });
  g(root, 'config', 'init.defaultBranch', '');
  const r = run(root, ['commit']);
  expect(r.code).toBe(1);
  expect(r.out).toBe("Can't tell the default branch. Run `git remote set-head origin -a`, then run again.");
});

// `*` isn't a legal file-name character on Windows.
test.skipIf(process.platform === 'win32')('literal pathspecs: a manifest path with a glob stages only that file', () => {
  const root = installed({ extra: ['a*.md'] });
  put(root, 'a1.md', 'other');
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
  expect(g(root, 'show', '--name-only', '--format=', 'HEAD')).toContain('a*.md');
  expect(g(root, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('a1.md');
});

test('paths with spaces and a leading dash are committed', () => {
  const root = installed({ extra: ['my docs/-x.md', '-lead.md'] });
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
  const names = g(root, '-c', 'core.quotepath=off', 'show', '--name-only', '--format=', 'HEAD');
  expect(names).toContain('my docs/-x.md');
  expect(names).toContain('-lead.md');
});

test('a deleted manifest file has its deletion committed', () => {
  const root = installed({ tracked: { 'gone.txt': 'g\n' }, extra: [] });
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, { rel: 'gone.txt', kind: 'delete', hash: 'h' }] }));
  rmSync(join(root, 'gone.txt'));
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
  expect(g(root, 'show', '--name-status', '--format=', 'HEAD').replace(/\s+/g, ' ')).toContain('D gone.txt');
});

test('a renamed manifest file commits the new path', () => {
  const root = installed({ tracked: { 'old.txt': 'o\n' } });
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ ...manifest, files: [...manifest.files, { rel: 'new.txt', kind: 'create', hash: 'h' }] }));
  g(root, 'mv', 'old.txt', 'new.txt');
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
  expect(g(root, 'show', '--name-only', '--format=', 'HEAD')).toContain('new.txt');
});

test('commit refuses when the email is blank', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  g(root, 'config', 'user.email', '');
  expect(run(root, ['commit']).out).toBe('Set your git user.name and user.email, then run again.');
});

test('pr on the default branch is refused', () => {
  const root = installed();
  const r = run(root, ['pr']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('You are on main. Run harness git branch first.');
});

test('no manifest exits 1', () => {
  const root = makeRepo({ 'a.txt': 'a\n' });
  const r = run(root, ['branch']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('/harness:init');
});

test('--title without a value is a usage error', () => {
  expect(run(installed(), ['pr', '--title']).code).toBe(2);
});

test('pr with gh signed in but no report stops', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const exec: Exec = (cmd, args) => (cmd === 'gh' ? { status: 0, stdout: '' } : defaultExec(cmd, args));
  const r = run(root, ['pr'], exec);
  expect(r.code).toBe(1);
  expect(r.out).toContain('No report at');
});

test('a gh auth failure does not claim the user is signed out', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const exec: Exec = (cmd, args) => (cmd === 'gh' ? { status: 1, stdout: '' } : defaultExec(cmd, args));
  const r = run(root, ['pr'], exec);
  expect(r.code).toBe(0);
  expect(r.out).toContain('gh could not confirm a sign-in. Run this yourself: gh pr create');
});

test('ETIMEDOUT counts as a network error', () => {
  const root = installed();
  g(root, 'checkout', '-q', '-b', 'b');
  const exec: Exec = (cmd, args) => (cmd === 'git' && args.includes('push') ? { status: 1, stdout: '', stderr: 'spawnSync git ETIMEDOUT' } : defaultExec(cmd, args));
  expect(run(root, ['push'], exec).out).toContain('the sandbox or the network blocked');
});

test('push to a real local bare origin sets the upstream', () => {
  const root = installed();
  const bare = makeRepo({}, { git: false });
  g(bare, 'init', '-q', '--bare');
  g(root, 'remote', 'add', 'origin', bare);
  g(root, 'checkout', '-q', '-b', 'chore/ai-workflow-7');
  expect(run(root, ['commit']).code).toBe(0);
  const r = run(root, ['push']);
  expect(r.code).toBe(0);
  expect(r.out).toBe('Pushed chore/ai-workflow-7 to origin.');
  expect(g(bare, 'rev-parse', 'chore/ai-workflow-7')).toBe(g(root, 'rev-parse', 'HEAD'));
  expect(g(root, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/chore/ai-workflow-7');
});

test('commit and push refuse main even when init.defaultBranch says master and there is no origin/HEAD', () => {
  const root = installed();
  g(root, 'config', 'init.defaultBranch', 'master'); // as a global setting would
  expect(run(root, ['commit']).out).toBe('You are on main. Run harness git branch first.');
  expect(run(root, ['push']).out).toBe('You are on main. Harness never pushes the default branch.');
  g(root, 'checkout', '-q', '-b', 'b');
  put(root, '.harness/report.md', 'r');
  expect(run(root, ['pr']).out).toContain('--base main --head b'); // main exists, master does not
});

test('--title takes a value, not a flag', () => {
  const root = installed();
  expect(run(root, ['pr', '--title', '--dry-run']).code).toBe(2);
});

const PRESET = (o = 'no_ai_trailer: true') => `preset:\n  id: khubaib\n  version: "1"\n  items: []\n  git:\n    branch_prefixes: [feature/, fix/, hotfix/, chore/, refactor/, docs/, ci/]\n    ${o}\n    pr_size_warning: true\n`;

test('commit refuses an AI trailer when the preset bans it, and makes no commit', () => {
  const root = installed({ trailer: 'Co-Authored-By: Claude <c@example.com>', preset: PRESET() });
  g(root, 'checkout', '-q', '-b', 'b');
  const before = g(root, 'rev-parse', 'HEAD');
  const r = run(root, ['commit']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('The khubaib preset bans AI trailers; clear git.commit_trailer.');
  expect(g(root, 'rev-parse', 'HEAD')).toBe(before);
});

test('commit keeps the trailer when the preset does not ban it', () => {
  const root = installed({ trailer: 'Co-Authored-By: Someone <s@example.com>', preset: PRESET('no_ai_trailer: false') });
  g(root, 'checkout', '-q', '-b', 'b');
  expect(run(root, ['commit']).code).toBe(0);
});

test('branch --suggest prints the seven names and creates nothing', () => {
  const root = installed({ preset: PRESET() });
  const r = run(root, ['branch', '--suggest', 'Add login form']);
  expect(r.code).toBe(0);
  expect(r.out.split('\n')).toEqual(['feature', 'fix', 'hotfix', 'chore', 'refactor', 'docs', 'ci'].map((p) => `${p}/add-login-form`));
  expect(g(root, 'branch', '--show-current')).toBe('main');
  expect(g(root, 'branch', '--list')).toBe('* main');
});

test('--suggest needs branch and a topic', () => {
  const root = installed({ preset: PRESET() });
  expect(run(root, ['commit', '--suggest', 'x']).code).toBe(2);
  expect(run(root, ['branch', '--suggest']).code).toBe(2);
});

// A fake Git: numstat of `n` files totalling `lines`; every ref resolves.
function fakeGit(lines: number, n: number, fail = false) {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    if (fail) return { status: 1, stdout: '' };
    if (args.includes('--numstat')) return { status: 0, stdout: Array.from({ length: n }, (_, i) => `${i ? Math.floor(lines / n) : lines - Math.floor(lines / n) * (n - 1)}\t0\tf${i}.ts\0`).join('') };
    return { status: 0, stdout: args[0] === 'rev-parse' ? 'abc123\n' : '' };
  };
  return { git, calls };
}
const prRoot = () => {
  const root = installed({ preset: PRESET() });
  g(root, 'checkout', '-q', '-b', 'feature/x');
  put(root, '.harness/report.md', 'r');
  return root;
};
const ghOk = (calls: string[][]): Exec => (cmd, args) => cmd === 'gh' ? (calls.push([cmd, ...args]), { status: 0, stdout: 'url\n' }) : defaultExec(cmd, args);

test('pr warns about an oversized PR, still creates it, and measures base against head', () => {
  const root = prRoot();
  const f = fakeGit(512, 14);
  const calls: string[][] = [];
  const r = run(root, ['pr'], ghOk(calls), f.git);
  expect(r.code).toBe(0);
  expect(r.out.split('\n')[0]).toBe('This PR has 512 changed lines in 14 files; the limit is 400 lines or 20 files.');
  expect(calls.at(-1)?.slice(0, 3)).toEqual(['gh', 'pr', 'create']);
  expect(f.calls.some((a) => a.includes('refs/remotes/origin/main^{commit}'))).toBe(true);
  expect(f.calls.some((a) => a.includes('refs/heads/feature/x^{commit}'))).toBe(true);
});

test("pr applies the branch's recorded raise (N5): no warning under it", () => {
  const root = prRoot();
  writeProgress(root, 'feature/x', { base: 'origin/main', fired: [], lines: 0, files: 0, ts: 't', raise: { lines: 600, files: 20, ts: 't' } });
  expect(run(root, ['pr'], ghOk([]), fakeGit(512, 14).git).out).toBe('url');
  expect(run(root, ['pr'], ghOk([]), fakeGit(612, 14).git).out.split('\n')[0]).toBe('This PR has 612 changed lines in 14 files; the limit is 600 lines or 20 files.');
});

test('pr prints nothing extra under the limit', () => {
  const r = run(prRoot(), ['pr'], ghOk([]), fakeGit(100, 3).git);
  expect(r.out).toBe('url');
});

test('pr says when the size could not be measured', () => {
  const r = run(prRoot(), ['pr'], ghOk([]), fakeGit(0, 0, true).git);
  expect(r.out).toMatch(/^PR size not measured: .+\.\nurl$/);
});

test('--suggest without a preset exits 1 with a message', () => {
  const r = run(installed(), ['branch', '--suggest', 'x']);
  expect(r.code).toBe(1);
  expect(r.out).toBe('No preset is recorded in .harness/config.yaml; nothing to suggest from.');
});

test('on a detached HEAD, pr stops with a clear message and measures nothing; --suggest still works', () => {
  const root = installed({ preset: PRESET() });
  g(root, 'checkout', '-q', '--detach');
  const f = fakeGit(512, 14);
  const r = run(root, ['pr'], ghOk([]), f.git);
  expect(r.code).toBe(1);
  expect(r.out).toBe('You are on a detached HEAD. Run harness git branch first.');
  expect(f.calls).toHaveLength(0);
  expect(run(root, ['branch', '--suggest', 'x']).code).toBe(0);
});
