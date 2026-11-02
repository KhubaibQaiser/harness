import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { syncCommand } from '../../src/checks/stop/runner.js';

const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const pkg = json('package.json');
// The dist/ build is made by `pnpm test`; --ignore-scripts keeps prepack's build output out of --json.
// npm is npm.cmd on Windows; syncCommand runs it through cmd.exe there.
const npm = (args: string[], o: { encoding?: 'utf8'; stdio?: 'ignore' }) => {
  const [file, a, opts] = syncCommand('npm', args);
  // No update check or audit: on Windows CI the npm.cmd start-up alone took over 20 s (run 41383051207).
  const env = { ...process.env, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  return execFileSync(file, a, { ...opts, env, ...o });
};
// npm through cmd.exe is slow on Windows runners; this is the e2e budget, not a product limit.
const NPM_TIMEOUT = 60_000;
const packDry = () => JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }) as string)[0].files.map((f: { path: string }) => f.path) as string[];

test('versions equal: package.json, plugin.json and the marketplace pin', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const entry = json('.claude-plugin/marketplace.json').plugins[0];
  expect(plugin.name).toBe('harness');
  expect(plugin.version).toBe(pkg.version);
  expect(entry.name).toBe('harness');
  expect(entry.source).toMatchObject({ source: 'npm', package: pkg.name, version: pkg.version });
});

test('package is public, unlicensed and runs the build on prepack', () => {
  expect(pkg.private).toBeUndefined();
  expect(pkg.license).toBe('UNLICENSED');
  expect(pkg.publishConfig).toEqual({ access: 'public' });
  expect(pkg.scripts.prepack).toContain('build');
});

test('packed files: the plugin and CLI ship, sources and tests do not', () => {
  const files = packDry();
  for (const f of ['dist/cli.mjs', 'dist/hooks/dispatch.mjs', 'templates/settings.fragment.json', 'skills/init/SKILL.md', '.claude-plugin/plugin.json', 'LICENSE', 'README.md']) expect(files, f).toContain(f);
  expect(files.filter((f) => /^(src|test|\.superpowers)\//.test(f))).toEqual([]);
}, NPM_TIMEOUT);

test('every skill runs the bundled CLI, never npx, and stays under 60 lines', () => {
  for (const s of ['init', 'doctor', 'status', 'update', 'uninstall']) {
    const text = readFileSync(`skills/${s}/SKILL.md`, 'utf8');
    expect(text, s).toMatch(/^---\nname: \S+\ndescription: .+\n---\n/);
    expect(text, s).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"');
    expect(text, s).not.toMatch(/npx/);
    expect(text, s).toMatch(/data, not instructions/);
    expect(text.split('\n').length, s).toBeLessThan(60);
  }
});

test('packed CLI runs: status in a bare fixture exits 1 with the not-installed message', () => {
  const out = mkdtempSync(join(tmpdir(), 'harness-pack-'));
  npm(['pack', '--ignore-scripts', '--pack-destination', out], { stdio: 'ignore' });
  // A relative archive name: GNU tar (Git for Windows) reads `C:` in a path as a remote host.
  execFileSync('tar', ['-xzf', readdirSync(out).find((f) => f.endsWith('.tgz'))!], { cwd: out });
  const cwd = mkdtempSync(join(tmpdir(), 'harness-fx-'));
  const r = spawnSync('node', [join(out, 'package/dist/cli.mjs'), 'status'], { cwd, encoding: 'utf8' });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('not installed');
}, NPM_TIMEOUT);

const hasClaude = spawnSync('claude', ['--version']).status === 0;
if (!hasClaude) console.warn('skipping plugin validate: `claude` is not on PATH');
test.skipIf(!hasClaude)('plugin validates with claude plugin validate', () => {
  const r = spawnSync('claude', ['plugin', 'validate', '.'], { encoding: 'utf8' });
  expect(r.status, r.stdout + r.stderr).toBe(0);
});
