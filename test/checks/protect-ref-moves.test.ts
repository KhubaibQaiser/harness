// Git commands that move the worktree to another ref can change protected harness files without a direct write.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, dispatch, registry } from '../../src/hooks/dispatch.js';

let repo = '';
const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const run = (command: string, unattended = false, env: Record<string, string> = {}) => {
  const config = loadConfig('/nonexistent-harness-root').config;
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, tool_name: 'Bash', tool_input: { command } };
  return protect.run({ input, root: repo, config, env, unattended } as unknown as Ctx) as { kind: string; reason?: string };
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
    expect(run(`./forge.sh; ${c}`, true)).toEqual({ kind: 'deny', reason: `\`${c}\` follows another command on the same line, which may move refs or the index first, so harness can't check what it changes. Run the git command on its own so harness can check what it changes.`, check: 'protect' });
    expect(run(`git status && ${c}`)).toEqual({ kind: 'allow' });
    expect(run(`cd . && git status && ${c}`).kind).toBe('ask'); // round 4, N6: a cd may change the repo it runs in
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

describe('fix round 1: forms that used to pass', () => {
  const both = (c: string) => {
    expect(run(c).kind, c).toBe('ask');
    expect(run(c, true).kind, c).toBe('deny');
  };
  test('--end-of-options with a ref named -x fails closed', () => {
    g('update-ref', 'refs/heads/-x', cfgCommit);
    try {
      for (const c of ['git checkout --end-of-options -x', 'git switch --end-of-options -x']) {
        expect(run(c), c).toEqual(FAIL(c));
        expect(run(c, true), c).toEqual(FAIL_DENY(c));
      }
    } finally { g('update-ref', '-d', 'refs/heads/-x'); }
  });
  test('replacement refs fail closed: git follows them and the diff does not', () => {
    const c = 'git checkout src-only';
    g('update-ref', `refs/replace/${srcCommit}`, cfgCommit);
    const why = `Could not check what \`${c}\` changes in harness's protected files: the repo has replacement refs (refs/replace/), which git follows when it checks out.`;
    try {
      expect(run(c)).toEqual({ kind: 'ask', reason: `${why} Confirm it.`, check: 'protect' });
      expect(run(c, true)).toEqual({ kind: 'deny', reason: `${why} Unattended runs can't change harness's protected files through git; the person runs it.`, check: 'protect' });
    } finally { g('update-ref', '-d', `refs/replace/${srcCommit}`); }
    expect(run(c)).toEqual({ kind: 'allow' });
  });
  test.each(['$(which git) checkout src-only', '$G checkout src-only', 'env git checkout src-only', 'command git checkout src-only', 'exec git checkout src-only', 'sudo git checkout src-only', 'xargs git checkout < refs.txt'])(
    'a head that is not a literal git word fails closed: %s', (c) => {
      expect(run(c), c).toEqual(FAIL(c));
      expect(run(c, true), c).toEqual(FAIL_DENY(c));
    });
  test('xargs fed by a pipe fails closed', () => both('echo src-only | xargs git checkout'));
  test('a git alias fails closed', () => {
    g('config', 'alias.co', 'checkout');
    try { both('git co src-only'); } finally { g('config', '--unset', 'alias.co'); }
    expect(run('git co src-only')).toEqual({ kind: 'allow' }); // no such alias: not a git command, nothing moves
  });
  test.each(['git -c core.hooksPath=x checkout src-only', 'git --config-env=core.x=Y checkout src-only', 'git --exec-path=/x checkout src-only', 'git --namespace=x checkout src-only', 'git -c alias.co=checkout co other'])(
    'a config or path global option before a mover fails closed: %s', (c) => {
      expect(run(c), c).toEqual(FAIL(c));
      expect(run(c, true), c).toEqual(FAIL_DENY(c));
    });
  test.each(['git checkout -fb x other', 'git checkout -qb x other', 'git checkout -qB x other', 'git switch -qc x other', 'git checkout other --', 'git switch other --'])('%s is read as a move to other', (c) => {
    expect(run(c), c).toEqual(ASK(c));
    expect(run(c, true), c).toEqual(DENY(c));
  });
  test.each(['LC_ALL=C git checkout src-only', '(git checkout src-only)', 'grep git src/b.ts', 'grep -n git a.ts', 'git lfs-like-thing x'])('%s is allowed', (c) => {
    expect(run(c), c).toEqual({ kind: 'allow' });
  });
  test('a subshell move is still read', () => expect(run('(git checkout other)').kind).toBe('ask'));
});

describe('fix round 2', () => {
  test('a head built at run time followed by a git alias fails closed', () => {
    for (const c of ['$G co src-only', '$(which git) co src-only']) expect(run(c), c).toEqual({ kind: 'allow' }); // co is no alias yet
    g('config', 'alias.co', 'checkout');
    try {
      for (const c of ['$G co src-only', '$(which git) co src-only', '`which git` co src-only']) {
        expect(run(c), c).toEqual(FAIL(c));
        expect(run(c, true), c).toEqual(FAIL_DENY(c));
      }
    } finally { g('config', '--unset', 'alias.co'); }
  });
  test.each(['GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'])('%s in the hook environment fails any ref move closed', (k) => {
    const c = 'git checkout src-only', env = { [k]: 'x' };
    const why = `Could not check what \`${c}\` changes in harness's protected files: ${k} is set in harness's environment, so git may read other refs or objects than harness does.`;
    expect(run(c, false, env)).toEqual({ kind: 'ask', reason: `${why} Confirm it.`, check: 'protect' });
    expect(run(c, true, env)).toEqual({ kind: 'deny', reason: `${why} Unattended runs can't change harness's protected files through git; the person runs it.`, check: 'protect' });
    expect(run('git status', false, env)).toEqual({ kind: 'allow' });
  });
});

describe('fix round 4: words read the way the shell and git read them', () => {
  const both = (c: string, cwd = repo) => {
    const at = (unattended: boolean) => {
      const config = loadConfig('/nonexistent-harness-root').config;
      const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name: 'Bash', tool_input: { command: c } };
      return protect.run({ input, root: repo, config, env: {}, unattended } as unknown as Ctx) as { kind: string };
    };
    expect(at(false).kind, c).toBe('ask');
    expect(at(true).kind, c).toBe('deny');
  };
  test.each([
    // N1: quotes and backslashes inside a word
    "git che''ckout other", "git sw''itch other", "git mer''ge other", "git re''set --hard other", "g''it che''ckout other",
    "git checkout o''ther", 'git checkout ot"he"r', "git checkout 'oth'er", 'git che\\ckout other',
    // N2: a value stuck inside a cluster
    'git checkout -bc other', 'git checkout -Bb other', 'git checkout -fbc other', 'git switch -cb other',
    // N3: abbreviated long options
    'git reset --har other', 'git reset --ha other', 'git reset --kee other', "git restore --sour=other '*.yaml'",
    'git restore -s other --pathspec-from-f=list.txt', 'git checkout --orp x other', 'git rebase --ont=other src-only',
    // N4: a restore cluster that carries -s
    "git restore -Ws other '*.yaml'", "git restore -SWs other '*.yaml'",
    // N5: a backslash-newline inside the subcommand
    'git check\\\nout other',
    // N8: an orphan branch starts from the empty tree
    'git switch --orphan x', 'git checkout --orphan x',
    // found while fixing: a redirect, a comment, an unknown option, git by path, a substitution in quotes, git $SUB
    'git checkout other >/dev/null', 'git checkout other 2>&1', 'git checkout other # x', 'git checkout --bogus other', '/usr/bin/git checkout other',
    'echo "$(git checkout other)"', 'git $SUB other', 'git checkout oth*', 'git commit -m "$(git checkout other)"',
  ])('%s asks attended and denies unattended', (c) => both(c));
  test('N3: checkout-index --al after an index-only read-tree', () => {
    g('read-tree', 'other');
    try { both('git checkout-index -f --al'); } finally { g('reset', '-q'); }
  });
  test('stash -k puts a forged index entry in the worktree: it asks', () => {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'sandbox: off\n', encoding: 'utf8' }).stdout.trim();
    g('update-index', '--cacheinfo', `100644,${blob},${CFG}`);
    try { both('git stash -k'); both('git stash push --keep-i'); } finally { g('reset', '-q'); }
  });
  test('N6: a cd, pushd or popd before a mover fails closed', () => {
    const n = join(repo, 'vendor/n');
    mkdirSync(join(n, '.harness/hooks'), { recursive: true });
    writeFileSync(join(n, '.harness/hooks/dispatch.mjs'), '');
    const gn = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: n, encoding: 'utf8' });
    gn('init', '-q', '-b', 'main'); gn('add', '.'); gn('commit', '-q', '-m', 'n'); gn('branch', 'other');
    try {
      for (const c of ['cd ../.. && git checkout other', `cd ${repo} && git checkout other`, 'pushd ../.. && git checkout other', 'popd && git checkout other']) both(c, n);
    } finally { rmSync(join(repo, 'vendor'), { recursive: true, force: true }); }
  });
  test('N7: a -C folder protect cannot resolve fails closed, alias lookup included', () => {
    g('config', 'alias.co', 'checkout');
    try {
      for (const c of ['git -C $(pwd) co other', 'git -C "$PWD" co other', "git -C .'' co other", 'git -C nope co other', 'git -C `pwd` co other']) both(c);
    } finally { g('config', '--unset', 'alias.co'); }
  });
  test.each(['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS'])('N9: %s in the hook environment fails a ref move closed', (k) => {
    expect(run('git checkout src-only', false, { [k]: '1' }).kind).toBe('ask');
    expect(run('git checkout src-only', true, { [k]: '1' }).kind).toBe('deny');
  });
  test('N11: worktree add into a protected path is denied like a direct write; one protect cannot resolve fails closed', () => {
    for (const c of ['git worktree add .harness/hooks/wt other', 'git worktree add -b y .harness/state/wt other', 'git -C .harness worktree add hooks/wt other']) {
      expect(run(c), c).toEqual({ kind: 'deny', reason: 'Harness files and Claude settings are changed by a person, not the agent.', check: 'protect' });
    }
    both('git worktree add $P other');
    both('git worktree add --bogus wt other');
    expect(run('git worktree add ../wt-x src-only')).toEqual({ kind: 'allow' });
  });
  test.each([
    'git checkout src-only', "git che''ckout src-only", 'git checkout -bc src-only', 'git reset --hard HEAD', 'git reset --har HEAD', 'git restore --source=other src/x.ts',
    "git restore --sour=src-only 'src/*'", 'git rebase --ont=src-only main', 'git checkout src-only >/dev/null', '/usr/bin/git checkout src-only',
    'git --no-pager checkout src-only', 'git -C . checkout src-only', 'git checkout --no-guess src-only', 'git merge --no-ff --no-edit src-only',
    'git commit -m "$(cat <<\'EOF\'\nfix: git checkout other asks\nEOF\n)"', 'git stash -k',
  ])('%s is allowed', (c) => {
    expect(run(c), c).toEqual({ kind: 'allow' });
    expect(run(c, true), c).toEqual({ kind: 'allow' });
  });
});

describe('fix round 5: eval payloads and run-time words the reader cut out', () => {
  const both = (c: string) => {
    expect(run(c).kind, c).toBe('ask');
    expect(run(c, true).kind, c).toBe('deny');
  };
  test.each([
    // Critical 1: eval runs its arguments, joined, as a command line
    'eval "git checkout other"', "eval 'git checkout other'", 'eval "git che""ckout other"', 'X="git checkout other"; eval "$X"',
    'command eval "git checkout other"', 'builtin eval "git checkout other"', 'X="git checkout other"; eval $X', 'eval "$(echo git checkout other)"',
    '{ eval "git checkout other"; }', 'eval "git checkout" other', 'eval git checkout `echo other`',
    // source/. of a path the shell builds, on a line that names git
    '. "$F" && git status', 'source $HOME/x.sh && git status',
  ])('%s asks attended and denies unattended', (c) => both(c));
  test('a literal eval payload is read as the command it runs', () => {
    expect(run('eval "git checkout other"')).toEqual(ASK('git checkout other'));
    expect(run('X="git checkout other"; eval "$X"')).toEqual(FAIL('X="git checkout other"; eval "$X"'));
  });
  test.each([
    // Critical 2: a backtick substitution supplies an argument the reader cut off
    'git checkout `echo other`', 'git checkout`echo \\ other`', 'git switch `echo other`', 'git switch`printf " other"`', 'git reset --hard `echo other`',
    'git checkout -b x `echo other`', 'git checkout `echo -q` other', 'git -C `pwd` checkout other', 'git `echo checkout` other', 'git checkout <(echo other)',
  ])('%s fails closed', (c) => {
    expect(run(c), c).toEqual(FAIL(c));
    expect(run(c, true), c).toEqual(FAIL_DENY(c));
  });
  test.each([
    // Item 4: other words built at run time inside a mover segment
    'git checkout src-only <<< x', 'git merge <(echo src-only)', 'git checkout src-only >(cat)', 'git reset --hard HEAD~$((0))', 'git checkout ${REF}', 'git checkout ${REF:-src-only}',
    'git checkout "${a[@]}"', 'a=(checkout src-only); git "${a[@]}"', 'git checkout src-only "`true`"',
  ])('%s asks attended and denies unattended', (c) => both(c));
  test.each([
    // Re-review round 5: a payload built at run time can assemble git itself, so no text test on the line can tell; it always fails closed
    'G=gi; eval "${G}t checkout other"', 'G=gi; X="${G}t checkout other"; eval "$X"', 'A=gi B=t; eval "$A$B checkout other"', 'eval "${x-gi}t checkout other"',
    'a=(gi t); eval "${a[0]}${a[1]} checkout other"', 'G=gi; eval "${G}t switch other"', 'G=gi; eval "${G}t reset --hard other"',
    'F=./s.sh; . "$F"', 'F=./s.sh; source "$F"', '. "$F"', 'X=1; eval "echo $X"',
  ])('%s asks attended and denies unattended (a built eval or source payload)', (c) => both(c));
  test.each(['eval "git checkout src-only"', 'eval git status', 'eval "echo hi"', 'source ./env.sh && git status', 'echo `date`', 'ls `pwd`'])('%s is allowed', (c) => {
    expect(run(c), c).toEqual({ kind: 'allow' });
    expect(run(c, true), c).toEqual({ kind: 'allow' });
  });
});
