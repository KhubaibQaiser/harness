import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { status } from '../../src/cli/status.js';
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
