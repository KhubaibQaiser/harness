// Review round 1: deletes and tags, the shared time budget, base == head, wrapped creates, failed creates, singular copy.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { guard } from '../../../src/checks/guard.js';
import { decidePrSize, prSize } from '../../../src/checks/pr-size/check.js';
import { readRecords, RECORD, writeRecord } from '../../../src/checks/pr-size/records.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
import { readEvents } from '../../../src/core/events.js';
import { commit, ctx, fakeGit, git, lines, repo, send } from './helpers.js';

const over = () => {
  const root = repo({ 'a.ts': lines(500) });
  writeRecord(root, 'feat', { base: 'origin/main', lines: 10, files: 1, ts: 't' });
  return root;
};

describe('deletes and tags give no verdict', () => {
  test.each(['git push origin --delete old', 'git push origin :old', 'git push -d origin old', 'git push --tags', 'git push origin refs/tags/v1', 'git push origin v1:refs/tags/v1'])('%s allows and leaves the record', (c) => {
    const root = over();
    expect(decidePrSize(ctx(root, c))).toEqual({ kind: 'allow' });
    expect(decidePrSize(ctx(root, c, { unattended: true }))).toEqual({ kind: 'allow' });
    decidePrSize(ctx(root, c, { event: 'PostToolUse' }));
    expect(readRecords(root).feat).toMatchObject({ lines: 10 });
  });
});

describe('one time budget for the whole command', () => {
  test('a slow git: the first create is measured, the rest get a note, never a silent allow', () => {
    let t = 0;
    const STEP = 1500; // each git call costs 1.5 s of fake time; one measure is 4 calls, the whole 6 s budget
    const g: Git = (args) => ((t += STEP), { status: 0, stdout: args.includes('diff') ? '' : 'abc\n' });
    const root = repo();
    const d = decidePrSize(ctx(root, 'gh pr create --base a && gh pr create --base b && gh pr create --base c'), g, () => t);
    expect(d.kind).toBe('context');
    const text = 'text' in d ? d.text : '';
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('(the time budget for this command ran out)');
    expect(text).toContain('--base b`');
    expect(text).toContain('--base c`');
    expect(readEvents(root).filter((e) => e.decision === 'pr-size-unmeasured')).toHaveLength(2);
  });
});

describe('the hook budget', () => {
  test('a push with nothing recorded spawns no git', () => {
    const f = fakeGit();
    expect(decidePrSize(ctx(repo(), 'git push origin HEAD'), f.g)).toEqual({ kind: 'allow' });
    expect(f.calls).toEqual([]);
  });

  test('HEAD @ HEAD @ HEAD resolves the current branch once, inside the budget, and notes it', () => {
    let t = 0;
    const g: Git = (_, timeout) => ((t += timeout), { status: null, stdout: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
    const d = decidePrSize(ctx(over(), 'git push origin HEAD @ HEAD @ HEAD'), g, () => t);
    expect(t).toBeLessThanOrEqual(6000);
    expect(d).toMatchObject({ kind: 'context', text: expect.stringContaining('(git timed out)') });
  });

  test('a hook already 8 s old leaves pr-size about 1 s, and the target is noted', () => {
    let t = 100_000;
    const spent: number[] = [];
    const g: Git = (args, timeout) => (spent.push(timeout), (t += timeout), { status: 0, stdout: args.includes('diff') ? '' : 'abc\n' });
    const c = { ...ctx(repo(), 'gh pr create --base a'), startedAt: 92_000 };
    const d = decidePrSize(c, g, () => t);
    expect(spent.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
    expect(d.kind).toBe('context');
  });

  test('after a guard deny, pr-size measures nothing (not pure)', async () => {
    const root = over();
    const f = fakeGit();
    const out = await send(root, 'PreToolUse', 'git push origin feat && git push origin main', {}, [guard, { ...prSize, run: (c) => decidePrSize(c, f.g) }]);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(f.calls).toEqual([]);
  });
});

describe('recording', () => {
  test('a create whose base is its own head does not reset the record', () => {
    const root = over();
    decidePrSize(ctx(root, 'gh pr create --base feat', { event: 'PostToolUse' }));
    expect(readRecords(root).feat).toMatchObject({ base: 'origin/main', lines: 10 });
    const fresh = repo({ 'a.ts': lines(3) });
    decidePrSize(ctx(fresh, 'gh pr create --base feat', { event: 'PostToolUse' }));
    expect(existsSync(join(fresh, RECORD))).toBe(false);
  });

  test('a create inside bash -c is recorded with the base from the inner words', () => {
    const root = repo();
    git(root, 'branch', 'stack/a');
    commit(root, { 'a.ts': lines(4) });
    decidePrSize(ctx(root, `bash -c "gh pr create --base stack/a --title 'use --base main'"`, { event: 'PostToolUse' }));
    expect(readRecords(root).feat).toMatchObject({ base: 'stack/a', lines: 4 });
  });

  test('a create whose base is in a package script is recorded against the default base', () => {
    const root = repo({ 'package.json': JSON.stringify({ scripts: { ship: 'gh pr create --base dev' } }) });
    decidePrSize(ctx(root, 'npm run ship', { event: 'PostToolUse' }));
    expect(readRecords(root).feat).toMatchObject({ base: 'origin/main', files: 1 });
  });

  test.each([
    ['no tool_response', undefined], ['no PR URL in the output', { stdout: '', stderr: 'GraphQL: error', interrupted: false, isImage: false }],
  ])('a create with %s is not recorded (a failed create hidden by `|| true`)', (_, response) => {
    const root = repo({ 'a.ts': lines(3) });
    decidePrSize(ctx(root, 'gh pr create || true', { event: 'PostToolUse', response }));
    expect(existsSync(join(root, RECORD))).toBe(false);
  });
});

describe('copy', () => {
  test('one file and one line are singular, two lines plural', () => {
    const root = repo({ 'a.ts': lines(2) });
    const d = decidePrSize(ctx(root, 'gh pr create', { config: (c) => ((c.pr_size.max_lines = 1), (c.pr_size.max_files = 1), (c.pr_size.target_lines = 1)), unattended: true }));
    expect('reason' in d && d.reason).toBe('Blocked by pr-size: this pull request is 2 changed lines in 1 file against `origin/main`, over the limit of 1 line or 1 file, and no person is here to approve it. Split it with the pr-ship skill into stacked PRs of about 1 line each, opening each with `--base` set to the branch before it. If a piece can\'t go under the limit, stop and report it.');
  });
});
