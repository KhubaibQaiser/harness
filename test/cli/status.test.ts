import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { status } from '../../src/cli/status.js';
import { appendEvent } from '../../src/core/events.js';
import { writeHookEnv } from '../../src/core/hook-env.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const go = async (files: Record<string, string>) => {
  const root = makeRepo(files);
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  let out = '';
  const code = status([], { root, env: {}, out: (s) => (out += s + '\n') });
  return { code, out };
};

test('status shows off reason for python repo', async () => {
  const r = await go({ 'pyproject.toml': '[tool.pytest]\n', 'tests/test_a.py': 'def test_a(): pass\n' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/tdd: off - TDD and coverage support JS\/TS \(Vitest or Jest\) only in this beta\./);
  expect(r.out).not.toContain('TDD gate');
  expect(r.out).toContain('No harness events in the last 1 days.');
});

test('status shows gates on and not-installed', async () => {
  const r = await go({
    'package.json': JSON.stringify({ name: 'a', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }),
    'package-lock.json': '{}',
    'vitest.config.ts': 'export default { test: {} };\n',
  });
  expect(r.out).toMatch(/tdd: on/);
  expect(r.out).toMatch(/guard: on/);
  let out = '';
  expect(status([], { root: makeRepo({ a: 'b' }), env: {}, out: (s) => (out += s) })).toBe(1);
  expect(out).toContain('not installed');
});

test('status prints config warnings before the gates', async () => {
  const root = makeRepo({ a: 'b' });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  writeFileSync(join(root, '.harness/config.yaml'), 'bogus: 1\n');
  let out = '';
  status([], { root, env: {}, out: (s) => (out += s + '\n') });
  expect(out).toMatch(/^warn config: unknown key "bogus" ignored$/m);
  expect(out.indexOf('warn ')).toBeLessThan(out.indexOf('Gates'));
});

const UNSAFE = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src' } });\n";
const pkg = (name: string) => JSON.stringify({ name, scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } });

test('status: TDD off for a package whose test config could not be edited safely', async () => {
  const r = await go({ 'package.json': pkg('u'), 'package-lock.json': '{}', 'vitest.config.ts': UNSAFE });
  const why = 'TDD off for the root package because its test config could not be edited safely; add the printed lines, then add `src/**` to tdd.paths.';
  expect(r.out).toContain(`tdd: off - ${why}`);
  expect(r.out).toContain(`coverage: off - ${why}`);
});

test('status: one unsafe package in a monorepo is named while TDD stays on', async () => {
  const r = await go({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'package-lock.json': '{}',
    'packages/a/package.json': pkg('a'),
    'packages/a/vitest.config.ts': "export default { test: {} };\n",
    'packages/b/package.json': pkg('b'),
    'packages/b/vitest.config.ts': UNSAFE,
  });
  expect(r.out).toMatch(/tdd: on/);
  expect(r.out).toContain('TDD off for `packages/b` because its test config could not be edited safely; add the printed lines, then add `packages/b/src/**` to tdd.paths.');
});

test('status: coverage gate off for a vitest package without a coverage provider, with the install hint', async () => {
  const r = await go({ 'package.json': pkg('v'), 'package-lock.json': '{}', 'vitest.config.ts': 'export default { test: {} };\n' });
  expect(r.out).toMatch(/tdd: on/);
  expect(r.out).toContain('Coverage gate off for the root package: install @vitest/coverage-v8 to turn on the coverage gate.');
});

test('status: a vitest package with no config file says so', async () => {
  const r = await go({ 'package.json': pkg('n'), 'package-lock.json': '{}' });
  expect(r.out).toContain('tdd: off - TDD off for the root package because it has no Vitest/Jest config file; create one with the printed lines, then add `src/**` to tdd.paths.');
});

test('status names a Jest package whose coverage the gate cannot read', async () => {
  const r = await go({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' }, jest: { coverageDirectory: 'reports' } }), 'package-lock.json': '{}\n' });
  expect(r.out).toContain('  Coverage gate off for the root package: `package.json` "jest" sets `coverageDirectory`');
});

const installedAt = async () => {
  const root = makeRepo({ a: 'b' });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  return root;
};
const show = (root: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => {
  let out = '';
  status([], { root, env, out: (s) => (out += s + '\n') }, { platform });
  return out;
};

test('status shows the sandbox mode per platform', async () => {
  const root = await installedAt();
  expect(show(root, 'darwin')).toMatch(/^Enforcement: sandbox unattended \(macOS: available\)$/m);
  expect(show(root, 'linux')).toMatch(/^Enforcement: sandbox unattended \(Linux: available\)$/m);
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace('sandbox: unattended', 'sandbox: always'));
  expect(show(root, 'linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toMatch(/^Enforcement: sandbox always \(WSL2: available\)$/m);
  expect(show(root, 'win32')).toMatch(/^Enforcement: sandbox always \(native Windows: not available\)$/m);
});

test('status shows the hook failure line', async () => {
  const out = show(await installedAt(), 'darwin');
  expect(out).toMatch(/^Hook failure: blocks tool calls, prompts and settings changes; the Stop gate fails open$/m);
  expect(out.indexOf('Hook failure')).toBeGreaterThan(out.indexOf('Gates'));
  expect(out.indexOf('Hook failure')).toBeLessThan(out.indexOf('Last day'));
});

test('status claims blocking hooks only when the blocking groups are the installed ones', async () => {
  const root = await installedAt();
  const p = join(root, '.claude/settings.json');
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('"onFailure": "block"', '"onFailure": "allow"').replaceAll('"onFailure":"block"', '"onFailure":"allow"'));
  const out = show(root, 'darwin');
  expect(out).not.toContain('Hook failure: blocks');
  expect(out).toMatch(/^Hook failure: the harness hooks in `\.claude\/settings\.json` differ from the ones harness installs; run harness doctor$/m);
});

test('status names a platform it has no sandbox facts for', async () => {
  expect(show(await installedAt(), 'freebsd')).toMatch(/^Enforcement: sandbox unattended \(freebsd: not checked\)$/m);
});

test('status shows the hook Node or not recorded yet', async () => {
  const root = await installedAt();
  expect(show(root, 'darwin')).toMatch(/^Hooks run Node: not recorded yet$/m);
  writeHookEnv(root, new Date('2026-11-02T10:00:00.000Z'));
  expect(show(root, 'darwin')).toContain(`Hooks run Node ${process.version} (2026-11-02T10:00:00.000Z)\n`);
});

test('status shows the last blocked settings change', async () => {
  const root = await installedAt();
  expect(show(root, 'darwin')).not.toContain('Last blocked settings change');
  appendEvent(root, { ts: '2026-11-02T00:00:00.000Z', session: 's', check: 'config-change', decision: 'config-change-blocked', reason: '.claude/settings.json: hooks' });
  expect(show(root, 'darwin')).toMatch(/^Last blocked settings change: 2026-11-02T00:00:00\.000Z \(\.claude\/settings\.json: hooks\)$/m);
});
