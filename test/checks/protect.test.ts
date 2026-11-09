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
  expect(registry.map((c) => c.name).slice(0, 3)).toEqual(['guard', 'pr-size', 'protect']);
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

test('results dir is protected from Write, shell redirects and rm', () => {
  expect(edit('.harness/results/x.json', 'Write').kind).toBe('deny');
  expect(bash('echo {} > .harness/results/x.json')).toBe('deny');
  expect(bash('rm -rf .harness/results')).toBe('deny');
  expect(bash('pnpm test')).toBe('allow');
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

test.each(['.harness/manifest.json', '.harness/apply.lock', '.harness/backup/2026-11-01T00-00-00.000Z/AGENTS.md', '.harness/backup'])('agent write to %s is denied', (p) => {
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
])('shell write into node_modules is denied: %s', (c) => {
  const d = run('Bash', { command: c });
  expect(d.kind, c).toBe('deny');
  expect(d.reason, c).toBe(NM_REASON);
});
test.each(['cat node_modules/x/package.json', 'ls node_modules', 'cp node_modules/x/a.js /tmp/a.js', 'pnpm install', 'npm ci', 'echo x > /tmp/node_modules/x.js', 'grep -r foo node_modules'])(
  'reading node_modules, an install, or a path outside the repo is not this rule: %s', (c) => expect(bash(c)).toBe('allow'));

// Round 7: interpreters named by a Windows path or in another case still count.
test.each([
  `C:\\nodejs\\node.exe -e "require('fs').writeFileSync('.harness/state/x', '')"`,
  `/usr/local/bin/node -e "require('fs').writeFileSync('.harness/manifest.json','{}')"`,
  `"C:\\Program Files\\nodejs\\node.exe" -e "require('fs').rmSync('node_modules/x', { recursive: true })"`,
  `NODE.EXE -e "require('fs').writeFileSync('.harness\\\\state\\\\x', '')"`,
])('inline interpreter by path or case is denied: %s', (c) => expect(bash(c)).toBe('deny'));

// Round 8: only the interpreter's own flags before its first argument are inline code, and the reason says why.
const NM_INLINE = 'Inline code (node -e, python -c and the like) that names node_modules is denied: it may write there, and a text match cannot tell a read from a write. node_modules is managed by the package manager: change package.json and run an install instead.';
const H_INLINE = 'Inline code (node -e, python -c and the like) that names harness files or Claude settings is denied: it may write them, and a text match cannot tell a read from a write. Harness files and Claude settings are changed by a person, not the agent.';
test.each([
  `node -e "require('fs').writeFileSync('node_modules/@khubaibqaiser/harness/dist/cli.mjs', '')"`, `python3 -c "open('node_modules/x.js','w')"`,
  `node -e "console.log(require('./node_modules/vitest/package.json').version)"`, `node --eval="require('./node_modules/x')"`, `node -r ./setup.js -e "require('node_modules/x')"`,
  `perl -pi -e 's/a/b/' node_modules/x.js`, `ruby -e 'File.write("node_modules/x", "")'`, `php -r "unlink('node_modules/x');"`, `deno eval "Deno.removeSync('node_modules/x')"`,
  `timeout 5 node -e "require('fs').rmSync('node_modules', { recursive: true })"`,
])('inline code naming node_modules is denied with the inline reason: %s', (c) => {
  const d = run('Bash', { command: c });
  expect(d.kind, c).toBe('deny');
  expect(d.reason, c).toBe(NM_INLINE);
});
test('inline code naming harness files is denied with the inline reason', () => {
  expect(run('Bash', { command: `node -e "require('fs').writeFileSync('.harness/manifest.json','{}')"` }).reason).toBe(H_INLINE);
});
test.each([
  'node ./node_modules/.bin/jest -c jest.config.js', 'node node_modules/typescript/bin/tsc -p tsconfig.json', 'node -r ./node_modules/tsx/dist/cjs/index.cjs src/a.ts',
  'node --require ./node_modules/x/register.js src/a.ts', 'node --import ./node_modules/tsx/dist/esm/index.mjs src/a.ts', 'python3 -m pytest -c node_modules/x.ini',
  'python3 node_modules/x/run.py -c a', 'node node_modules/.bin/vitest run', 'perl node_modules/x/a.pl -e x', 'bun node_modules/.bin/x -e y',
])('running a file from node_modules is not inline code: %s', (c) => expect(bash(c)).toBe('allow'));

// Round 8: more shell writers name their target.
test.each([
  'touch packages/a/node_modules/x', 'touch -d 2020-01-01 node_modules/x', "find node_modules -name '*.log' -delete", 'find ./node_modules/x -type f -exec rm {} ;',
  'find packages/a/node_modules -execdir rm -f {} +', 'tar -xzf pkg.tgz -C node_modules/', 'tar xzf pkg.tgz --directory=node_modules/x', 'tar -x -f pkg.tgz --directory node_modules',
  'tar -czf node_modules/x.tgz src', 'unzip pkg.zip -d node_modules/x', 'rsync -a dist/ node_modules/@khubaibqaiser/harness/dist/', 'install -m 644 a.js node_modules/x/a.js',
  'dd if=a of=node_modules/x bs=1',
])('writer into node_modules is denied: %s', (c) => {
  const d = run('Bash', { command: c });
  expect(d.kind, c).toBe('deny');
  expect(d.reason, c).toBe(NM_REASON);
});
test.each(['touch .harness/state/x', 'find .harness/logs -delete', 'tar -xf a.tgz -C .harness/hooks'])('writer into harness files is denied: %s', (c) => expect(bash(c)).toBe('deny'));
test.each([
  "find node_modules -name '*.d.ts'", 'tar -czf out.tgz -C node_modules x', 'tar -tzf node_modules/x.tgz', 'rsync -a node_modules/x/ /tmp/x/', 'unzip -l node_modules/x.zip',
  'touch src/a.ts', 'find src -name "*.tmp" -delete',
])('reading node_modules, or writing elsewhere, is allowed: %s', (c) => expect(bash(c)).toBe('allow'));

// Round 9 F3: combined short options are inline code too.
test.each([
  `node -pe "require('fs').writeFileSync('node_modules/x','y')"`, `node -ep "require('fs').rmSync('node_modules/x')"`, `node -e="require('fs').writeFileSync('node_modules/x','y')"`,
  `python -Bc "open('node_modules/x','w')"`, `python3 -Ic "open('node_modules/x','w')"`, `perl -ne 'unlink "node_modules/x"' a`, `perl -pie 's/a/b/' node_modules/x.js`,
  `ruby -ne 'File.delete("node_modules/x")' a`, `bun -pe "Bun.write('node_modules/x','')"`,
])('F3: combined inline options naming node_modules are denied: %s', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test.each([`node -pe "require('fs').writeFileSync('.harness/config.yaml','y')"`, `perl -ne 'print' .harness/config.yaml`, `python -Bc "open('.claude/settings.json','w')"`])(
  'F3: combined inline options naming harness files are denied: %s', (c) => expect(run('Bash', { command: c }).reason).toBe(H_INLINE));
// F4: rsync options after the paths are not the destination.
test.each(['rsync -av src/ /tmp/dst/ --exclude node_modules', 'rsync -av src/ /tmp/dst/ --exclude=node_modules', 'rsync -av -e ssh src/ host:/dst/ --exclude .harness',
  'rsync src/ /tmp/dst/ --filter "- node_modules"', 'rsync -a --exclude-from node_modules/.ignore src/ /tmp/dst/'])(
  'F4: %s is allowed', (c) => expect(bash(c)).toBe('allow'));
test.each(['rsync -av src/ node_modules/x/ --exclude .git', 'rsync -e ssh -av host:/src/ node_modules/x/'])('F4: %s is denied', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_REASON));
// F5: inline code through other runners and TypeScript runners.
test.each([
  `npx tsx -e "require('fs').rmSync('node_modules', { recursive: true })"`, `tsx -e "require('fs').writeFileSync('node_modules/x','')"`, `ts-node -e "require('fs').writeFileSync('node_modules/x','')"`,
  `ts-node -pe "require('fs').writeFileSync('node_modules/x','')"`, `npx node -e "require('fs').writeFileSync('node_modules/x','')"`, `pnpm exec node -e "require('fs').writeFileSync('node_modules/x','')"`,
  `bunx tsx -e "require('fs').writeFileSync('node_modules/x','')"`, `pnpm dlx tsx --eval "require('fs').writeFileSync('node_modules/x','')"`, `timeout 5 deno eval "Deno.removeSync('node_modules/x')"`,
  `env FOO=1 node -e "require('fs').writeFileSync('node_modules/x','')"`,
])('F5: inline code through a runner is denied: %s', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test.each(['npx tsx src/a.ts', 'tsx node_modules/x/run.ts -e y', 'ts-node -P tsconfig.json src/a.ts', 'npx ts-node --project node_modules/x/tsconfig.json src/a.ts'])(
  'F5: running a file is allowed: %s', (c) => expect(bash(c)).toBe('allow'));

// Round 10 F6: protected names count only inside the inline code itself, and only as a path segment.
test.each([
  `cd node_modules/foo && node -e "console.log(process.cwd())"`, `ls node_modules; node -p "1+1"`, `cat .harness/config.yaml && node -p "process.version"`,
  `node -p "require('./package.json').version" > node_modules.txt`, 'echo node -e x node_modules', `node -e "console.log('my_node_modules_x')"`,
  `node -e "console.log(1)" && cat .claude/settings.json`, `python3 -c "print(1)"; ls node_modules`,
])('F6: %s is allowed', (c) => expect(bash(c)).toBe('allow'));
test.each([
  `node -e "require('fs').writeFileSync('node_modules/x','y')" > out.txt`, `ls; node -e "require('fs').rmSync('node_modules')"`, `bash -c "node -e \\"require('fs').rmSync('node_modules/x')\\""`,
  `node --eval="require('fs').rmSync('node_modules/x')"`, `node -e "a(); require('fs').rmSync('node_modules/x')"`,
])('F6: inline code that names node_modules is still denied: %s', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test('F6: a redirect into node_modules/ is still denied', () => expect(run('Bash', { command: `node -p "1" > node_modules/x.txt` }).reason).toBe(NM_REASON));

// Round 12 A: the basic rule finds an interpreter with an inline-code option at any word, whatever wraps it.
test.each([
  `cross-env FOO=1 node -e "require('fs').rmSync('node_modules', { recursive: true })"`, `dotenv -- node -e "require('fs').rmSync('node_modules/x')"`,
  `nvm exec 22 node -e "require('fs').rmSync('node_modules/x')"`, `watch -n1 node -e "require('fs').rmSync('node_modules/x')"`,
  `env -S "node -e \\"require('fs').rmSync('node_modules/x')\\""`, `npx -y node@22 -e "require('fs').rmSync('node_modules/x')"`,
  `some-unknown-wrapper --flag value python3 -c "open('node_modules/x','w')"`,
])('N1/N7: inline code behind any wrapper is denied: %s', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test(`N1: ionice -c3 node -e writing the harness config is denied`, () => {
  expect(run('Bash', { command: `ionice -c3 node -e "require('fs').writeFileSync('.harness/config.yaml','x')"` }).reason).toBe(H_INLINE);
});
// N3: $'…' quoting does not desync the reader; odd quoting fails toward checking.
test.each([`echo $'a\\'' ; node -e "require('fs').writeFileSync('.harness/config.yaml','x')"`, `echo "unterminated ; node -e "require('fs').writeFileSync('.harness/config.yaml','x')"`])(
  'N3: %s is denied', (c) => expect(bash(c)).toBe('deny'));
// N4: code fed to a shell or interpreter on stdin.
test.each([
  `echo 'rm -rf node_modules' | bash`, `printf 'rm -rf node_modules/x\\n' | sh`, `bash -s <<< 'rm -rf node_modules'`,
  "node <<'EOF'\nrequire('fs').rmSync('node_modules', { recursive: true })\nEOF", "bash <<EOF\necho x > .harness/config.yaml\nEOF",
  `echo "require('fs').writeFileSync('.harness/config.yaml','x')" | node`,
])('N4: stdin code naming a protected path is denied: %s', (c) => expect(bash(c)).toBe('deny'));
test.each([`echo 'ls node_modules' | bash`, `echo hi | node -e "process.stdin.pipe(process.stdout)"`, "cat <<'EOF'\nnode_modules\nEOF", `echo node_modules | grep x`])(
  'N4: %s is allowed', (c) => expect(bash(c)).toBe('allow'));
// Round 23, C2: a substitution opened after the operator, or a quote open at a line end, runs the next lines before
// the body starts, so they are not body text. W alone asks; hidden that way it must not be allowed.
const W = 'echo x > .harness/state.json';
test.each([
  `cat > docs/x.md <<EOF; echo $(\n${W}\n)\nEOF`, `cat > docs/x.md <<'EOF'; x=$(\n${W}\n)\nEOF`, `cat > docs/x.md <<-EOF; echo \${x:-$(\n${W}\n)}\nEOF`,
  `cat > docs/x.md <<EOF; echo \`\n${W}\n\`\nEOF`, `cat > docs/x.md <<EOF; echo $(true\n${W})\nEOF`, `tee docs/x.md >/dev/null <<"EOF"; echo $(\n${W}\n)\nEOF`,
  `echo '\ncat > docs/x.md <<EOF\n'; ${W}\nEOF`, `echo "\ncat > docs/x.md <<EOF\n"; ${W}\nEOF`,
])('C2: %s is not allowed', (c) => expect(bash(c)).not.toBe('allow'));
test('C2: a plain heredoc body naming a harness path stays data', () => expect(bash(`cat > docs/x.md <<'EOF'\n${W}\nEOF`)).toBe('allow'));
// Round 24, P2: bodies are taken out only of text the canonical lexer accepts, so a process substitution after the
// operator, or a `\"` that keeps a quote open past the line end, leaves every line in place as code.
test.each([
  `cat > docs/x.md <<EOF; cat <(\n${W}\n)\nEOF`, `cat > docs/x.md <<EOF; echo >(\n${W}\n)\nEOF`,
  `echo "\\"\ncat > docs/x.md <<EOF\n"; ${W}\nEOF`, `echo "a\\"b\ncat > docs/x.md <<'EOF'\n"; ${W}\nEOF`,
])('P2: %s is not allowed', (c) => expect(bash(c)).not.toBe('allow'));

// Round 25 (re-review 22b): the lexer alone finds heredocs (F1, F5), only full canonicalText strips them (F3), and an
// unquoted delimiter's body with a substitution is code (F2). Each payload on its own asks or denies.
{
  const ch = (...c: number[]) => String.fromCharCode(...c);
  const built = ['p=.harness/config.yaml; echo x > $p', 'cd .harness && echo x > config.yaml'];
  test.each([
    ...built.flatMap((x) => [`cat > docs/x.md "\\" <<W "\n${x}\nW`, `cat "\\" <<W " > docs/x.md\n${x}\nW`]), // F1
    ...['$(echo x > .harness/config.yaml)', `\`${ch(114, 109)} -rf .harness\``, ...built.map((x) => `$(${x})`)].map((x) => `cat > docs/x.md <<EOF\n${x}\nEOF`), // F2
    ...built.map((x) => `cat > docs/x.md <<EOF\nEO\\\nF\n${x}\nEOF`), // F3
    ...built.map((x) => `cat > docs/x.md <<<x\n${x}\nx`), // F5
  ])('round 25: %s is not allowed', (c) => expect(bash(c)).not.toBe('allow'));
  // F2 in protect's own `$(cat <<EOF … EOF)` message reader: an unquoted body with a substitution, or a body whose first
  // end line comes before the one the reader stopped at, is not a message.
  test.each(built.flatMap((x) => [`git commit -m "$(cat <<EOF\n$(${x})\nEOF\n)"`, `git commit -m "$(cat <<EOF\nmsg \`${x}\`\nEOF\n)"`,
    `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n${x}\nEOF\n)"`]))('round 25: %s is not allowed', (c) => expect(bash(c)).not.toBe('allow'));
  test('round 25: a quoted-delimiter body, and a commit body with only $NAME, stay data', () => {
    for (const c of [`cat > docs/x.md <<'EOF'\n$(echo x > .harness/config.yaml)\nEOF`, `git commit -m "$(cat <<'EOF'\nfix: see .harness/config.yaml\nEOF\n)"`,
      `git commit -m "$(cat <<EOF\nfix: $HOME .harness/config.yaml\nEOF\n)"`]) expect(bash(c), c).toBe('allow');
  });
}

// Round 26 (re-review 23b, N1): a commit or PR body ends only at a line that is exactly its delimiter (leading tabs under
// `<<-`), with `)` on the next line. ` EOF`, `\tEOF`, `EOF `, `EOF )` are body text in zsh and bash 5, so the line after
// the real end line runs. Each payload alone asks.
{
  const pays = ['cd .harness && echo x > config.yaml', W];
  const n1 = pays.flatMap((x) => [
    `git commit -m "$(cat <<'EOF'\nmsg\nEOF \n)\nEOF\n${x}\n)"`, `git commit -m "$(cat <<'EOF'\nmsg\n EOF\n)\nEOF\n${x}\n)"`,
    `git commit -m "$(cat <<'EOF'\nmsg\n\tEOF\n)\nEOF\n${x}\n)"`, `git commit -m "$(cat <<'EOF'\nmsg\nEOF )\nEOF\n${x}\n)"`,
    `git commit -m "$(cat <<EOF\nmsg\nEOF \n)\nEOF\n${x}\n)"`, `gh pr create --title t --body "$(cat <<'EOF'\nmsg\nEOF \n)\nEOF\n${x}\n)"`,
    `git commit -m "$(cat <<'EOF'\nmsg\nEOF\r\n)\nEOF\n${x}\n)"`,
  ]);
  test.each(n1)('round 26: %j is not allowed', (c) => expect(bash(c)).not.toBe('allow'));
  test.each(n1)('round 26: %j is not allowed through the dispatcher', async (c) => {
    const root = mkdtempSync(join(tmpdir(), 'h-pr-26-'));
    mkdirSync(join(root, '.git'));
    const raw = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: c } });
    const out = await dispatch(raw, registry, {}, { home: root });
    expect(out && JSON.parse(out).hookSpecificOutput?.permissionDecision).toMatch(/^(ask|deny)$/);
  });
  test('round 26: exact end lines, <<- tabs and the closing quote stay a message', () => {
    for (const c of [`git commit -m "$(cat <<'EOF'\nfix: see .harness/config.yaml\nEOF\n)"`, `git commit -m "$(cat <<-'EOF'\n\tfix: .harness/state.json\n\t\tEOF\n  )"`,
      `gh pr create --title t --body "$(cat <<'EOF'\n.harness/config.yaml\nEOF\n)"`, `git commit -m "$(cat <<'EOF'\n.harness/x\nEOF\n)" && git status`,
      `git commit -m "$(cat <<'EOF'\nmsg\nEOF)\n${W}\nEOF\n)"`]) // `EOF)` is body text, so W is too
      expect(bash(c), c).toBe('allow');
  });
}

// Round 14 D1: env -S strings are split with env's own rules, so `(` is an ordinary character.
test.each([`env -S "node -e require('fs').rmSync('node_modules')"`, `env --split-string="node -p require('fs').rmSync('node_modules/x')"`, `env -S 'node -e "require(\\"fs\\").rmSync(\\"node_modules\\")"'`])(
  'D1: %s is denied', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test(`D1: env -S naming .harness is denied`, () => expect(run('Bash', { command: `env --split-string="node -p require('fs').rmSync('.harness')"` }).reason).toBe(H_INLINE));
test.each([`env -S "node -p 1+1"`, `env -S "FOO=1 node src/a.js"`])('D1: %s is allowed', (c) => expect(bash(c)).toBe('allow'));

// Round 15 E1: -S at the end of a short-option cluster, spaced or attached.
test.each([
  `env -iS "node -e require('fs').rmSync('node_modules')"`, `env -vS "node -e require('fs').rmSync('node_modules')"`, `env -i -S "node -e require('fs').rmSync('node_modules')"`,
  `env -iS"node -e require('fs').rmSync('node_modules')"`, `env -0vS 'node -p require("fs").rmSync("node_modules/x")'`,
])('E1: %s is denied', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));

// Round 16 F1: env options that take the next word as their value don't end the scan before -S.
test.each([
  `env -u FOO -S "node -e require('fs').rmSync('node_modules')"`, `env --unset FOO -S "node -e require('fs').rmSync('node_modules')"`,
  `env -C . -S "node -e require('fs').rmSync('node_modules')"`, `env --chdir . -S "node -e require('fs').rmSync('node_modules')"`,
  `env -a x -S "node -e require('fs').rmSync('node_modules')"`, `env --argv0 x -S "node -e require('fs').rmSync('node_modules')"`,
  `env -iu FOO -S "node -e require('fs').rmSync('node_modules')"`, `env -i -u A -u B -C . -vS "node -e require('fs').rmSync('node_modules')"`,
])('F1: %s is denied', (c) => expect(run('Bash', { command: c }).reason).toBe(NM_INLINE));
test('F1: denied attended and unattended (through the dispatcher)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h-pr-f1-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  protect: true\n');
  const raw = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: `env -u FOO -S "node -e require('fs').rmSync('node_modules')"` } });
  for (const env of [{}, { CI: 'true' }]) expect(JSON.parse(await dispatch(raw, registry, env)).hookSpecificOutput.permissionDecision).toBe('deny');
});

test('PowerShell and Monitor writes to harness files are denied', () => {
  expect(run('PowerShell', { command: 'echo x > .harness/state/a.json' }).kind).toBe('deny');
  expect(run('Monitor', { command: 'tail -f log > .claude/settings.json' }).kind).toBe('deny');
});

test('the pr-ship skill\'s --pr-size call passes the full PreToolUse registry', async () => {
  const cmd = 'node .harness/hooks/dispatch.mjs --pr-size --base feat/a';
  expect(bash(cmd)).toBe('allow');
  const config = loadConfig('/nonexistent-harness-root').config;
  const ctx = { input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: ROOT, tool_name: 'Bash', tool_input: { command: cmd } }, root: ROOT, config, env: {}, unattended: false } as unknown as Ctx;
  for (const c of registry.filter((c) => c.events.includes('PreToolUse') && (c.name === 'guard' || c.name === 'protect'))) expect((await c.run(ctx)).kind, c.name).toBe('allow');
});
