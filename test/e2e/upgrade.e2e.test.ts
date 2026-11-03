// Real beta installs (test/fixtures/old-install, from scripts/old-install-fixtures.mjs) through this version's
// update, the hooks, doctor and uninstall: they come out byte-identical to the repo before the beta's init.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { BETA_GROUPS } from '../install/helpers.js';
import { PREFIX, cleanup } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'dist', 'cli.mjs');
const FIXTURES = join(here, '..', 'fixtures', 'old-install');
const FRAGMENT = JSON.parse(readFileSync(join(here, '..', '..', 'templates', 'settings.fragment.json'), 'utf8'));
const DISPATCH = '.harness/hooks/dispatch.mjs';
const OLD = '.harness/state/test-results';

interface OldInstall { beta: string; before: Record<string, string>; installed: Record<string, string>; hand?: Record<string, string> }
const names = readdirSync(FIXTURES).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();

const env = { ...process.env };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE']) delete env[k];
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
/** env with a fake `claude` printing `version` first on PATH. */
const withClaude = (version: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'h-up-claude-'));
  made.push(dir);
  writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho '${version} (Claude Code)'\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'claude.cmd'), `@echo ${version} (Claude Code)\r\n`);
  return { ...env, [pathKey]: dir + delimiter + (env[pathKey] ?? '') };
};

const made: string[] = [];
afterEach(() => void made.splice(0).forEach(cleanup));

const write = (root: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
};
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
const commit = (root: string, m: string) => (git(root, 'add', '-A'), git(root, 'commit', '-q', '--allow-empty', '-m', m));
const cli = (root: string, args: string[], e = env) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout + r.stderr };
};
const walk = (root: string, dir = root, out: Record<string, string> = {}) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else out[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
  }
  return out;
};

const HOME = mkdtempSync(join(tmpdir(), 'h-up-home-'));
const hook = (root: string, input: Record<string, unknown>) => {
  const r = spawnSync('node', [join(root, DISPATCH)], { cwd: root, encoding: 'utf8', env: { ...env, HOME, USERPROFILE: HOME }, input: JSON.stringify({ session_id: 's1', cwd: root, ...input }) });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

/** Update's checks on a migrated install; `results` is the beta's old results folder content, when the fixture has one. */
function expectMigrated(root: string, results: Record<string, string>) {
  const s = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  for (const [event, groups] of Object.entries(FRAGMENT.hooks as Record<string, object[]>)) expect(s.hooks[event], event).toContainEqual(groups[0]);
  for (const [event, group] of Object.entries(BETA_GROUPS)) expect(s.hooks[event] ?? [], event).not.toContainEqual(group);
  expect(JSON.stringify(s.hooks)).not.toContain('node \\"${CLAUDE_PROJECT_DIR}');
  expect(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.harness/results/');
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toMatch(/^ {2}results_dir: \.harness\/results$/m);
  for (const rel of ['vitest.config.ts', 'package.json', 'jest.config.js']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8');
    expect(t, rel).not.toContain(OLD);
    for (const m of t.matchAll(/[\w./-]*\/root\.json/g)) expect(m[0], rel).toBe('.harness/results/root.json');
  }
  for (const [rel, text] of Object.entries(results)) expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(text);
}

test.each(names.flatMap((n) => [[n, 'unattended'], [n, 'always']] as const))('%s (%s): beta install through update, hooks, doctor and uninstall', (name, mode) => {
  const f: OldInstall = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  const root = mkdtempSync(join(tmpdir(), PREFIX));
  made.push(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, f.before);
  commit(root, 'before');
  write(root, f.installed);
  commit(root, 'beta install');
  const results = Object.fromEntries(Object.entries(f.installed).filter(([rel]) => rel.startsWith(`${OLD}/`)));

  const u = cli(root, ['update', '--yes']);
  expect(u.code, u.out).toBe(0);
  commit(root, 'update');
  expectMigrated(root, results);

  expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();
  expect(JSON.parse(readFileSync(join(root, '.harness/state/hook-env.json'), 'utf8'))).toMatchObject({ node: process.version, platform: process.platform });
  const denied = hook(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(root, '.harness/config.yaml'), old_string: 'a', new_string: 'b' } });
  expect(denied?.hookSpecificOutput?.permissionDecision).toBe('deny');

  const old = cli(root, ['doctor'], withClaude('2.1.313'));
  expect(old.out).toContain('fix Claude Code 2.1.313 is older than 2.1.314: update Claude Code');
  expect(old.code).toBe(1);
  expect(cli(root, ['doctor'], withClaude('2.1.314')).out).toContain('ok Claude Code 2.1.314');

  const kept: Record<string, string> = {};
  if (mode === 'always') {
    const cfg = join(root, '.harness/config.yaml');
    kept['.harness/config.yaml'] = readFileSync(cfg, 'utf8') + 'sandbox: always\n';
    writeFileSync(cfg, kept['.harness/config.yaml']);
    commit(root, 'always');
    const a = cli(root, ['update', '--yes']);
    expect(a.code, a.out).toBe(0);
    const s = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    expect(s.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
    if (f.before['.claude/settings.json']) expect(s.sandbox.network).toEqual(JSON.parse(f.before['.claude/settings.json']).sandbox.network);
    commit(root, 'update always');
  }

  const un = cli(root, ['uninstall', '--yes']);
  expect(un.code, un.out).toBe(0);
  // The person's own edits are theirs: the jest-config hand lines keep everything but harness's rename, and the
  // config edited to `always` is kept, as uninstall keeps any edited file. Everything else is the pre-init bytes.
  if (mode === 'always') expect(un.out).toContain('Kept `.harness/config.yaml` because you edited them.');
  expect(walk(root)).toEqual({ ...f.before, ...f.hand, ...kept });
});
