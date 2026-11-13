import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { syncCommand } from '../../src/checks/stop/runner.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { measureSelection } from '../../src/budget/measure.js';
import { footprint } from '../../src/install/footprint.js';
import { parse } from 'yaml';

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
  expect(pkg.license).toBe('Apache-2.0');
  expect(pkg.publishConfig).toEqual({ access: 'public' });
  expect(pkg.scripts.prepack).toContain('build');
});

test('packed files: the plugin and CLI ship, sources and tests do not', () => {
  const files = packDry();
  for (const f of ['dist/cli.mjs', 'dist/hooks/dispatch.mjs', 'templates/settings.fragment.json', 'catalog/catalog.yaml', 'skills/init/SKILL.md', '.claude-plugin/plugin.json', 'LICENSE', 'README.md']) expect(files, f).toContain(f);
  expect(files.filter((f) => /^(src|test|\.superpowers)\//.test(f))).toEqual([]);
}, NPM_TIMEOUT);

test('every skill runs the bundled CLI, never npx, and stays under 60 lines', () => {
  for (const s of readdirSync('skills')) {
    const text = readFileSync(`skills/${s}/SKILL.md`, 'utf8');
    expect(text, s).toMatch(/^---\nname: \S+\ndescription: .+\n(disable-model-invocation: true\n)?---\n/);
    expect(text, s).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"');
    expect(text, s).not.toMatch(/npx/);
    expect(text, s).toMatch(/data, not instructions/);
    expect(text.split('\n').length, s).toBeLessThan(60);
  }
});

const CLI = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"';
test('init skill holds every CLI line', () => {
  const t = readFileSync('skills/init/SKILL.md', 'utf8');
  for (const c of ['scan', 'validate product', 'validate answers', 'catalog', 'validate picks', 'validate report', 'select', 'init', 'git branch', 'git commit', 'git push', 'git pr']) {
    expect(t.split('\n').some((l) => l.includes(`${CLI} ${c}`)), c).toBe(true);
  }
  expect(t).toContain('--over-budget');
  expect(t).toContain('/harness:sync');
  expect(t).toContain('Could not install');
  expect(t).toContain("Claude Code's sandbox blocks harness's own files");
  expect(t).toContain(`${CLI} guide review-rubric`);
  expect(t).toContain('(recommended)');
});

test('side files hold no commands', () => {
  for (const f of ['interview', 'recommend']) expect(readFileSync(`skills/init/${f}.md`, 'utf8'), f).not.toContain('dist/cli.mjs');
});

test('interview.md says never to read dotenv files or unpointed files', () => {
  const t = readFileSync('skills/init/interview.md', 'utf8');
  expect(t).toMatch(/never read[^\n]*\.env/i);
  expect(t).toMatch(/\.harnessignore/);
  expect(t).toMatch(/only (the )?files? the (user|person) (points|pointed)/i);
  expect(t).toMatch(/names only/i);
});

test('recommend.md calls harness:staff-reviewer, passes the rubric text and prefers on-demand items', () => {
  const t = readFileSync('skills/init/recommend.md', 'utf8');
  expect(t).toContain('harness:staff-reviewer');
  expect(t).toContain('Mode: repo audit');
  expect(t).toMatch(/rubric text/);
  expect(t).toMatch(/on demand/i);
  expect(t).toMatch(/cost\.context/);
  expect(t).toMatch(/Artifactory or Nexus/);
});

test('plugin.json registers the reviewer only, and its path exists', () => {
  const p = json('.claude-plugin/plugin.json');
  expect(p.agents).toEqual(['./templates/agents/staff-reviewer.md']);
  expect(p.skills).toBeUndefined();
  expect(existsSync(p.agents[0])).toBe(true);
});

test('harness-plugin context stays under 500 tokens (estimate)', async () => {
  const r = await measureSelection([], loadCatalog().catalog, { templates: 'templates', plugin: '.' });
  expect(r.entries.find((e) => e.id === 'harness-plugin')!.tokens).toBeLessThan(500);
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

test('slash-only skills carry disable-model-invocation; doctor and status stay visible', () => {
  const off = (s: string) => /^disable-model-invocation: true$/m.test(readFileSync(`skills/${s}/SKILL.md`, 'utf8'));
  for (const s of ['init', 'update', 'uninstall', 'add', 'sync', 'vet', 'preset']) expect(off(s), s).toBe(true);
  for (const s of ['doctor', 'status', 'remember']) expect(off(s), s).toBe(false);
});

// Always-loaded tokens of the default install (plugin + legacy own items), measured. Raise only in a reviewed PR.
// 658 (team decisions, 2026-11-10): 553 + 71 for the AGENTS.md pointer and protected line + 34 for the remember skill.
// 688 (M2a PR B, 2026-11-13): + 30 for the review-judge agent's name and description, installed with staff-reviewer.
const HARNESS_FOOTPRINT = 688;
test('the default install footprint stays within HARNESS_FOOTPRINT', () => {
  expect(footprint({ templates: 'templates', plugin: '.' }, loadCatalog().catalog)).toBeLessThanOrEqual(HARNESS_FOOTPRINT);
});

test('every skill and agent frontmatter parses as YAML', () => {
  const files = [...readdirSync('skills').map((s) => `skills/${s}/SKILL.md`), ...readdirSync('templates/agents').map((a) => `templates/agents/${a}`)];
  for (const f of files) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(f, 'utf8'))?.[1];
    expect(fm, f).toBeDefined();
    expect(() => parse(fm!), f).not.toThrow();
  }
});
