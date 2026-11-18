import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { review } from '../../src/cli/review.js';
import { defaultExec } from '../../src/core/exec.js';
import { git } from './repo.js';
import { setup, ok, fakeGh, run } from './gather-helpers.js';

describe('gather: §8 rows', () => {
  let s: ReturnType<typeof setup>;
  beforeAll(() => void (s = setup()));
  test('no gh', () => {
    const r = run(s, (c, a, o) => (c === 'gh' ? { status: 127, stdout: '', missing: true } : defaultExec(c, a, o)));
    expect(r).toMatchObject({ code: 1, lines: ['review: needs the GitHub CLI (gh). Install it, run gh auth login, then run the review again.'] });
  });
  test('not authenticated', () => {
    expect(run(s, fakeGh(s, {}, (a) => (a.startsWith('auth') ? { status: 1, stdout: '' } : undefined)).exec)).toMatchObject({ code: 1, lines: ['review: gh is not logged in for github.com (gh auth status failed). Run gh auth login.'] });
  });
  test('not a GitHub repo', () => {
    expect(run(s, fakeGh(s, {}, (a) => (a.startsWith('repo view') ? { status: 1, stdout: '', stderr: 'none of the git remotes point to a known GitHub host' } : undefined)).exec)).toMatchObject({ code: 1, lines: ['review: origin is not a GitHub repo'] });
  });
  test('PR not found', () => {
    const r = run(s, fakeGh(s, {}, (a) => (a.startsWith('pr view') ? { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 7.' } : undefined)).exec);
    expect(r).toMatchObject({ code: 1, lines: ['review: PR #7 not found in o/r: GraphQL: Could not resolve to a PullRequest with the number of 7.'] });
  });
  test('a bad PR argument is exit 2', () => {
    const lines: string[] = [];
    expect(review(['https://github.com/x/y/pull/7', '--out', s.dir], { root: s.root, env: {}, out: (l) => lines.push(l) }, { exec: fakeGh(s).exec })).toBe(2);
    expect(lines[0]).toMatch(/^review: not a PR number or a PR URL in o\/r/);
  });
  test('base without harness', () => {
    const t = setup({ base: { '.harness/config.yaml': null } });
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: ['review: base branch main has no .harness/config.yaml; run harness init on main first'] });
  });
  test('drift', () => {
    const t = setup();
    writeFileSync(join(t.root, '.claude/agents/staff-reviewer.md'), 'agent edited by the PR\n');
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: [`review: .claude/agents/staff-reviewer.md differs from main (${t.base.slice(0, 7)}); run the review from main or a clean worktree of it`] });
  });
  test('a project staff-reviewer that differs from the plugin\'s copy is gathered (the project agent wins, and the drift check covers it)', () => {
    const t = setup({ base: { '.claude/agents/staff-reviewer.md': 'an older or edited agent\n' } });
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 0 });
  });
  test('a harness CLI whose version differs from the base install\'s is refused early', () => {
    const t = setup({ base: { '.harness/manifest.json': '{"version":"0.2.0-beta.1"}' } });
    expect(run(t, fakeGh(t).exec, {}, undefined, '0.2.0-beta.2')).toMatchObject({ code: 1, lines: ['review: harness CLI 0.2.0-beta.2 and the base install (harness 0.2.0-beta.1) differ; run /harness:update on main and review again'] });
  });
  // One case per test: each builds its own repos (about 4 s on windows-latest), and four in one test passed 30 s there.
  test.each([
    ['the same version', '{"version":"0.2.0-beta.2"}', '0.2.0-beta.2'],
    ['an unknown CLI version', '{"version":"0.2.0-beta.1"}', undefined],
    ['no readable manifest version', 'not json', '0.2.0-beta.2'],
    ['a dev CLI', '{"version":"0.2.0-beta.1"}', '0.0.0-dev'],
  ])('%s is not refused', (_, manifest, version) => {
    const t = setup({ base: { '.harness/manifest.json': manifest } });
    expect(run(t, fakeGh(t).exec, {}, undefined, version)).toMatchObject({ code: 0 });
  });
  test('a base without the review agents (an older install) asks for /harness:update', () => {
    const t = setup({ base: { '.claude/agents/review-judge.md': null } });
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: ['review: base branch main has no .claude/agents/review-judge.md (an older harness install); run /harness:update on main first'] });
  });
  test('a rate limit names its reset time', () => {
    const gh = fakeGh(s, {}, (a) => (a.startsWith('pr view') ? { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user (HTTP 403)' } : a.startsWith('api rate_limit') ? ok('1763000000\n') : undefined));
    expect(run(s, gh.exec)).toMatchObject({ code: 1, lines: [`review: GitHub rate limit hit; resets at ${new Date(1763000000 * 1000).toLocaleString()}`] });
  });
  test('invalid base YAML', () => {
    const t = setup({ base: { '.harness/config.yaml': 'a: [\n' } });
    const r = run(t, fakeGh(t).exec);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^review: base branch \.harness\/config\.yaml is not valid YAML: /);
  });
  test('a bad base branch name stops before any fetch', () => {
    expect(run(s, fakeGh(s, { baseRefName: '-x' }).exec)).toMatchObject({ code: 1, lines: ['review: the base branch name "-x" is not a valid branch name'] });
  });
  test('no remote points to the repo', () => {
    const t = setup();
    git(t.root, 'remote', 'set-url', 'origin', 'https://github.com/x/y.git');
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: ['review: no git remote points to github.com/o/r; add one, for example: git remote add upstream https://github.com/o/r.git'] });
  });
  test('a shallow clone stops with how to fix it', () => {
    const t = setup();
    writeFileSync(join(t.root, '.git', 'shallow'), `${t.base}\n`);
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: ['review: this clone is shallow; fetch the full history (git fetch --unshallow) and retry'] });
  });
  test('a base branch deleted on the remote is named', () => {
    const t = setup();
    git(t.bare, 'update-ref', '-d', 'refs/heads/main');
    expect(run(t, fakeGh(t).exec)).toMatchObject({ code: 1, lines: ['review: base branch main is not on origin (deleted?); a PR whose base branch is gone cannot be reviewed'] });
  });
  test('head moved during fetch', () => {
    expect(run(s, fakeGh(s, { headRefOid: 'c'.repeat(40) }).exec)).toMatchObject({ code: 1, lines: ['review: PR head moved during fetch; run again'] });
  });
  test('--out must be an empty workdir folder', () => {
    const lines: string[] = [];
    expect(review(['7', '--out', 'src'], { root: s.root, env: {}, out: (l) => lines.push(l) }, { exec: fakeGh(s).exec })).toBe(2);
    expect(review(['7'], { root: s.root, env: {}, out: (l) => lines.push(l) })).toBe(2);
  });
});
