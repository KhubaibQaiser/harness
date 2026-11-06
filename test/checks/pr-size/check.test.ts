import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { decidePrSize, prSize, readRecords, RECORD, writeRecord } from '../../../src/checks/pr-size/check.js';
import { PROGRESS, readProgress } from '../../../src/checks/pr-size/progress.js';
import { raiseLimits } from '../../../src/checks/pr-size/raise.js';
import { defaults } from '../../../src/core/config.js';
import { readEvents } from '../../../src/core/events.js';
import { registry } from '../../../src/hooks/dispatch.js';
import { commit, ctx, fakeGit, git, lines, repo, send } from './helpers.js';

const out = async (p: Promise<string>) => (await p ? JSON.parse(await p).hookSpecificOutput : {}) as { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
const reason = (d: ReturnType<typeof decidePrSize>) => ('reason' in d ? d.reason : '');
const ASK_END = 'Approve to open it as it is, or say no and run the pr-ship skill to split it into stacked PRs.';
const PUSH_END = 'Approve to push it as it is, or say no and run the pr-ship skill to split it.';
const note = (why: string, base: string) =>
  `Note from pr-size: harness couldn't measure this pull request (${why}), so its size against the limit of 400 lines or 20 files wasn't checked. To check it yourself, run \`node .harness/hooks/dispatch.mjs --pr-size --base ${base}\`.`;

const chmodded: string[] = [];
afterEach(() => void chmodded.splice(0).forEach((p) => chmodSync(p, 0o755)));

describe('thresholds', () => {
  test('400 lines allows; 401 asks with the exact create copy', () => {
    expect(decidePrSize(ctx(repo({ 'src/a.ts': lines(400) }), 'gh pr create'))).toEqual({ kind: 'allow' });
    const root = repo({ 'src/a.ts': lines(300), 'src/b.ts': lines(100), 'test/a.test.ts': lines(1), 'pnpm-lock.yaml': lines(9) });
    expect(decidePrSize(ctx(root, 'gh pr create'))).toEqual({
      kind: 'ask', check: 'pr-size',
      reason: `Confirm: this pull request is 401 changed lines in 3 files against \`origin/main\`, over the limit of 400 lines or 20 files (aim for 200). Largest: \`src/a.ts\` 300, \`src/b.ts\` 100, \`test/a.test.ts\` 1. Not counted: \`pnpm-lock.yaml\`. ${ASK_END}`,
    });
  });

  test('20 files allows, 21 asks; max_lines 10 asks at 11', () => {
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.ts`, 'x\n']));
    expect(decidePrSize(ctx(repo(files(20)), 'gh pr create')).kind).toBe('allow');
    expect(decidePrSize(ctx(repo(files(21)), 'gh pr create')).kind).toBe('ask');
    const root = repo({ 'a.ts': lines(11) });
    expect(decidePrSize(ctx(root, 'gh pr create', { config: (c) => (c.pr_size.max_lines = 10) })).kind).toBe('ask');
    expect(decidePrSize(ctx(root, 'gh pr create', { config: (c) => (c.pr_size.max_lines = 11) })).kind).toBe('allow');
  });

  test('more than 5 excluded paths: the first 5, then "and N more"', () => {
    const ex = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((d) => [`${d}/yarn.lock`, 'x\n']));
    const r = reason(decidePrSize(ctx(repo({ 'a.ts': lines(401), ...ex }), 'gh pr create')));
    expect(r).toContain('Not counted: `a/yarn.lock`, `b/yarn.lock`, `c/yarn.lock`, `d/yarn.lock`, `e/yarn.lock`, and 2 more. Approve');
    expect(reason(decidePrSize(ctx(repo({ 'a.ts': lines(401) }), 'gh pr create')))).toContain('Largest: `a.ts` 401. Approve');
  });
});

describe('off switches and unattended', () => {
  test('checks.prSize false allows; checks.guard false still asks; non-shell tools allow', () => {
    const root = repo({ 'a.ts': lines(401) });
    expect(decidePrSize(ctx(root, 'gh pr create', { config: (c) => (c.checks.prSize = false) }))).toEqual({ kind: 'allow' });
    expect(decidePrSize(ctx(root, 'gh pr create', { config: (c) => (c.checks.guard = false) })).kind).toBe('ask');
    expect(decidePrSize(ctx(root, 'gh pr create', { tool: 'Edit' }))).toEqual({ kind: 'allow' });
  });

  test('HARNESS_UNATTENDED=1 through dispatch denies with the 10.2 copy, no Unattended run: prefix', async () => {
    const root = repo({ 'a.ts': lines(512) });
    const d = await out(send(root, 'PreToolUse', 'gh pr create', { HARNESS_UNATTENDED: '1' }, registry));
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toBe(
      'Blocked by pr-size: this pull request is 512 changed lines in 1 file against `origin/main`, over the limit of 400 lines or 20 files, and no person is here to approve it. Split it with the pr-ship skill into stacked PRs of about 200 lines each, opening each with `--base` set to the branch before it. If a piece can\'t go under the limit, stop and report it.',
    );
  });
});

describe('unmeasured', () => {
  test.each([false, true])('a missing base allows with the note and one event (unattended %s)', async (un) => {
    const root = repo({ 'a.ts': lines(512) });
    const d = await out(send(root, 'PreToolUse', 'gh pr create --base nope', un ? { HARNESS_UNATTENDED: '1' } : {}));
    expect(d.permissionDecision).toBeUndefined();
    expect(d.additionalContext).toBe(note('base `nope` not found; fetch it first', 'nope'));
    expect(readEvents(root).filter((e) => e.decision === 'pr-size-unmeasured')).toEqual([expect.objectContaining({ check: 'pr-size', reason: 'base `nope` not found; fetch it first' })]);
  });

  test.each([
    ['ENOENT', 'git not found'], ['ETIMEDOUT', 'git timed out'],
  ])('a fake %s allows with the note, attended and unattended', (code, why) => {
    for (const unattended of [false, true]) {
      const root = repo();
      const f = fakeGit({ status: null, stdout: '', error: Object.assign(new Error(code), { code }) });
      expect(decidePrSize(ctx(root, 'gh pr create', { unattended }), f.g)).toEqual({ kind: 'context', check: 'pr-size', text: note(why, '<base>') });
      expect(readEvents(root).filter((e) => e.decision === 'pr-size-unmeasured').map((e) => e.reason)).toEqual([why]);
    }
  });
});

describe('several targets', () => {
  test('--base a && --base b, only b over, asks about b', () => {
    const root = repo();
    git(root, 'branch', 'b');
    commit(root, { 'a.ts': lines(401) });
    git(root, 'branch', 'a');
    expect(reason(decidePrSize(ctx(root, 'gh pr create --base a && gh pr create --base b')))).toContain('against `b`');
  });

  test('a quoted "--base main" never becomes the recorded base (Task 5 carry)', async () => {
    const root = repo();
    git(root, 'branch', 'stack/a');
    commit(root, { 'a.ts': lines(10) });
    await send(root, 'PostToolUse', 'gh pr create --base stack/a --title "use --base main"');
    expect(readRecords(root).feat).toMatchObject({ base: 'stack/a', lines: 10, files: 1 });
    await send(root, 'PostToolUse', "gh pr create --title 'x -B main'");
    expect(readRecords(root).feat).toMatchObject({ base: 'origin/main' });
  });
});

describe('push', () => {
  test('PostToolUse after a create writes the record', async () => {
    const root = repo({ 'a.ts': lines(30) });
    expect(await send(root, 'PostToolUse', 'gh pr create')).toBe('');
    const recs = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
    expect(recs).toEqual({ feat: { base: 'origin/main', lines: 30, files: 1, ts: expect.any(String) } });
  });

  test('a push that grows past the limit asks; one that does not grow allows; PostToolUse updates lines', async () => {
    const root = repo({ 'a.ts': lines(380), b: 'x\n' });
    writeRecord(root, 'feat', { base: 'origin/main', lines: 380, files: 2, ts: 't' });
    commit(root, { 'c.ts': lines(132) });
    expect(reason(decidePrSize(ctx(root, 'git push')))).toBe(
      `Confirm: this push grows the pull request for \`feat\` to 513 changed lines in 3 files (it was 380 in 2). Largest: \`a.ts\` 380, \`c.ts\` 132, \`b\` 1. ${PUSH_END}`,
    );
    const un = decidePrSize(ctx(root, 'git push', { unattended: true }));
    expect(un).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^Blocked by pr-size: this push grows the pull request for `feat` to 513 changed lines in 3 files \(it was 380 in 2\), over the limit of 400 lines or 20 files, and no person/) });
    await send(root, 'PostToolUse', 'git push');
    expect(readRecords(root).feat).toMatchObject({ base: 'origin/main', lines: 513, files: 3 });
    expect(decidePrSize(ctx(root, 'git push'))).toEqual({ kind: 'allow' });
  });

  test.each(['git push origin HEAD:feat', 'git push origin +feat', 'git push -u origin feat', 'git push --all', 'git push origin HEAD', 'git push -u origin HEAD', 'git push origin @', 'git push origin refs/heads/feat'])('%s finds feat', (c) => {
    const root = repo({ 'a.ts': lines(401) });
    writeRecord(root, 'feat', { base: 'origin/main', lines: 0, files: 0, ts: 't' });
    expect(reason(decidePrSize(ctx(root, c)))).toContain('pull request for `feat`');
  });

  test('an unrecorded branch allows with no measurement', () => {
    const f = fakeGit();
    expect(decidePrSize(ctx(repo(), 'git push origin other'), f.g)).toEqual({ kind: 'allow' });
    expect(f.diffs()).toEqual([]);
  });

  test('a detached-HEAD create records nothing', async () => {
    const root = repo({ 'a.ts': lines(3) });
    git(root, 'checkout', '-q', '--detach');
    await send(root, 'PostToolUse', 'gh pr create');
    expect(existsSync(join(root, RECORD))).toBe(false);
  });

  test('an unmeasured create with no record yet is recorded with 0 lines', async () => {
    const root = repo({ 'a.ts': lines(3) });
    await send(root, 'PostToolUse', 'gh pr create --base nope');
    expect(readRecords(root).feat).toMatchObject({ base: 'nope', lines: 0, files: 0 });
  });
});

describe('latency and review focus', () => {
  test('ls && git status spawns no git', () => {
    const f = fakeGit();
    expect(decidePrSize(ctx(repo(), 'ls && git status'), f.g)).toEqual({ kind: 'allow' });
    expect(f.calls).toEqual([]);
  });

  test.each(['not json', '[]', '{"feat":{"lines":"x"}}'])('pr-branches.json %s reads as {} and a push PostToolUse allows', (body) => {
    const root = repo();
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeFileSync(join(root, RECORD), body);
    expect(readRecords(root)).toEqual({});
    expect(decidePrSize(ctx(root, 'git push origin feat', { event: 'PostToolUse' }))).toEqual({ kind: 'allow' });
  });

  // chmod can't make a folder read-only on Windows, and root ignores it.
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a writeAtomic failure (read-only .harness/state) allows at PostToolUse', () => {
    const root = repo({ 'a.ts': lines(3) });
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    chmodSync(join(root, '.harness/state'), 0o555);
    chmodded.push(join(root, '.harness/state'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(decidePrSize(ctx(root, 'gh pr create', { event: 'PostToolUse' }))).toEqual({ kind: 'allow' });
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^harness: pr-size record failed: EACCES/));
    err.mockRestore();
  });

  test.each(['constructor', 'toString'])('git push origin %s with no record allows and measures nothing', (b) => {
    const f = fakeGit();
    expect(decidePrSize(ctx(repo(), `git push origin ${b}`), f.g)).toEqual({ kind: 'allow' });
    expect(f.diffs()).toEqual([]);
  });

  test('a counted file named a\\u202eb.ts is escaped in the ask', () => {
    const root = repo({ 'a‮b.ts': lines(401) });
    expect(reason(decidePrSize(ctx(root, 'gh pr create')))).toContain('Largest: `a\\u202eb.ts` 401.');
  });
});

describe('wiring', () => {
  test('registered second, on by default, fail-closed and not pure (PostToolUse writes pr-branches.json)', () => {
    expect(registry[1]!.name).toBe('pr-size');
    expect(defaults().checks.prSize).toBe(true);
    expect(prSize).toMatchObject({ name: 'pr-size', events: ['PreToolUse', 'PostToolUse', 'Stop'], failClosed: true, pure: false });
  });
});

describe('raise (spec §14.4)', () => {
  const RAISE = 'node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600 --files 30';
  const ENTRY = (b: string) => ({ stdout: `${JSON.stringify({ branch: b, lines: 600, files: 30 })}\n`, stderr: '' });
  const raised = (root: string) => readEvents(root).filter((e) => e.decision === 'pr-size-raised');
  test('raiseLimits checks the ranges', () => {
    const c = defaults().pr_size;
    expect(raiseLimits({ lines: '400' }, c)).toEqual({ error: '--lines must be an integer from 401 to 100000' });
    expect(raiseLimits({}, c)).toEqual({ error: '--lines must be an integer from 401 to 100000' });
    expect(raiseLimits({ lines: '600' }, c)).toEqual({ lines: 600, files: 20 });
    expect(raiseLimits({ lines: '600', files: '19' }, c)).toEqual({ error: '--files must be an integer from 20 to 10000' });
    expect(raiseLimits({ lines: '100001' }, c)).toHaveProperty('error');
    expect(raiseLimits({ lines: '6e2' }, c)).toHaveProperty('error');
    expect(raiseLimits({ lines: '600', files: '10001' }, c)).toHaveProperty('error');
  });

  test('attended asks with the exact copy; unattended denies', () => {
    const root = repo();
    expect(decidePrSize(ctx(root, RAISE))).toEqual({ kind: 'ask', check: 'pr-size', reason: 'Confirm: raise the pull request size limit for `feat` to 600 lines and 30 files. Harness then warns again only above that.' });
    expect(decidePrSize(ctx(root, RAISE, { unattended: true }))).toEqual({ kind: 'deny', check: 'pr-size', reason: 'Blocked by pr-size: only a person can raise the size limit, and no person is here to approve it.' });
  });

  test('invalid values or the hidden $X form allow; a detached HEAD denies; PostToolUse then records nothing', async () => {
    const root = repo();
    for (const c of ['node .harness/hooks/dispatch.mjs --pr-size-raise --lines 400', '$X --pr-size-raise --lines 600']) {
      expect(decidePrSize(ctx(root, c))).toEqual({ kind: 'allow' });
      await send(root, 'PostToolUse', c);
    }
    git(root, 'checkout', '-q', '--detach');
    expect(decidePrSize(ctx(root, RAISE))).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/needs a checked-out branch/) });
    await send(root, 'PostToolUse', RAISE, {}, [prSize], ENTRY('feat'));
    expect(existsSync(join(root, PROGRESS))).toBe(false);
    expect(raised(root)).toEqual([]);
  });

  test('after an allowed run, pr-progress.json has the raise and one pr-size-raised event', async () => {
    const root = repo();
    expect(decidePrSize(ctx(root, RAISE)).kind).toBe('ask');
    expect(await send(root, 'PostToolUse', RAISE, {}, [prSize], ENTRY('feat'))).toBe('');
    expect(readProgress(root).feat?.raise).toEqual({ lines: 600, files: 30, ts: expect.any(String) });
    expect(raised(root)).toEqual([expect.objectContaining({ check: 'pr-size', reason: 'feat 600 lines 30 files' })]);
  });

  test('PR time: a create on a raised branch allows at 500 and asks at 601 with the raised limit; a raised push too', async () => {
    const root = repo({ 'a.ts': lines(500) });
    decidePrSize(ctx(root, RAISE));
    await send(root, 'PostToolUse', RAISE, {}, [prSize], ENTRY('feat'));
    expect(decidePrSize(ctx(root, 'gh pr create'))).toEqual({ kind: 'allow' });
    commit(root, { 'b.ts': lines(101) });
    expect(reason(decidePrSize(ctx(root, 'gh pr create')))).toMatch(/^Confirm: this pull request is 601 changed lines in 2 files against `origin\/main`, over the limit of 600 lines or 30 files \(aim for 200\)\./);
    writeRecord(root, 'feat', { base: 'origin/main', lines: 500, files: 1, ts: 't' });
    expect(decidePrSize(ctx(root, 'git push')).kind).toBe('ask');
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    commit(root, { 'b.ts': lines(50) });
    expect(decidePrSize(ctx(root, 'git push'))).toEqual({ kind: 'allow' });
  });
});

describe('a raise runs on its own', () => {
  const R = 'node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600';
  const ALONE = 'Blocked by pr-size: run one `--pr-size-raise` on its own, with no second raise and no branch, directory or repo change in the same command.';
  test.each([
    `git checkout main && ${R}`, `git switch main; ${R}`, `git -C ../other status && ${R}`, `cd ../other && ${R}`, `pushd ../other && ${R}`,
    `git worktree add ../w main && ${R}`, `git --git-dir=../o/.git status && ${R}`, `GIT_DIR=../o/.git ${R}`, `${R} && ${R.replace('600', '900')}`,
  ])('%s is denied (unattended: the person-only deny comes first), and PostToolUse records nothing', async (c) => {
    const root = repo();
    expect(decidePrSize(ctx(root, c))).toEqual({ kind: 'deny', check: 'pr-size', reason: ALONE });
    expect(decidePrSize(ctx(root, c, { unattended: true }))).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^Blocked by pr-size: only a person can raise/) });
    await send(root, 'PostToolUse', c);
    expect(existsSync(join(root, PROGRESS))).toBe(false);
  });

  test('a plain raise still asks', () => {
    expect(decidePrSize(ctx(repo(), R)).kind).toBe('ask');
  });
});
