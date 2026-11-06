import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { decidePrSize, prSize } from '../../../src/checks/pr-size/check.js';
import { PROGRESS, readProgress } from '../../../src/checks/pr-size/progress.js';
import { readEvents } from '../../../src/core/events.js';
import { registry } from '../../../src/hooks/dispatch.js';
import { ctx, git, lines, repo, send } from './helpers.js';

const R = 'node .harness/hooks/dispatch.mjs --pr-size-raise --lines 100000 --files 10000';
const ENTRY = (b: string) => ({ stdout: `${JSON.stringify({ branch: b, lines: 100000, files: 10000 })}\n`, stderr: '' });
const raises = (root: string) => Object.entries(readProgress(root)).filter(([, p]) => p.raise).map(([b]) => b);
const events = (root: string, d: string) => readEvents(root).filter((e) => e.decision === d);
const pre = async (root: string, command: string, env: NodeJS.ProcessEnv = {}) => {
  const out = await send(root, 'PreToolUse', command, env, registry);
  return out ? JSON.parse(out).hookSpecificOutput : {};
};

describe('critical: detached at PreToolUse, a branch at PostToolUse', () => {
  test.each([['unattended', { HARNESS_UNATTENDED: '1' }, /^Blocked by pr-size: only a person can raise/], ['attended', {}, /^Blocked by pr-size: a raise needs a checked-out branch/]] as const)(
    '%s: the full registry denies, and PostToolUse records nothing', async (_, env, why) => {
      const root = repo({ 'a.ts': lines(5000) });
      git(root, 'checkout', '-q', '--detach');
      const c = `git symbolic-ref HEAD refs/heads/feat && ${R}`;
      expect(await pre(root, c, env)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(why) });
      git(root, 'symbolic-ref', 'HEAD', 'refs/heads/feat');
      await send(root, 'PostToolUse', c, env, registry, ENTRY('feat'));
      expect(raises(root)).toEqual([]);
      expect((await pre(root, 'gh pr create', env)).permissionDecision).not.toBe(undefined);
    },
  );

  test('unattended, any detected raise is denied first, even with invalid values or beside a branch change', () => {
    for (const c of ['node .harness/hooks/dispatch.mjs --pr-size-raise --lines 1', `git checkout main && ${R}`]) {
      expect(decidePrSize(ctx(repo(), c, { unattended: true }))).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/only a person can raise/) });
    }
  });
});

describe('backstop: recorded only on the branch the dialog named', () => {
  test.each([
    ['gh pr checkout 5', ['checkout', '-q', '-b', 'pr-5'], 'pr-5'],
    ['git co main', ['checkout', '-q', 'main'], 'main'],
    ['git symbolic-ref HEAD refs/heads/main', ['symbolic-ref', 'HEAD', 'refs/heads/main'], 'main'],
    ['git $(printf checkout) main', ['checkout', '-q', 'main'], 'main'],
    ['git branch -m feat2', ['branch', '-m', 'feat2'], 'feat2'],
  ])('%s && <raise>: asks about feat, then records no raise anywhere and logs why', async (move, gitArgs, landed) => {
    const root = repo();
    const c = `${move} && ${R}`;
    expect(decidePrSize(ctx(root, c))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('for `feat`') });
    git(root, ...gitArgs);
    await send(root, 'PostToolUse', c, {}, [prSize], ENTRY(landed));
    expect(raises(root)).toEqual([]);
    expect(events(root, 'pr-size-raise-skipped')).toEqual([expect.objectContaining({ reason: 'HEAD is no longer `feat`' })]);
  });

  test('a PostToolUse for a command that was never asked, or a failed entry, records nothing', async () => {
    const root = repo();
    await send(root, 'PostToolUse', R, {}, [prSize], ENTRY('feat'));
    decidePrSize(ctx(root, R));
    await send(root, 'PostToolUse', R, {}, [prSize], { stdout: '{"error":"`.harness/config.yaml` is invalid"}\n', stderr: '' });
    expect(raises(root)).toEqual([]);
    expect(events(root, 'pr-size-raise-skipped').map((e) => e.reason)).toEqual(['no matching ask for this command', 'the raise command did not succeed']);
  });

  test('the ask is used once', async () => {
    const root = repo();
    decidePrSize(ctx(root, R));
    await send(root, 'PostToolUse', R, {}, [prSize], ENTRY('feat'));
    await send(root, 'PostToolUse', R, {}, [prSize], ENTRY('feat'));
    expect(raises(root)).toEqual(['feat']);
    expect(events(root, 'pr-size-raised')).toHaveLength(1);
  });
});

describe('one dialog for a raise and a PR', () => {
  test('an over-limit create joins as "Also, this pull request …"', () => {
    const d = decidePrSize(ctx(repo({ 'a.ts': lines(512) }), `${R} && gh pr create`));
    expect(d).toMatchObject({ kind: 'ask', reason: expect.stringContaining('only above that. Also, this pull request is 512 changed lines') });
    expect('reason' in d && d.reason).not.toMatch(/Also: Confirm/);
  });

  test('an unmeasured create keeps its note in the dialog', () => {
    const d = decidePrSize(ctx(repo(), `${R} && gh pr create --base nope`));
    expect(d).toMatchObject({ kind: 'ask', reason: expect.stringContaining('only above that. Note from pr-size: harness couldn\'t measure') });
  });
});

describe('hook events come only from Claude Code', () => {
  const HAND = /^Blocked by pr-size: hook events come only from Claude Code\./;
  test.each([
    'node .harness/hooks/dispatch.mjs < /tmp/pre.json', 'cat /tmp/pre.json | node .harness/hooks/dispatch.mjs', 'npx node .harness/hooks/dispatch.mjs < p',
    'env node ./.harness/hooks/dispatch.mjs < p', 'bash -c "node .harness/hooks/dispatch.mjs < p"', 'node "C:\\r\\.harness\\hooks\\dispatch.mjs" < p',
    '$X .harness/hooks/dispatch.mjs < p', './.harness/hooks/dispatch.mjs < p', 'node < .harness/hooks/dispatch.mjs',
    'cp .harness/hooks/dispatch.mjs /tmp/d.mjs', 'mv .harness/hooks/dispatch.mjs /tmp/d.mjs', 'ln -s "$PWD/.harness/hooks/dispatch.mjs" /tmp/d.mjs',
    'cat .harness/hooks/dispatch.mjs > /tmp/d.mjs', 'cat .harness/hooks/dispatch.mjs | tee /tmp/d.mjs', 'rsync .harness/hooks/ /tmp/h/', 'cp -r .harness/hooks /tmp/h',
  ])('%s is denied attended and unattended; the full registry never allows it', async (c) => {
    const root = repo();
    for (const unattended of [false, true]) expect(decidePrSize(ctx(root, c, { unattended }))).toMatchObject({ kind: 'deny', reason: expect.stringMatching(HAND) });
    // An earlier check (the guard, on a hidden `$X`) may answer first; whichever does, the command doesn't run unasked.
    for (const env of [{}, { HARNESS_UNATTENDED: '1' }]) expect(['deny', 'ask']).toContain((await pre(root, c, env)).permissionDecision);
    expect((await pre(root, c, { HARNESS_UNATTENDED: '1' })).permissionDecision).toBe('deny');
  });

  test.each(['node .harness/hooks/dispatch.mjs --pr-size --worktree', 'node .harness/hooks/dispatch.mjs --self-test', 'cat .harness/hooks/dispatch.mjs', 'ls .harness/hooks', 'git diff -- src/hooks/dispatch.ts'])('%s is not a hand run', (c) => {
    expect(decidePrSize(ctx(repo(), c))).not.toMatchObject({ kind: 'deny' });
  });

  test("the reviewer's repro (sandbox: off, unattended): the forged-event commands are denied, and nothing is recorded", async () => {
    const root = repo();
    mkdirSync(join(root, '.harness'), { recursive: true });
    writeFileSync(join(root, '.harness', 'config.yaml'), 'sandbox: off\n');
    const env = { HARNESS_UNATTENDED: '1' };
    for (const c of ['cp .harness/hooks/dispatch.mjs /tmp/d.mjs', 'node .harness/hooks/dispatch.mjs < /tmp/pre.json', 'cat /tmp/pre.json | node .harness/hooks/dispatch.mjs', 'node .harness/hooks/dispatch.mjs < /tmp/post.json']) {
      expect((await pre(root, c, env)).permissionDecision).toBe('deny');
    }
    expect(existsSync(join(root, PROGRESS))).toBe(false);
  });
});

test('a package script rewritten during the run: 600 in the dialog, 100000 printed, nothing recorded', async () => {
  const root = repo();
  const pj = (n: number) => JSON.stringify({ scripts: { raise: `node x.js && node .harness/hooks/dispatch.mjs --pr-size-raise --lines ${n}` } });
  writeFileSync(join(root, 'package.json'), pj(600));
  expect(decidePrSize(ctx(root, 'npm run raise'))).toMatchObject({ kind: 'ask', reason: expect.stringContaining('to 600 lines and 20 files') });
  writeFileSync(join(root, 'package.json'), pj(100000));
  await send(root, 'PostToolUse', 'npm run raise', {}, [prSize], { stdout: `${JSON.stringify({ branch: 'feat', lines: 100000, files: 20 })}\n`, stderr: '' });
  expect(raises(root)).toEqual([]);
  expect(events(root, 'pr-size-raise-skipped')).toEqual([expect.objectContaining({ reason: 'the values changed since the dialog (600/20)' })]);
});
