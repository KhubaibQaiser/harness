import { expect, test } from 'vitest';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, registry } from '../../src/hooks/dispatch.js';

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

test.each(['.harness/hooks/dispatch.mjs', '.harness/state/s.json', '.harness/state/tdd-pause.json', '.harness/config.yaml', '.claude/settings.json', '.claude/settings.local.json', '/p/.harness/hooks/dispatch.mjs'])(
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
    'rm .harness/hooks/dispatch.mjs', 'rm -rf .harness/hooks', 'rm -rf node_modules .harness/state/',
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
test('whole-tree and protected-path git restores are denied; branch switches are not', () => {
  for (const c of ['git restore .', 'git checkout -- .', 'git checkout .', 'git restore :/', 'git restore ./', 'git checkout HEAD .harness/config.yaml', 'git restore --source=HEAD~1 .claude'])
    expect(bash(c), c).toBe('deny');
  for (const c of ['git checkout feature/x', 'git restore src/a.ts', 'git checkout -b new', 'git checkout HEAD src/a.ts']) expect(bash(c), c).toBe('allow');
});

test('globs are matched against concrete protected paths', () => {
  for (const c of ['rm .harness/config.y?ml', 'rm -f .harness/co*', 'rm -f .claude/settings.j?on', 'rm -rf .*', 'rm .[!.]*', 'rm -rf .harness/{hooks,state}', "git restore '.harness/*'", 'mv .harness/{hooks,x} /tmp', 'cp a .claude/settings.j*'])
    expect(bash(c), c).toBe('deny');
  for (const c of ['rm -rf dist/*', 'rm src/*.tmp', 'rm -rf node_modules/{a,b}']) expect(bash(c), c).toBe('allow');
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
