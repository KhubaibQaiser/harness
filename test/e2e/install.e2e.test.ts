import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { PREFIX, build, cleanup, existingCrlf, noTests, npmVitest, standard, unsafeVitest, type Fixture } from './fixtures.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const DISPATCH = '.harness/hooks/dispatch.mjs';

// The suite must behave like an attended session even when CI or a parent agent sets these.
const env = { ...process.env };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE']) delete env[k];

const made: string[] = [];
afterEach(() => void made.splice(0).forEach(cleanup));
const repo = (f: Fixture) => {
  const root = build(f);
  made.push(root);
  return root;
};

const cli = (root: string, ...args: string[]) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
};

/** Pipes one hook JSON into the installed dispatcher; returns the parsed decision, or null for "no output". */
const hook = (root: string, input: Record<string, unknown>) => {
  const r = spawnSync('node', [join(root, DISPATCH)], { cwd: root, encoding: 'utf8', env, input: JSON.stringify({ session_id: 's1', cwd: root, ...input }) });
  expect(r.status).toBe(0);
  return r.stdout ? (JSON.parse(r.stdout) as any) : null;
};
const pre = (root: string, tool_name: string, tool_input: Record<string, unknown>) => hook(root, { hook_event_name: 'PreToolUse', tool_name, tool_input });
const verdict = (d: any): { decision: string; reason: string } =>
  d?.hookSpecificOutput ? { decision: d.hookSpecificOutput.permissionDecision, reason: d.hookSpecificOutput.permissionDecisionReason } : { decision: d ? d.decision : 'allow', reason: d?.reason ?? '' };
const edit = (root: string, file: string) => verdict(pre(root, 'Edit', { file_path: join(root, file), old_string: 'a', new_string: 'b' }));

const walk = (root: string, dir = root, out = new Map<string, string>()): Map<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else out.set(relative(root, p), readFileSync(p).toString('base64'));
  }
  return out;
};

const FAIL_STEP = ['node', '-e', "process.exit(require('fs').existsSync('BROKEN')?1:0)"];
/** Overlay config for `init --config`: command-object steps only, so no package manager or install is needed. */
const writeSteps = (): string => {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  made.push(dir);
  const file = join(dir, 'answers.yaml');
  writeFileSync(file, `stop:\n  steps:\n    - name: ok\n      run: ["node", "-e", "0"]\n    - name: broken-check\n      run: ${JSON.stringify(FAIL_STEP)}\n`);
  return file;
};
const init = (root: string, f: Fixture) => cli(root, 'init', ...(f.steps ? ['--config', writeSteps(), '--yes'] : ['--yes']));

describe('fixture repos', () => {
  test.each(standard.map((b) => [b().name, b] as const))('%s: init, gates, stop, uninstall', (_n, b) => {
    const f = b();
    const root = repo(f);
    const before = walk(root);

    const i = init(root, f);
    expect(i.out).toContain('Teammates need nothing else');
    expect(i.code).toBe(0);
    expect(existsSync(join(root, DISPATCH))).toBe(true);

    // The session's first hook fixes its start time; results must be written after it.
    expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();

    if (f.tdd) {
      const red = edit(root, f.tdd.file);
      expect(red.decision).toBe('deny');
      expect(red.reason).toContain(f.tdd.test);
      const dir = join(root, '.harness/state/test-results');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'e2e.json'),
        JSON.stringify({ testResults: [{ name: join(root, f.tdd.test), status: 'failed', assertionResults: [{ fullName: 't fails', status: 'failed' }] }] }),
      );
      expect(edit(root, f.tdd.file).decision).toBe('allow');
    } else {
      expect(edit(root, f.first).decision).toBe('allow');
    }

    expect(edit(root, 'tools/other.js').decision).toBe('ask'); // second source unit in one turn
    expect(pre(root, 'Read', { file_path: join(root, '.env') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(verdict(pre(root, 'Bash', { command: 'git push origin main' })).decision).toBe('deny');
    expect(edit(root, '.harness/config.yaml').decision).toBe('deny');

    // Stop: a failing step blocks, and once fixed the turn may end.
    writeFileSync(join(root, 'BROKEN'), 'x');
    const stop = () => verdict(hook(root, { hook_event_name: 'Stop' }));
    if (f.steps) {
      const blocked = stop();
      expect(blocked.decision).toBe('block');
      expect(blocked.reason).toContain('broken-check failed');
      rmSync(join(root, 'BROKEN'));
      if (f.tdd) mkdirSync(join(root, 'coverage'), { recursive: true }), writeFileSync(join(root, 'coverage/coverage-final.json'), '{}');
      expect(stop().decision).toBe('allow');
    } else {
      rmSync(join(root, 'BROKEN'));
      expect(stop().decision).toBe('allow'); // nothing to run
    }

    expect(cli(root, 'status').out).toContain('stop: on');
    rmSync(join(root, 'coverage'), { recursive: true, force: true }); // the test's own artifact, not the harness's
    const u = cli(root, 'uninstall', '--yes');
    expect(u.code).toBe(0);
    expect(walk(root)).toEqual(before);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout).toBe('');
  });
});

test('existing setup with CRLF: other hooks and line endings survive init and uninstall', () => {
  const f = existingCrlf();
  const root = repo(f);
  const before = walk(root);
  expect(init(root, f).code).toBe(0);
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const settings = read('.claude/settings.json');
  expect(settings).toContain('prettier --write');
  expect(read('.claude/settings.local.json')).toContain('notify.sh');
  expect(settings).toContain(DISPATCH);
  for (const rel of ['.claude/settings.json', 'CLAUDE.md', 'AGENTS.md', 'package.json', 'vitest.config.ts']) {
    const t = read(rel);
    expect(t.replace(/\r\n/g, ''), rel).not.toMatch(/[\r\n]/); // every newline is CRLF: no bare LF or CR
  }
  expect(cli(root, 'uninstall', '--yes').code).toBe(0);
  expect(walk(root)).toEqual(before);
});

test('unsafe vitest config: init prints manual lines and doctor names the fix', () => {
  const f = unsafeVitest();
  const root = repo(f);
  const before = walk(root);
  const i = init(root, f);
  expect(i.code).toBe(0);
  expect(i.out).toContain('Do these by hand:');
  expect(i.out).toContain("outputFile: { json: '.harness/state/test-results/root.json' }");
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toBe(f.files['vitest.config.ts']);
  const d = cli(root, 'doctor');
  expect(d.code).toBe(0); // a note, not a problem
  expect(d.out).toMatch(/note TDD is off for the root package because its test config could not be edited safely: do this by hand/);
  expect(cli(root, 'uninstall', '--yes').code).toBe(0);
  expect(walk(root)).toEqual(before);
});

test('doctor flags tampering and a broken wiring, and update repairs both', () => {
  const f = npmVitest();
  // A coverage provider, so a fresh install is fully healthy (without one doctor names the coverage-gate fix).
  f.files['package.json'] = JSON.stringify({ name: 'n', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0', '@vitest/coverage-v8': '^2.0.0' } }, null, 2) + '\n';
  const root = repo(f);
  expect(init(root, f).code).toBe(0);
  expect(cli(root, 'doctor').code).toBe(0);
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: root, encoding: 'utf8' });
  git('add', '-A');
  expect(git('commit', '-q', '-m', 'harness').status).toBe(0);

  appendFileSync(join(root, DISPATCH), '\n// tampered\n');
  const a = cli(root, 'doctor');
  expect(a.code).toBe(1);
  expect(a.out).toMatch(/^fix .*does not match the installed version/m);

  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  for (const ev of Object.keys(s.hooks))
    s.hooks[ev] = s.hooks[ev].filter((g: any) => !g.hooks.some((h: any) => h.command.includes(DISPATCH)));
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  const b = cli(root, 'doctor');
  expect(b.code).toBe(1);
  expect(b.out).toMatch(/^fix .*does not run the dispatcher/m);

  const dirty = cli(root, 'update', '--yes');
  expect(dirty.code).toBe(1); // uncommitted changes to files update would rewrite
  expect(dirty.out).toContain('Commit or stash these files first');
  git('add', '-A');
  expect(git('commit', '-q', '-m', 'tampered').status).toBe(0);
  const u = cli(root, 'update', '--yes');
  expect(u.code).toBe(0);
  const c = cli(root, 'doctor');
  expect(c.out).not.toMatch(/^fix /m);
  expect(c.code).toBe(0);
});

// Claude Code runs the settings command string through a shell (Git Bash on Windows), with CLAUDE_PROJECT_DIR set.
test('the settings hook command runs through a shell from a repo path with a space and a non-ASCII letter', () => {
  const f = npmVitest();
  const root = repo(f);
  expect(root).toMatch(/ .*ü/);
  expect(init(root, f).code).toBe(0);
  const s = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  const command: string = s.hooks.PreToolUse[0].hooks[0].command;
  expect(command).toContain('${CLAUDE_PROJECT_DIR}');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, '.claude/settings.json'), content: '{}' } });
  const r = spawnSync(command, { cwd: root, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: root }, input, shell: process.platform === 'win32' ? 'bash' : '/bin/sh' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(verdict(JSON.parse(r.stdout)).decision).toBe('deny'); // protect answered, so the dispatcher ran
});

// The package is left out of tdd.paths, so red-first never denies edits whose results can never be written.
test('unsafe vitest config: TDD is off in status and red-first allows edits', () => {
  const f = unsafeVitest();
  const root = repo(f);
  expect(init(root, f).code).toBe(0);
  expect(cli(root, 'status').out).toMatch(/tdd: off - TDD off for the root package because its test config could not be edited safely/);
  expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();
  expect(edit(root, 'src/a.ts').decision).toBe('allow');
});
