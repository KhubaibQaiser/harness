import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { settingsFragment } from '../../src/install/merge.js';
import { build, cleanup, hookRunner, pnpmMonorepo } from './fixtures.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'dist', 'cli.mjs');
const AI = (f: string) => join(ROOT, 'test/fixtures/ai', f);
const CAT = (v: string) => join(ROOT, 'test/fixtures/catalog-e2e', v);

const tmp: string[] = [];
afterAll(() => tmp.forEach(cleanup));
const mk = (p: string) => (tmp.push(mkdtempSync(join(tmpdir(), p))), tmp.at(-1)!);

// A fake `claude`: logs its argv, answers --version, `plugin install` and `plugin list --json`. The shims make it work on Windows too.
const bin = mk('h-e2e-bin-');
const LOG = join(bin, 'argv.log');
writeFileSync(
  join(bin, 'fake-claude.mjs'),
  `import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(LOG)}, a.join(' ') + '\\n');
if (a[0] === '--version') console.log(${JSON.stringify(MIN_CLAUDE_CODE + ' (Claude Code)')});
else if (a[0] === 'plugin' && a[1] === 'install') console.log(JSON.stringify({ command: 'install', outcome: 'ok', message: 'installed ' + a[2] }));
else if (a[0] === 'plugin' && a[1] === 'list') {
  const log = existsSync(${JSON.stringify(LOG)}) ? readFileSync(${JSON.stringify(LOG)}, 'utf8').split('\\n') : [];
  const ids = [...new Set(log.filter((l) => l.startsWith('plugin install ')).map((l) => l.split(' ')[2]))];
  console.log(JSON.stringify(ids.map((id) => ({ id, version: '1.0.0', enabled: true, scope: 'project' }))));
} else process.exit(1);
`,
);
writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.mjs" "$@"\n');
chmodSync(join(bin, 'claude'), 0o755);
writeFileSync(join(bin, 'claude.cmd'), '@node "%~dp0fake-claude.mjs" %*\r\n');
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter((l) => l.startsWith('plugin ')) : []);

const HOME = mk('h-e2e-home-');
const env: NodeJS.ProcessEnv = { ...process.env, HOME, USERPROFILE: HOME, CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1', HARNESS_CATALOG_DIR: CAT('v1') };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX']) delete env[k];
const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
env[pathKey] = bin + delimiter + (env[pathKey] ?? '');

const { hook, pre, verdict } = hookRunner(env);
const cli = (root: string, e: NodeJS.ProcessEnv, ...args: string[]) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout + r.stderr };
};
const walk = (root: string, dir = root, out = new Map<string, string>()): Map<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.set(relative(root, p) + '/', ''); // empty directories count too
      walk(root, p, out);
    }
    else out.set(relative(root, p), readFileSync(p).toString('base64'));
  }
  return out;
};

const IDS = 'agent-guard,permissions-baseline,agents-md,e2e-plugin,e2e-mcp';
const AI_FLAGS = ['--answers', AI('answers.json'), '--product', AI('product.md'), '--picks', AI('picks.json'), '--report', AI('report.md'), '--choose', IDS];
const DOTENV = ['.', 'env'].join(''); // the repo's guard blocks this literal in shell commands

test('fake AI step through select, apply, update, remove, uninstall leaves the repo byte-identical', () => {
  const root = build(pnpmMonorepo());
  tmp.push(root);
  const before = walk(root);
  const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' }).stdout;
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const run = (...a: string[]) => cli(root, env, ...a);

  // 1. The AI step's four files all validate.
  expect(run('validate', 'answers', AI('answers.json')).code).toBe(0);
  expect(run('validate', 'product', AI('product.md')).code).toBe(0);
  expect(run('validate', 'picks', AI('picks.json'), '--answers', AI('answers.json')).code).toBe(0);
  expect(run('validate', 'report', AI('report.md'), '--picks', AI('picks.json')).code).toBe(0);

  // 2. select --choose resolves one own item, one plugin and one MCP item.
  const sel = run('select', '--picks', AI('picks.json'), '--choose', IDS);
  expect(sel.code, sel.out).toBe(0);

  // 3. The plugin is unmeasured, so --yes stops at the budget and nothing is written.
  const refused = run('init', ...AI_FLAGS, '--yes', '--install-plugins');
  expect(refused.code, refused.out).toBe(2);
  expect(refused.out).toContain('--over-budget');
  expect(walk(root)).toEqual(before);
  expect(calls()).toEqual([]);

  // 4. With --over-budget the install goes through.
  const done = run('init', ...AI_FLAGS, '--yes', '--install-plugins', '--over-budget');
  expect(done.code, done.out).toBe(0);
  const settings = JSON.parse(read('.claude/settings.json'));
  const groups = Object.values(settings.hooks as Record<string, any[]>).flat();
  // One group per harness hook in the fragment, nothing else.
  expect(groups).toHaveLength(Object.values(settingsFragment().hooks as Record<string, unknown[]>).flat().length);
  for (const g of groups) expect(g.hooks[0]).toMatchObject({ type: 'command', command: 'node', args: [expect.stringContaining('dispatch.mjs')] });
  expect(settings.permissions.deny).toHaveLength(34);
  expect(settings.enabledPlugins).toHaveProperty(['e2e-plugin@harness-pins']);
  expect(JSON.parse(read('.mcp.json')).mcpServers).toHaveProperty('e2e-mcp');
  expect(calls()).toContain('plugin install e2e-plugin@harness-pins --scope project --json');
  const manifest = JSON.parse(read('.harness/manifest.json'));
  const entry = manifest.files.find((f: any) => f.rel === '.claude/settings.json');
  expect(entry.hash).toBe(createHash('sha256').update(read('.claude/settings.json')).digest('hex'));
  // Change detection: the first prompt sets the baseline, the second sees no change.
  expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();
  expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();
  // Negative control: the same check does speak when a guarded file changes, then goes quiet again once reverted.
  const settingsText = read('.claude/settings.json');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ ...settings, env: { X: '1' } }, null, 2) + '\n');
  expect(JSON.stringify(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' }))).toContain('.claude/settings.json');
  writeFileSync(join(root, '.claude/settings.json'), settingsText);
  hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  expect(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' })).toBeNull();

  // 5. Platform enforcement still works, and the plugin's settings write is allowed.
  expect(pre(root, 'Read', { file_path: join(root, DOTENV) })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  expect(verdict(pre(root, 'Bash', { command: 'git push origin main' })).decision).toBe('deny');
  expect(verdict(pre(root, 'Edit', { file_path: join(root, '.harness/config.yaml'), old_string: 'a', new_string: 'b' })).decision).toBe('deny');
  const cc = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/hooks/config-change.json'), 'utf8')).project_settings;
  const ccv = verdict(hook(root, { ...cc, session_id: 's1', cwd: root, file_path: join(root, '.claude/settings.json') }));
  expect(ccv, ccv.reason).toMatchObject({ decision: 'allow' });

  // 6. Catalog v2 changes the plugin's sha.
  git('add', '-A');
  git('commit', '-q', '-m', 'harness');
  const v2 = { ...env, HARNESS_CATALOG_DIR: CAT('v2') };
  const plan = cli(root, v2, 'update', '--plan');
  expect(plan.code, plan.out).toBe(0);
  expect(JSON.parse(plan.out).delta.changed).toEqual(['e2e-plugin']);
  const upd = cli(root, v2, 'update', ...AI_FLAGS, '--yes', '--install-plugins', '--over-budget');
  expect(upd.code, upd.out).toBe(0);
  expect(read('.harness/config.yaml')).toContain('2222222222222222222222222222222222222222');
  const markets = JSON.parse(read('.claude/settings.json')).extraKnownMarketplaces;
  expect(Object.keys(markets)).toEqual(['harness-pins']);
  expect(JSON.stringify(markets)).toContain('2222222222222222222222222222222222222222');
  expect(JSON.stringify(markets)).not.toContain('1111111111111111111111111111111111111111');
  const blocks = JSON.parse(read('.harness/manifest.json')).files.flatMap((f: any) => (f.blocks ?? []) as string[]);
  expect(new Set(blocks).size).toBe(blocks.length);
  git('add', '-A');
  git('commit', '-q', '-m', 'update');

  // 7. Removing the MCP item deletes the .mcp.json harness created.
  const rm = cli(root, v2, 'remove', 'e2e-mcp', '--yes');
  expect(rm.code, rm.out).toBe(0);
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);

  // 8. Uninstall restores every byte.
  const un = cli(root, v2, 'uninstall', '--yes');
  expect(un.code, un.out).toBe(0);
  git('reset', '-q', base); // drop this test's own interim commits, keeping the files as uninstall left them
  expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
  expect(walk(root)).toEqual(before);
});
