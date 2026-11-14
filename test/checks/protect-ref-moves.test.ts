// Git commands that move the worktree to another ref can change protected harness files without a direct write.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, dispatch, registry } from '../../src/hooks/dispatch.js';

let repo = '';
const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const run = (command: string, unattended = false) => {
  const config = loadConfig('/nonexistent-harness-root').config;
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, tool_name: 'Bash', tool_input: { command } };
  return protect.run({ input, root: repo, config, env: {}, unattended } as unknown as Ctx) as { kind: string; reason?: string };
};
const CFG = '.harness/config.yaml';
const ASK = (c: string, ps = CFG) => ({ kind: 'ask', reason: `\`${c}\` changes harness's protected files (${ps}). Confirm it.`, check: 'protect' });
const DENY = (c: string, ps = CFG) => ({ kind: 'deny', reason: `\`${c}\` changes harness's protected files (${ps}). Unattended runs can't change harness's protected files through git; the person runs it.`, check: 'protect' });
const FAIL = (c: string) => ({ kind: 'ask', reason: `Could not check what \`${c}\` changes in harness's protected files. Confirm it.`, check: 'protect' });
const FAIL_DENY = (c: string) => ({ kind: 'deny', reason: `Could not check what \`${c}\` changes in harness's protected files. Unattended runs can't change harness's protected files through git; the person runs it.`, check: 'protect' });
let cfgCommit = '', srcCommit = '';

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'h-refmove-')));
  g('init', '-q', '-b', 'main');
  mkdirSync(join(repo, '.harness/hooks'), { recursive: true });
  writeFileSync(join(repo, '.harness/hooks/dispatch.mjs'), '');
  writeFileSync(join(repo, CFG), 'sandbox: always\n');
  writeFileSync(join(repo, 'a.ts'), 'x');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('checkout', '-q', '-b', 'other');
  writeFileSync(join(repo, CFG), 'sandbox: off\n');
  g('commit', '-q', '-am', 'sandbox off');
  cfgCommit = g('rev-parse', 'HEAD');
  g('checkout', '-q', '-b', 'src-only', 'main');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/b.ts'), 'y');
  g('add', 'src');
  g('commit', '-q', '-m', 'src only');
  srcCommit = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  // stash@{1}: a src-only change; stash@{0}: a config.yaml change.
  writeFileSync(join(repo, 'a.ts'), 'z');
  g('stash', '-q');
  writeFileSync(join(repo, CFG), 'sandbox: off\n');
  g('stash', '-q');
});

describe('git ref moves that change protected harness files', () => {
  test.each([
    'git checkout other', 'git switch other', 'git checkout -b x other', 'git switch --detach other',
    'git restore --source=other .harness/config.yaml', 'git restore -s other .harness', 'git restore --source=other -- ":(exclude)src"', 'git checkout other -- ":(exclude)src"', 'git checkout other "*.yaml"', 'git checkout .harness/config.yaml a.ts',
    'git reset --hard other', 'git reset --keep other', 'git reset --merge other',
    'git merge other', 'git rebase other', 'git rebase --onto other main',
    'git read-tree -u --reset other',
  ])('%s asks attended and denies unattended', (c) => {
    const a = run(c), d = run(c, true);
    if (/restore| -- |"|\.harness\//.test(c)) {
      // A named protected path is a direct write: denied either way (the existing rule). A pathspec git expands asks or denies.
      expect(a.kind, c).not.toBe('allow');
      expect(d.kind, c).toBe('deny');
    } else {
      expect(a, c).toEqual(ASK(c));
      expect(d, c).toEqual(DENY(c));
    }
  });
  test('cherry-pick and revert of a commit that touches config.yaml ask, or deny unattended', () => {
    for (const c of [`git cherry-pick ${cfgCommit}`, `git revert ${cfgCommit}`, `git cherry-pick ${srcCommit} ${cfgCommit}`]) {
      expect(run(c), c).toEqual(ASK(c));
      expect(run(c, true), c).toEqual(DENY(c));
    }
  });
  test('stash apply and pop of a stash that changes config.yaml ask, or deny unattended', () => {
    for (const c of ['git stash apply', 'git stash pop', 'git stash apply stash@{0}', 'git stash pop --index stash@{0}']) {
      expect(run(c), c).toEqual(ASK(c));
      expect(run(c, true), c).toEqual(DENY(c));
    }
  });
  test.each([
    'git checkout src-only', 'git switch src-only', 'git reset --hard src-only', 'git reset --soft other', 'git reset other', 'git reset',
    'git merge src-only', 'git cherry-pick src-only', 'git revert src-only', 'git rebase src-only',
    'git stash apply stash@{1}', 'git stash list', 'git restore --source=other a.ts', 'git checkout other -- a.ts', 'git checkout -- a.ts', 'git checkout a.ts', 'git checkout other a.ts', 'git restore -- "*.ts"',
    'git status', 'git checkout main', 'git switch -c y',
  ])('%s is allowed', (c) => {
    expect(run(c), c).toEqual({ kind: 'allow' });
    expect(run(c, true), c).toEqual({ kind: 'allow' });
  });
  test('pull and am always ask attended and deny unattended', () => {
    expect(run('git pull')).toEqual({ kind: 'ask', reason: "`git pull` fetches before harness can check what it changes in harness's protected files. Confirm it.", check: 'protect' });
    expect(run('git pull', true)).toEqual({ kind: 'deny', reason: '`git pull` fetches before harness can check what it changes. Run git fetch, then git merge <ref>, so harness can check what it changes.', check: 'protect' });
    expect(run('git pull --rebase origin main').kind).toBe('ask');
    expect(run('git am x.patch')).toEqual(FAIL('git am x.patch'));
    expect(run('git am x.patch', true)).toEqual(FAIL_DENY('git am x.patch'));
  });
  test('a ref that does not resolve asks attended and denies unattended, never allows', () => {
    for (const c of ['git reset --hard nope', 'git merge nope', 'git cherry-pick nope', 'git revert nope', 'git rebase nope', 'git stash apply stash@{9}', 'git restore --source=nope :!src']) {
      expect(run(c), c).toEqual(FAIL(c));
      expect(run(c, true), c).toEqual(FAIL_DENY(c));
    }
  });
  test('forms harness cannot read fail closed', () => {
    for (const c of ['git reset --hard $REF', 'git cherry-pick main..other', 'git cherry-pick -m 1 other', 'git rebase --continue', 'git rebase main other', 'git read-tree -u -m main other', 'git checkout-index --prefix=x/ -a', 'GIT_DIR=x git checkout other', 'git reset --hard a b'])
      expect(run(c).kind, c).toBe('ask');
  });
  test('a ref move after another command on the line fails closed: the refs may move first', () => {
    const c = 'git checkout src-only';
    expect(run(`git update-ref refs/heads/src-only ${cfgCommit} && ${c}`)).toEqual({ kind: 'ask', reason: `\`${c}\` follows another command on the same line, which may move refs or the index first, so harness can't check what it changes. Confirm it.`, check: 'protect' });
    expect(run(`./forge.sh; ${c}`, true)).toEqual({ kind: 'deny', reason: `\`${c}\` follows another command on the same line, which may move refs or the index first, so harness can't check what it changes. Run it as its own command.`, check: 'protect' });
    expect(run(`cd . && git status && ${c}`)).toEqual({ kind: 'allow' });
  });
  test('git checkout - is the previous branch', () => {
    g('checkout', '-q', 'other');
    g('checkout', '-q', 'main');
    try { expect(run('git checkout -')).toEqual(ASK('git checkout -')); } finally { g('checkout', '-q', 'main'); }
  });
  test('a HEAD moved by reset --soft is caught at the reset --hard or stash that brings its files in', () => {
    const main = g('rev-parse', 'main');
    g('reset', '-q', '--soft', 'other');
    try {
      expect(run('git reset --hard')).toEqual(ASK('git reset --hard'));
      expect(run('git stash')).toEqual(ASK('git stash'));
      expect(run('git checkout -f')).toEqual(ASK('git checkout -f'));
    } finally { g('reset', '-q', '--soft', main); g('reset', '-q'); }
  });
  test('checkout-index of a forged index entry asks', () => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'sandbox: off\n', encoding: 'utf8' }).stdout.trim();
    g('update-index', '--cacheinfo', `100644,${blob},${CFG}`);
    try {
      expect(run('git checkout-index -f -a')).toEqual(ASK('git checkout-index -f -a'));
      expect(run('git checkout-index -f -a', true)).toEqual(DENY('git checkout-index -f -a'));
      expect(run('git checkout-index -f a.ts')).toEqual({ kind: 'allow' });
    } finally { g('reset', '-q'); }
  });
  test('the first three changed paths are named', () => {
    g('checkout', '-q', '-b', 'many', 'main');
    for (const f of ['.claude/settings.json', '.harness/hooks/x.mjs', '.harness/manifest.json']) { mkdirSync(join(repo, f, '..'), { recursive: true }); writeFileSync(join(repo, f), '{}'); }
    writeFileSync(join(repo, CFG), 'sandbox: off\n');
    g('add', '.');
    g('commit', '-q', '-m', 'many');
    g('checkout', '-q', 'main');
    expect(run('git checkout many')).toEqual(ASK('git checkout many', '.claude/settings.json, .harness/config.yaml, .harness/hooks/x.mjs'));
  });
  test('unattended through the dispatcher, the check denies with its own reason', async () => {
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git merge other' } }), registry, { CI: 'true' });
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: DENY('git merge other').reason });
  });
  test.skipIf(process.platform === 'win32')('a git timeout asks attended and denies unattended', () => {
    const bin = mkdtempSync(join(tmpdir(), 'h-slowgit-'));
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexec sleep 5\n');
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      expect(run('git reset --hard other')).toEqual(FAIL('git reset --hard other'));
      expect(run('git reset --hard other', true)).toEqual(FAIL_DENY('git reset --hard other'));
    } finally { process.env.PATH = path; }
  });
});
