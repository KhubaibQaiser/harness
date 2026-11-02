import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { isWholeTree, protect } from '../../src/checks/protect.js';
import { posix, win32 } from 'node:path';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, dispatch, registry } from '../../src/hooks/dispatch.js';

const ROOT = '/p';
const run = (tool_name: string, tool_input: Record<string, unknown>, checks?: Record<string, boolean>) => {
  const config = loadConfig('/nonexistent-harness-root').config;
  Object.assign(config.checks, checks);
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: ROOT, tool_name, tool_input };
  return protect.run({ input, root: ROOT, config, env: {}, unattended: false } as unknown as Ctx) as { kind: string; reason?: string };
};
const edit = (p: string, tool = 'Edit') => run(tool, { file_path: p });
const bash = (command: string) => run('Bash', { command }).kind;

test('protect is registered second, fail-closed, on PreToolUse', () => {
  expect(registry.map((c) => c.name).slice(0, 2)).toEqual(['guard', 'protect']);
  expect(protect.failClosed).toBe(true);
  expect(protect.events).toEqual(['PreToolUse']);
});

test.each(['.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/state/s.json', '.harness/state/tdd-pause.json', '.harness/config.yaml', '.claude/settings.json', '.claude/settings.local.json', '/p/.harness/hooks/dispatch.mjs'])(
  'agent Write to %s is denied with the reason', (p) => {
    const d = edit(p, 'Write');
    expect(d.kind).toBe('deny');
    expect(d.reason).toBe('Harness files and Claude settings are changed by a person, not the agent.');
  });

test.each(['Edit', 'Write', 'MultiEdit'])('%s uses file_path', (t) => expect(edit('.claude/settings.json', t).kind).toBe('deny'));
test('NotebookEdit uses notebook_path', () => {
  expect(run('NotebookEdit', { notebook_path: '.harness/state/n.ipynb' }).kind).toBe('deny');
  expect(run('NotebookEdit', { notebook_path: 'docs/n.ipynb' }).kind).toBe('allow');
});
test('src file, outside-root path, other tools are allowed', () => {
  expect(edit('src/a.ts').kind).toBe('allow');
  expect(edit('/elsewhere/.harness/hooks/x').kind).toBe('allow');
  expect(run('Read', { file_path: '.harness/config.yaml' }).kind).toBe('allow');
  expect(run('Edit', {}).kind).toBe('allow');
});
test('checks.protect false turns it off', () => expect(run('Write', { file_path: '.harness/config.yaml' }, { protect: false }).kind).toBe('allow'));

test('shell redirect to tdd-pause.json is denied (pause comes only from the CLI)', () => {
  expect(bash('echo {} > .harness/state/tdd-pause.json')).toBe('deny');
});
test('shell writes, rm, mv and cp touching protected paths are denied', () => {
  for (const c of [
    'echo x >> .harness/config.yaml', 'tee .claude/settings.json < a', "sed -i 's/a/b/' .claude/settings.local.json",
    'rm .harness/hooks/dispatch.mjs', 'rm .harness/hooks/jest-*.cjs', 'rm -rf .harness/hooks', 'rm -rf node_modules .harness/state/',
    'mv a .harness/hooks/dispatch.mjs', 'cp a.mjs .harness/hooks/dispatch.mjs', 'mv .harness/hooks/dispatch.mjs /tmp/x', 'cd x && mv -f a .claude/settings.json',
  ]) expect(bash(c), c).toBe('deny');
});
test('harmless shell commands are allowed', () => {
  for (const c of ['ls .harness/hooks', 'cat .harness/config.yaml', 'echo hi > out.txt', 'rm -rf dist', 'cp .harness/config.yaml /tmp/c.yaml', 'mv a.ts b.ts', 'pnpm test']) expect(bash(c), c).toBe('allow');
});

test('parent directories .harness and .claude are protected from rm, git rm and mv', () => {
  for (const c of ['rm -rf .harness', 'rm -r .harness/', 'rm -rf ./.harness', 'rm -rf .claude', 'git rm -r .harness', 'mv .harness .h2']) expect(bash(c), c).toBe('deny');
});
test('other .claude files stay writable', () => expect(edit('.claude/agents/x.md', 'Write').kind).toBe('allow'));
test('matching is case-insensitive', () => {
  expect(edit('.HARNESS/config.yaml', 'Write').kind).toBe('deny');
  expect(edit('.claude/Settings.json', 'Write').kind).toBe('deny');
  expect(bash('echo x > .HARNESS/config.yaml')).toBe('deny');
});
test('generic shell writes to protected paths are denied', () => {
  for (const c of ['cat x > .harness/config.yaml', 'truncate -s 0 .harness/config.yaml', 'ln -sf /tmp/x .harness/hooks/dispatch.mjs', 'git checkout -- .harness/config.yaml', 'git restore .claude/settings.json'])
    expect(bash(c), c).toBe('deny');
});

test('glob targets whose literal prefix is protected are denied', () => {
  for (const c of ['rm -rf .harness/*', 'rm .harness/hooks/*.mjs', 'rm -rf .claude/*', 'git rm .harness/hooks/d?spatch.mjs', 'mv .harness/[hs]* /tmp']) expect(bash(c), c).toBe('deny');
  expect(bash('rm -rf dist/*')).toBe('allow');
});
test('whole-tree and protected-path git restores are denied; other restores are not', () => {
  for (const c of ['git restore .', 'git checkout -- .', 'git checkout .', 'git restore :/', 'git restore ./', 'git checkout HEAD .harness/config.yaml', 'git restore --source=HEAD~1 .claude'])
    expect(bash(c), c).toBe('deny');
  for (const c of ['git restore src/a.ts', 'git checkout -b new', 'git checkout HEAD src/a.ts']) expect(bash(c), c).toBe('allow');
});

test('globs are matched against concrete protected paths', () => {
  for (const c of ['rm .harness/config.y?ml', 'rm -f .harness/co*', 'rm -f .claude/settings.j?on', 'rm -rf .*', 'rm .[!.]*', 'rm -rf .harness/{hooks,state}', "git restore '.harness/*'", 'mv .harness/{hooks,x} /tmp', 'cp a .claude/settings.j*'])
    expect(bash(c), c).toBe('deny');
  for (const c of ['rm -rf dist/*', 'rm src/*.tmp']) expect(bash(c), c).toBe('allow');
  expect(bash('rm -rf node_modules/{a,b}')).toBe('deny'); // node_modules is the package manager's (owner rule)
});
test('git global options do not hide restore and checkout', () => {
  for (const c of ['git -C . restore .', 'git -C . checkout -- .', 'git --no-pager restore .', 'git -c core.x=1 restore .claude/settings.json', 'git --git-dir=.git checkout HEAD .harness/config.yaml'])
    expect(bash(c), c).toBe('deny');
  expect(bash('git -C . restore src/a.ts')).toBe('allow');
});
test(':/ pathspecs and bash -c are seen', () => {
  for (const c of ["git restore ':/.'", 'git restore :/', 'bash -c "git restore ."', 'sh -c "mv a .harness/hooks/dispatch.mjs"']) expect(bash(c), c).toBe('deny');
});

test('test-results dir is protected from Write and from shell redirects', () => {
  expect(edit('.harness/state/test-results/x.json', 'Write').kind).toBe('deny');
  expect(bash('echo {} > .harness/state/test-results/x.json')).toBe('deny');
});

test('a repo reached through a symlinked path is still protected (dispatch, real registry)', async () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'h-symp-')));
  mkdirSync(join(real, 'repo'));
  spawnSync('git', ['init', '-q'], { cwd: join(real, 'repo') });
  symlinkSync(join(real, 'repo'), join(real, 'link'));
  const link = join(real, 'link');
  const out = await dispatch(JSON.stringify({ session_id: 's', cwd: link, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(link, '.harness/config.yaml') } }), registry, {});
  expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
});

describe('branch switch to a ref without the harness hooks (real repo)', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'h-sw-')));
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.ts'), 'x');
  git('add', 'a.ts');
  git('commit', '-q', '-m', 'old');
  git('branch', 'old');
  const oldSha = git('rev-parse', 'HEAD');
  mkdirSync(join(repo, '.harness/hooks'), { recursive: true });
  writeFileSync(join(repo, '.harness/hooks/dispatch.mjs'), '');
  git('add', '.harness');
  git('commit', '-q', '-m', 'harness');
  const cmd = (command: string) => {
    const config = loadConfig('/nonexistent-harness-root').config;
    const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: repo, tool_name: 'Bash', tool_input: { command } };
    return protect.run({ input, root: repo, config, env: {}, unattended: false } as unknown as Ctx) as { kind: string; reason?: string };
  };
  const SW = (ref: string) => `Switching to ${ref} removes the harness hooks (no .harness/hooks/dispatch.mjs there). Confirm the switch.`;

  test.each(['git checkout old', 'git switch old', 'git checkout -b x old', 'git checkout -B x old', 'git switch -c x old', 'git switch --detach old', 'git -C . switch old', 'git --no-pager checkout old', 'cd . && git switch old'])('%s asks', (c) => {
    expect(cmd(c)).toEqual({ kind: 'ask', reason: SW('old'), check: 'protect' });
  });
  test('a sha without the hooks asks', () => expect(cmd(`git checkout ${oldSha}`).reason).toBe(SW(oldSha)));
  test.each(['git checkout main', 'git switch main', 'git checkout -b x', 'git switch -c x', 'git switch -c x main', 'git checkout -- a.ts', 'git checkout old a.ts', 'git checkout old -- a.ts', 'git checkout a.ts', 'git status'])('%s is allowed', (c) => {
    expect(cmd(c).kind).toBe('allow');
  });
  test('a failed lookup asks', () => {
    expect(cmd('git switch no-such-branch')).toMatchObject({ kind: 'ask', reason: 'Could not check that no-such-branch has the harness hooks. Confirm the switch.' });
    expect(cmd('git -C /nonexistent-harness-dir checkout main').kind).toBe('ask');
  });
  test('unattended, the ask becomes a deny', async () => {
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git switch old' } }), registry, { CI: 'true' });
    expect(JSON.parse(out).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: `Unattended run: ${SW('old')}` });
  });
});

test('the event log is protected like the state dir', () => {
  for (const tool of ['Write', 'Edit']) expect(edit('.harness/logs/events.jsonl', tool).kind).toBe('deny');
  for (const c of ['rm .harness/logs/events.jsonl', 'rm -rf .harness/logs', 'rm .harness/logs/*', 'echo {} >> .harness/logs/events.jsonl', 'truncate -s 0 .harness/logs/events.jsonl', 'mv .harness/logs/events.jsonl /tmp'])
    expect(bash(c), c).toBe('deny');
});

test.each(['.harness/manifest.json', '.harness/backup/2026-11-01T00-00-00.000Z/AGENTS.md', '.harness/backup'])('agent write to %s is denied', (p) => {
  expect(edit(p, 'Write').kind).toBe('deny');
  expect(bash(`rm -rf ${p}`)).toBe('deny');
});
test('globs over the manifest or the backups are denied', () => {
  expect(bash('rm .harness/manifest.*')).toBe('deny');
  expect(bash('rm -rf .harness/back*')).toBe('deny');
});

test('whole-tree pathspecs on Windows: backslashes, .., drive-letter case', () => {
  const root = 'C:\\work\\repo';
  for (const t of ['.', '..', '..\\..', '.\\', 'C:\\work', 'c:\\WORK\\repo', ':\\', ':/']) expect(isWholeTree(root, t, win32), t).toBe(true);
  for (const t of ['src', 'src\\..\\lib', '..\\other']) expect(isWholeTree(root, t, win32), t).toBe(false);
  for (const t of ['.', '..', './', ':/']) expect(isWholeTree('/w/repo', t, posix), t).toBe(true);
  for (const t of ['src', '../other']) expect(isWholeTree('/w/repo', t, posix), t).toBe(false);
});

test.each([
  `node -e "require('fs').writeFileSync('.harness/state/cli-path', '/tmp/x/dist/cli.mjs')"`,
  `node --eval "require('fs').writeFileSync('.harness/manifest.json','{}')"`,
  `python3 -c "open('.harness/config.yaml','w').write('x')"`,
  `perl -e 'unlink ".harness/hooks/dispatch.mjs"'`,
  `ruby -e 'File.write(".claude/settings.json", "{}")'`,
  `bun -e "Bun.write('.harness/state/x', '')"`,
])('inline interpreter code that names a protected path is denied: %s', (c) => expect(bash(c)).toBe('deny'));
test.each([`node -e "console.log(1)"`, 'node dist/cli.mjs doctor', `python3 -c "print(1)"`, 'cat .harness/config.yaml'])(
  'other interpreter use is allowed: %s', (c) => expect(bash(c)).toBe('allow'));

// Owner rule: node_modules is managed by the package manager; the agent never writes into it directly.
const NM_REASON = 'node_modules is managed by the package manager, not edited by hand: change package.json and run an install instead.';
test.each(['Write', 'Edit', 'MultiEdit'])('%s into node_modules is denied with the package-manager reason', (tool) => {
  for (const p of ['node_modules/x/index.js', '/p/node_modules/@khubaibqaiser/harness/dist/cli.mjs', 'packages/a/node_modules/x/a.js', 'Node_Modules/x.js']) {
    const d = edit(p, tool);
    expect(d.kind, p).toBe('deny');
    expect(d.reason, p).toBe(NM_REASON);
  }
});
test('NotebookEdit into node_modules is denied', () => expect(run('NotebookEdit', { notebook_path: 'node_modules/x/n.ipynb' }).reason).toBe(NM_REASON));
test.each([
  'echo x > node_modules/x/index.js', 'echo x >> packages/a/node_modules/y.js', 'tee node_modules/x.js < a', "sed -i 's/a/b/' node_modules/x/index.js",
  'mv a.js node_modules/x/a.js', 'mv node_modules/x/a.js a.js', 'cp -r dist node_modules/@khubaibqaiser/harness/dist', 'rm -rf node_modules',
  'rm -rf node_modules/x', 'rm node_modules/*', 'rm -rf packages/*/node_modules', 'git checkout -- node_modules/x/a.js', 'bash -c "echo x > node_modules/y.js"',
  'truncate -s 0 node_modules/x.js', 'ln -s /tmp/evil node_modules/x',
  `node -e "require('fs').writeFileSync('node_modules/@khubaibqaiser/harness/dist/cli.mjs', '')"`, `python3 -c "open('node_modules/x.js','w')"`,
])('shell write into node_modules is denied: %s', (c) => {
  const d = run('Bash', { command: c });
  expect(d.kind, c).toBe('deny');
  expect(d.reason, c).toBe(NM_REASON);
});
test.each(['cat node_modules/x/package.json', 'ls node_modules', 'cp node_modules/x/a.js /tmp/a.js', 'pnpm install', 'npm ci', 'echo x > /tmp/node_modules/x.js', 'grep -r foo node_modules'])(
  'reading node_modules, an install, or a path outside the repo is not this rule: %s', (c) => expect(bash(c)).toBe('allow'));
