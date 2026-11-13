import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { commitUse, gitTooOld, runningPrograms, secretScan, type Use } from '../../src/checks/secret-scan.js';
import { defaults } from '../../src/core/config.js';
import { registry } from '../../src/hooks/dispatch.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { makeRepo } from '../install/helpers.js';

// Built at run time so no source file holds a token-shaped literal (this repo's own CI runs gitleaks on its history).
const TOKEN = 'ghp' + '_' + 'Fak3T0k3nF0rT3sts'.padEnd(36, 'x');
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

type Call = { args: string[]; index: string | undefined; attrSource: string | undefined; home: string | undefined; config: string; ignore: string };
/** A stand-in gitleaks on PATH. It runs the git command gitleaks runs for `--pre-commit --staged` (so GIT_INDEX_FILE and
 *  the attribute settings apply), "finds" TOKEN, writes an unredacted report (file name STUB_FILE) and prints the value,
 *  so a test proves the check never repeats either. STUB_CRASH makes it fail. Each call is logged with its env and config.
 *  One per file: a newly written executable is slow to start the first time (macOS and Windows scan it). */
function stubBin(): { dir: string; calls: () => Call[]; reset: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-gitleaks-stub-'));
  const log = join(dir, 'calls.jsonl');
  const js = `const { execFileSync } = require('node:child_process'); const fs = require('node:fs');
if (process.env.STUB_CRASH) { console.error('boom'); process.exit(1); }
const a = process.argv.slice(2); const at = (f) => a[a.indexOf(f) + 1];
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return 'unreadable'; } };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, index: process.env.GIT_INDEX_FILE, attrSource: process.env.GIT_ATTR_SOURCE, home: process.env.HOME, config: read(at('--config')), ignore: read(at('--gitleaks-ignore-path')) }) + '\\n');
const diff = execFileSync('git', ['-C', a[a.length - 1], 'diff', '-U0', '--no-ext-diff', '--staged', '.'], { encoding: 'utf8' });
if (diff.includes('\\x1b[')) process.exit(0); // as gitleaks: a coloured diff does not parse, so nothing is found
const m = /ghp_[A-Za-z0-9]{36}/.exec(diff);
if (!m) process.exit(0);
fs.writeFileSync(at('--report-path'), JSON.stringify([{ RuleID: 'github-pat', File: process.env.STUB_FILE || 'config/leak.txt', StartLine: 1, Secret: m[0], Match: m[0] }]));
console.log('leak ' + m[0]); console.error('leak ' + m[0]);
process.exit(Number(at('--exit-code')));
`;
  writeFileSync(join(dir, 'gitleaks.js'), js);
  if (process.platform === 'win32') writeFileSync(join(dir, 'gitleaks.cmd'), '@node "%~dp0gitleaks.js" %*\r\n');
  else writeFileSync(join(dir, 'gitleaks'), `#!/bin/sh\nexec node "${join(dir, 'gitleaks.js')}" "$@"\n`, { mode: 0o755 });
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : []), reset: () => rmSync(log, { force: true }) };
}

function ctx(root: string, command: string, env: NodeJS.ProcessEnv, o: { on?: boolean; tool?: string; input?: Record<string, unknown> } = {}): Ctx {
  const config = defaults();
  config.checks.secretScan = o.on ?? true;
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: o.tool ?? 'Bash', tool_input: o.input ?? { command } };
  return { input, root, config, unattended: false, env, platform: process.platform, startedAt: Date.now() } as unknown as Ctx;
}
const run = (c: Ctx) => secretScan.run(c) as { kind: string; reason?: string };
// No system or global git config: this machine's own (a credential helper, a difftool) must not change what a test sees.
const NO_USER_CONFIG = (() => { const f = join(mkdtempSync(join(tmpdir(), 'harness-gitcfg-')), 'empty'); writeFileSync(f, ''); return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: f }; })();
const S = stubBin();
const withStub = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, ...NO_USER_CONFIG, PATH: `${S.dir}${delimiter}${process.env.PATH ?? ''}`, ...extra });
const noGitleaks = () => ({ PATH: mkdtempSync(join(tmpdir(), 'harness-nopath-')) });
const leak = (root: string, rel = 'leak.txt') => writeFileSync(join(root, rel), `token = ${TOKEN}\n`);

describe('secret-scan', () => {
  test('is registered, PreToolUse only, and fails closed', () => {
    expect(registry).toContain(secretScan);
    expect(secretScan.events).toEqual(['PreToolUse']);
    expect(secretScan.failClosed).toBe(true);
  });

  test('blocks a commit with a staged secret, never shows the value, and suggests no allowlist', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    leak(root);
    git(root, 'add', 'leak.txt');
    const s = S;
    s.reset();
    const d = run(ctx(root, 'git commit -m "add config"', withStub()));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('github-pat in `config/leak.txt` line 1');
    expect(d.reason).not.toContain(TOKEN);
    expect(d.reason).not.toMatch(/gitleaks:allow|\.gitleaks\.toml|\.gitleaksignore/);
    expect(d.reason).toContain('ask the person');
  });

  test('a file name holding a secret is redacted in the reason', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    leak(root);
    git(root, 'add', 'leak.txt');
    const d = run(ctx(root, 'git commit -m x', withStub({ STUB_FILE: `keys/${TOKEN}.txt` })));
    expect(d.kind).toBe('deny');
    expect(d.reason).not.toContain(TOKEN);
  });

  test('runs gitleaks with harness rules, an empty ignore file, inline allows ignored, and a sealed git config', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const s = S;
    s.reset();
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
    const c = s.calls();
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) {
      expect(x.args.slice(0, 4)).toEqual(['git', '--pre-commit', '--staged', '--redact']);
      expect(x.args).toContain('--ignore-gitleaks-allow');
      expect(x.config).toBe('[extend]\nuseDefault = true\n');
      expect(x.ignore).toBe('');
      expect(x.attrSource).toMatch(/^[0-9a-f]{40,64}$/);
      expect(x.home).not.toBe(process.env.HOME);
    }
  });

  test('scans the real index as staged: a staged secret hidden behind a clean worktree copy still blocks', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    leak(root, 'f.txt');
    git(root, 'add', 'f.txt');
    writeFileSync(join(root, 'f.txt'), 'clean\n');
    expect(run(ctx(root, 'git commit -m x', withStub())).kind).toBe('deny');
  });

  test('scans what commit -a or a pathspec takes from the worktree, and leaves the real index alone', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'README.md'), `hi ${TOKEN}\n`);
    for (const cmd of ['git commit -am x', 'git commit -m x README.md']) expect(run(ctx(root, cmd, withStub())).kind, cmd).toBe('deny');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('a .gitattributes -diff line does not hide a file', () => {
    const root = makeRepo({ 'README.md': 'hi\n', '.gitattributes': '*.txt -diff\n' });
    leak(root);
    git(root, 'add', 'leak.txt');
    expect(run(ctx(root, 'git commit -m x', withStub())).kind).toBe('deny');
  });

  test('a NUL byte does not make a file binary and hide it', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'leak.txt'), Buffer.from(`k=${TOKEN}\n\0`));
    git(root, 'add', 'leak.txt');
    expect(run(ctx(root, 'git commit -m x', withStub())).kind).toBe('deny');
  });

  test('color.ui=always in the repo config does not colour the diff gitleaks reads', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    git(root, 'config', 'color.ui', 'always');
    git(root, 'config', 'color.diff', 'always');
    leak(root);
    git(root, 'add', 'leak.txt');
    expect(run(ctx(root, 'git commit -m x', withStub())).kind).toBe('deny');
  });

  test('a .gitleaksignore in the worktree or the index blocks: gitleaks always reads it from the repo root', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, '.gitleaksignore'), 'x:github-pat:1\n');
    const d = run(ctx(root, 'git commit --allow-empty -m x', withStub()));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('.gitleaksignore');
    expect(d.reason).toContain('ask the person');
    git(root, 'add', '.gitleaksignore');
    rmSync(join(root, '.gitleaksignore'));
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('deny');
    git(root, 'rm', '-q', '--cached', '.gitleaksignore');
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
  });

  test('a repo commit hook asks, since it runs after the scan and can stage files; core.hooksPath is followed', () => {
    const hook = (root: string, rel: string, mode = 0o755) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), '#!/bin/sh\n', { mode }); };
    const one = makeRepo({ 'README.md': 'hi\n' });
    for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-rewrite', 'reference-transaction', 'anything']) {
      hook(one, `.git/hooks/${name}`);
      const d = run(ctx(one, 'git commit --allow-empty -m x', withStub()));
      expect(d.kind, name).toBe('ask');
      expect(d.reason).toContain(name);
      rmSync(join(one, `.git/hooks/${name}`));
    }
    const root = makeRepo({ 'README.md': 'hi\n' });
    git(root, 'config', 'core.hooksPath', '.husky/_');
    hook(root, '.husky/_/pre-commit');
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('ask');
    expect(run(ctx(root, 'git stash', withStub())).kind).toBe('ask'); // stash runs hooks too (reference-transaction)
    const plain = makeRepo({ 'README.md': 'hi\n' });
    if (process.platform !== 'win32') {
      hook(plain, '.git/hooks/pre-commit', 0o644); // git skips a hook that is not executable
      expect(run(ctx(plain, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
    }
    leak(root);
    git(root, 'add', 'leak.txt');
    expect(run(ctx(root, 'git commit -m x', withStub())).kind).toBe('deny'); // a finding still wins
  });

  test('sample hooks and folders in the hooks folder do not ask', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, '.git/hooks/pre-commit.sample'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(root, '.git/hooks/lib'));
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
  });

  test('which config programs run: by key pattern, the editor only when it opens, gpg only when the commit signs', () => {
    const none: Use = { editor: false, signFlag: null }, ed: Use = { editor: true, signFlag: null }, signs: Use = { editor: false, signFlag: true }, noSign: Use = { editor: false, signFlag: false };
    const cases: [key: string, value: string, use: Use, runs: boolean][] = [
      ['core.fsmonitor', './.fsmon', none, true], ['core.fsmonitor', 'true', none, false], ['core.fsmonitor', 'false', none, false],
      ['filter.x.clean', 'sh x.sh', none, true], ['filter.x.smudge', 'cat', none, true], ['filter.x.process', 'p', none, true],
      ['filter.lfs.clean', 'git-lfs clean -- %f', none, false], ['filter.lfs.smudge', 'git-lfs smudge -- %f', none, false], ['filter.lfs.process', 'git-lfs filter-process', none, false], ['filter.lfs.clean', 'git-lfs clean -- %f; sh x', none, true],
      ['diff.x.textconv', 'cat', none, true], ['diff.external', './d', none, true], ['interactive.difffilter', './f', none, true], ['future.thing.program', './p', none, true], ['foo.command', './c', none, true], ['foo.editor', './e', none, true],
      ['credential.helper', 'osxkeychain', none, false], ['difftool.x.cmd', 'opendiff', none, false], ['mergetool.x.cmd', 'x', none, false],
      ['core.editor', 'vim', none, false], ['core.editor', 'vim', ed, true], ['core.editor', 'true', ed, false], ['core.editor', ':', ed, false], ['sequence.editor', 'vim', ed, false],
      ...['gpg.program', 'gpg.ssh.program', 'gpg.x509.program', 'gpg.ssh.defaultkeycommand'].flatMap((k): [string, string, Use, boolean][] => [[k, './s', none, false], [k, './s', signs, true], [k, './s', noSign, false]]),
    ];
    for (const [key, value, use, runs] of cases) expect(runningPrograms([[key, value]], use, {}), `${key}=${value} ${JSON.stringify(use)}`).toEqual(runs ? [key] : []);
    // commit.gpgsign true in any scope turns signing on, unless --no-gpg-sign.
    expect(runningPrograms([['commit.gpgsign', 'false'], ['commit.gpgsign', 'true'], ['gpg.program', './s']], none, {})).toEqual(['gpg.program']);
    expect(runningPrograms([['commit.gpgsign', 'true'], ['gpg.program', './s']], noSign, {})).toEqual([]);
    for (const v of ['GIT_EDITOR', 'VISUAL', 'EDITOR']) {
      expect(runningPrograms([], ed, { [v]: './ed.sh' }), v).toEqual([v]);
      expect(runningPrograms([], none, { [v]: './ed.sh' }), v).toEqual([]);
      for (const skip of ['true', ':', ' true ']) expect(runningPrograms([], ed, { [v]: skip }), `${v}=${skip}`).toEqual([]);
    }
  });

  test('commitUse: when the commit opens the editor and when it signs', () => {
    const cases: [cmd: string, editor: boolean, signFlag: boolean | null][] = [
      ['git commit -m x', false, null], ['git commit -F msg.txt', false, null], ['git commit -C HEAD', false, null], ['git commit --no-edit', false, null], ['git commit -am x', false, null],
      ['git commit --message=x', false, null], ['git commit --amend --no-edit', false, null], ['git commit -m "-e"', false, null], ['git commit --fixup=abc', false, null], ['git commit --fixup abc', false, null],
      ['git commit', true, null], ['git commit -m x -e', true, null], ['git commit -em x', true, null], ['git commit --edit -m x', true, null], ['git commit --amend', true, null],
      ['git commit -c HEAD', true, null], ['git commit --reedit-message=HEAD', true, null], ['git commit --squash=abc', true, null], ['git commit --squash abc', true, null],
      ['git commit --fixup=amend:abc', true, null], ['git commit --fixup=reword:abc', true, null], ['git commit --fixup amend:abc', true, null],
      ['git commit -S -m x', false, true], ['git commit --gpg-sign -m x', false, true], ['git commit -Sabc -m x', false, true], ['git commit --gpg-sign=abc -m x', false, true], ['git commit --no-gpg-sign -m x', false, false],
      // Known options with values or none; an unknown one fails closed: the editor may open and the commit may sign.
      ['git commit -m y --author="A <a@b>" --no-verify -q', false, null], ['git commit -m y --untracked-files', false, null], ['git commit -s -m y --trailer "x: y" --cleanup strip', false, null],
      ['git commit --frobnicate x -m y', true, true], ['git commit -Zq -m y', true, true], ['git stash', false, false],
    ];
    for (const [cmd, editor, signFlag] of cases) expect(commitUse(cmd), cmd).toEqual({ editor, signFlag });
  });

  test('end to end: config programs ask only when this commit runs them', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    for (const [k, v] of [['credential.helper', 'osxkeychain'], ['difftool.x.cmd', 'opendiff'], ['filter.lfs.clean', 'git-lfs clean -- %f'], ['core.editor', './ed.sh'], ['gpg.program', './s']]) git(root, 'config', k!, v!);
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
    expect(run(ctx(root, 'git commit --allow-empty', withStub())).reason).toContain('core.editor');
    expect(run(ctx(root, 'git commit --allow-empty -S -m x', withStub())).reason).toContain('gpg.program');
    expect(run(ctx(root, 'git commit --allow-empty', { ...withStub(), GIT_EDITOR: 'true' })).reason).not.toContain('GIT_EDITOR');
    git(root, 'config', 'filter.x.clean', 'sh x.sh');
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).reason).toContain('filter.x.clean');
  });

  test('gpg signing with a gpg.program asks: the program runs after the scan and could make a commit of its own', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'sign.sh'), `#!/bin/sh\necho k=${'$'}T > x.txt; git add x.txt; git commit -qm nested --no-verify\n`, { mode: 0o755 });
    git(root, 'config', 'gpg.program', './sign.sh');
    git(root, 'config', 'commit.gpgsign', 'true');
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('ask');
  });

  test('writing commit hooks or changing core.hooksPath asks', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    git(root, 'config', 'core.hooksPath', 'tools/hk');
    const env = { ...process.env }; // git on PATH to read core.hooksPath; nothing here commits
    for (const file_path of [join(root, '.git/hooks/pre-commit'), '.git/hooks/commit-msg', join(root, 'tools/hk/pre-commit'), '.husky/pre-commit'])
      expect(run(ctx(root, '', env, { tool: 'Write', input: { file_path } })).kind, file_path).toBe('ask');
    for (const cmd of ['echo x > .git/hooks/pre-commit', 'cp x tools/hk/pre-commit', 'git config core.hooksPath h', 'git config --local core.hookspath h', 'chmod +x .husky/pre-commit', 'git config filter.x.clean ./x', 'git config core.fsmonitor ./m', 'echo x >> .git/config'])
      expect(run(ctx(root, cmd, env)).kind, cmd).toBe('ask');
    expect(run(ctx(root, '', env, { tool: 'Edit', input: { file_path: join(root, '.git/config') } })).kind).toBe('ask');
    expect(run(ctx(root, '', env, { tool: 'Write', input: { file_path: join(root, 'src/hooks.ts') } })).kind).toBe('allow');
  });

  test('a diff or binary line in .git/info/attributes blocks, since it would hide files', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    mkdirSync(join(root, '.git/info'), { recursive: true });
    writeFileSync(join(root, '.git/info/attributes'), '*.txt binary\n');
    const d = run(ctx(root, 'git commit --allow-empty -m x', withStub()));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('.git/info/attributes');
  });

  test('a secret in an ignored file does not block', () => {
    const root = makeRepo({ 'README.md': 'hi\n', '.gitignore': '.env\n' });
    writeFileSync(join(root, '.env'), `TOKEN=${TOKEN}\n`);
    expect(run(ctx(root, 'git commit --allow-empty -m x', withStub())).kind).toBe('allow');
  });

  test('passes clean changes, with the usual message forms and -c user settings', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'a.txt'), 'nothing secret\n');
    git(root, 'add', 'a.txt');
    const heredoc = `git commit -m "$(cat <<'EOF'\nfeat: x; y && z\n\nbody | more\nEOF\n)"`;
    for (const cmd of ['git commit -m clean', 'git commit -m "fix: a; b && c"', heredoc, 'git -c user.name=a -c user.email=b@c commit -m x', 'git -c commit.gpgsign=false commit -m x', '/usr/bin/git commit -m x 2>&1', 'git stash'])
      expect(run(ctx(root, cmd, withStub())).kind, cmd).toBe('allow');
  });

  test('git stash is scanned too', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    writeFileSync(join(root, 'README.md'), `hi ${TOKEN}\n`);
    for (const cmd of ['git stash', 'git stash push -m x']) expect(run(ctx(root, cmd, withStub())).kind, cmd).toBe('deny');
  });

  test('a commit must be the only, plain command on the line', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const env = withStub();
    for (const cmd of ['echo k > k && git add k && git commit -m x', 'git add -f .env && git commit -m x', 'git commit -m x; echo done', 'git commit -m x | cat'])
      expect(run(ctx(root, cmd, env)).reason, cmd).toContain('must be the only command');
    for (const cmd of ['GIT_INDEX_FILE=/tmp/i git commit -m x', 'env A=1 git commit -m x', 'sh -c "git commit -m x"', 'eval "git commit -m x"'])
      expect(run(ctx(root, cmd, env)).reason, cmd).toContain('plain');
    for (const cmd of ['git -C . commit -m x', 'git --git-dir=.git commit -m x', 'git -c core.attributesFile=/x commit -m x', 'git -c commit.gpgsign=true commit -m x', 'git -c gpg.program=./s commit -m x'])
      expect(run(ctx(root, cmd, env)).kind, cmd).toBe('deny');
    const smuggled = `git commit -m "$(cat <<'EOF'\nx\nEOF\necho k > f; git add f\ncat <<'EOF'\ny\nEOF\n)"`;
    // bash 3.2 also ends a heredoc at a line that starts with the delimiter (`EOF)`).
    const prefixed = `git commit -m "$(cat <<'EOF'\nx\nEOF)\necho k > f; git add f\ncat <<'EOF'\ny\nEOF\n)"`;
    for (const cmd of ['git commit -m "$(echo k > f)"', 'git commit -m `id`', 'git commit -F - <<EOF\nx\nEOF', smuggled, prefixed])
      expect(run(ctx(root, cmd, env)).reason, cmd).toContain('at run time');
  });

  test('commands that make commits harness cannot scan first ask', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const env = noGitleaks();
    for (const cmd of ['git merge feat', 'git cherry-pick abc', 'git rebase main', 'git revert HEAD', 'git am x.patch', 'git commit-tree HEAD^{tree}', 'git pull', 'git stash create', 'git -c alias.x=commit x', '$GIT commit -m x', 'git $sub -m x'])
      expect(run(ctx(root, cmd, env)).kind, cmd).toBe('ask');
  });

  test('blocks with the install message when gitleaks is missing', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const d = run(ctx(root, 'git commit -m x', noGitleaks()));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('gitleaks is not on PATH');
    expect(d.reason).toContain('brew install gitleaks');
    expect(d.reason).toContain('harness remove gitleaks-commit');
  });

  test('a gitleaks error or crash blocks too', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const d = run(ctx(root, 'git commit -m x', withStub({ STUB_CRASH: '1' })));
    expect(d.kind).toBe('deny');
    expect(d.reason).toContain('could not scan');
  });

  test('git older than 2.40 (no GIT_ATTR_SOURCE) is too old', () => {
    expect(gitTooOld('git version 2.39.5')).toBe(true);
    expect(gitTooOld('git version 1.99.0')).toBe(true);
    expect(gitTooOld('git version 2.40.0')).toBe(false);
    expect(gitTooOld('git version 2.50.1 (Apple Git-155)')).toBe(false);
    expect(gitTooOld('nonsense')).toBe(true);
  });

  test('editing the gitleaks allowlist files asks', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const env = noGitleaks();
    expect(run(ctx(root, '', env, { tool: 'Edit', input: { file_path: join(root, '.gitleaks.toml') } })).kind).toBe('ask');
    expect(run(ctx(root, '', env, { tool: 'Write', input: { file_path: 'sub/.gitleaksignore' } })).kind).toBe('ask');
    for (const cmd of ['echo fp >> .gitleaksignore', "echo fp > .gitleaksigno''re", 'echo fp > .gitleaksig"n"ore', 'echo fp > .GITLEAKSIGNORE', 'touch .GitLeaks.Toml'])
      expect(run(ctx(root, cmd, env)).kind, cmd).toBe('ask');
    expect(run(ctx(root, '', env, { tool: 'Write', input: { file_path: '.GITLEAKSIGNORE' } })).kind).toBe('ask');
    expect(run(ctx(root, '', env, { tool: 'Edit', input: { file_path: join(root, 'src/a.ts') } })).kind).toBe('allow');
    expect(run(ctx(root, '', env, { on: false, tool: 'Edit', input: { file_path: join(root, '.gitleaks.toml') } })).kind).toBe('allow');
  });

  test('other commands, and the check turned off, never run gitleaks', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const env = noGitleaks();
    for (const cmd of ['git status', 'git log --grep commit', 'echo git commit', 'ls', 'git stash list', 'git stash pop'])
      expect(run(ctx(root, cmd, env)).kind, cmd).toBe('allow');
    expect(run(ctx(root, 'git commit -m x', env, { on: false })).kind).toBe('allow');
  });

  test('leaves no temp folder behind', () => {
    const root = makeRepo({ 'README.md': 'hi\n' });
    const s = S;
    s.reset();
    run(ctx(root, 'git commit --allow-empty -m x', withStub()));
    for (const c of s.calls()) expect(existsSync(c.args[c.args.indexOf('--report-path') + 1])).toBe(false);
  });
});
