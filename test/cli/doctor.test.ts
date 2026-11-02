import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { init, type Prompt } from '../../src/cli/init.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const installed = async () => {
  const root = makeRepo(REPO);
  await init(['--yes'], { env: { PATH: bin('npm') }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  return root;
};
const bin = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-bin-'));
  writeFileSync(join(d, name), '#!/bin/sh\n');
  chmodSync(join(d, name), 0o755);
  writeFileSync(join(d, `${name}.cmd`), '@echo off\n'); // what findOnPath looks for on Windows
  return d;
};
const run = (root: string, o: { claude?: string | null; path?: string } = {}) => {
  let out = '';
  const code = doctor([], { root, env: { PATH: o.path ?? '' }, out: (s) => (out += s + '\n') }, { claudeVersion: () => (o.claude === undefined ? MIN_CLAUDE_CODE : o.claude) });
  return { code, out, lines: out.trim().split('\n') };
};
const setConfig = (root: string, edit: (s: string) => string) => {
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
};

test('healthy install: all ok, exit 0', async () => {
  const root = await installed();
  // tdd is on for the vitest repo; init applied the reporter config. npm must be on PATH for the test step.
  const r = run(root, { path: bin('npm') });
  expect(r.out).not.toMatch(/^fix /m);
  expect(r.lines.every((l) => l.startsWith('ok ') || l.startsWith('note '))).toBe(true);
  expect(r.lines.length).toBeGreaterThanOrEqual(7);
  expect(r.code).toBe(0);
});

test('tampered dispatcher: fix line, exit 1', async () => {
  const root = await installed();
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// edited\n');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*dispatch\.mjs.*: .*harness update/m);
  expect(r.code).toBe(1);
});

test('missing step binary named', async () => {
  const root = await installed();
  setConfig(root, (s) => s.replace(/steps:[\s\S]*?\n {2}package_manager/, 'steps:\n    - name: ruff\n      run: [ruff, check, .]\n  package_manager'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*`ruff`/m);
  expect(r.code).toBe(1);
});

test('claude too old or missing', async () => {
  const root = await installed();
  const old = run(root, { claude: '2.0.0', path: bin('npm') });
  expect(old.out).toMatch(/^fix Claude Code 2\.0\.0 .*update Claude Code/m);
  const none = run(root, { claude: null, path: bin('npm') });
  expect(none.out).toMatch(/^ok Claude Code not found: hooks still run when Claude Code is installed/m);
});

test('bad config and unwired event named', async () => {
  const root = await installed();
  setConfig(root, (s) => s + '\nbogus: 1\n');
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  delete s.hooks.Stop;
  writeFileSync(sp, JSON.stringify(s));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*Stop/m);
  expect(r.out).toMatch(/^fix .*bogus/m);
});

test('missing reporter output for a TDD package', async () => {
  const root = await installed();
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*`vitest\.config\.ts`/m);
});

test('not installed: message and exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-none-'));
  mkdirSync(root, { recursive: true });
  const r = run(root);
  expect(r.out).toContain('not installed');
  expect(r.code).toBe(1);
});

test('missing config: restore from git, never loops through update', async () => {
  const root = await installed();
  rmSync(join(root, '.harness/config.yaml'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toContain('fix `.harness/config.yaml` is missing: restore it with git checkout -- .harness/config.yaml, or run harness uninstall and then harness init.');
  expect(r.lines.find((l) => l.includes('config.yaml` is missing'))).not.toContain('harness update');
  expect(r.code).toBe(1);
});

test('custom tdd.paths: missing reporter is still reported', async () => {
  const root = await installed();
  setConfig(root, (s) => s.replace(/paths:[\s\S]*?\n {2}exempt/, 'paths:\n    - lib/**\n  exempt'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^ok vitest reporter output is set up/m);
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");
  expect(run(root, { path: bin('npm') }).out).toMatch(/^fix .*`vitest\.config\.ts`/m);
});

const UNSAFE = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src' } });\n";
test('package left out of TDD: doctor repeats the manual lines, then names the tdd.paths edit once they are there', async () => {
  const root = makeRepo({ ...REPO, 'vitest.config.ts': UNSAFE });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  const a = run(root, { path: bin('npm') });
  expect(a.out).toMatch(/^note TDD is off for the root package because its test config could not be edited safely: do this by hand: .*outputFile: \{ json: '\.harness\/state\/test-results\/root\.json' \}.*then set checks\.tdd to true and add `src\/\*\*` to tdd\.paths in \.harness\/config\.yaml$/m);
  expect(a.code).toBe(0); // a note, not a problem
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src', reporters: ['default', 'json'], outputFile: { json: '.harness/state/test-results/root.json' } } });\n");
  const b = run(root, { path: bin('npm') });
  expect(b.out).toMatch(/^note TDD is off for the root package: set checks\.tdd to true and add `src\/\*\*` to tdd\.paths in \.harness\/config\.yaml$/m);
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toContain("root: './src'"); // never rewritten
  setConfig(root, (s) => s.replace('tdd: false', 'tdd: true').replace(/paths: \[\]/, 'paths:\n    - src/**'));
  const c = run(root, { path: bin('npm') });
  expect(c.out).not.toMatch(/TDD is off/);
  expect(c.out).toMatch(/^ok vitest reporter output is set up for the root package$/m);
});

test('jest repo: doctor checks the installed reporter against the manifest', async () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }), 'package-lock.json': '{}\n' });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok Jest reporter matches the manifest$/m);
  writeFileSync(join(root, '.harness/hooks/jest-results.cjs'), '// edited\n');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.harness\/hooks\/jest-results\.cjs` is not the installed version: run harness update to restore it$/m);
  expect(r.code).toBe(1);
});

test('vitest without a coverage provider: doctor gives the install hint, then the steps once it is installed', async () => {
  const root = makeRepo({ ...REPO, 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }) });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).not.toContain('enabled: true');
  const a = run(root, { path: bin('npm') });
  expect(a.out).toMatch(/^note the coverage gate is off for the root package: install @vitest\/coverage-v8 to turn on the coverage gate$/m);
  expect(a.out).not.toMatch(/problems? found/);
  expect(a.code).toBe(0);
  mkdirSync(join(root, 'node_modules/@vitest/coverage-v8'), { recursive: true });
  expect(run(root, { path: bin('npm') }).out).toMatch(/^note the coverage gate is off for the root package: run harness update to turn on Vitest coverage, then remove `src\/\*\*` from tdd\.coverage_skip in \.harness\/config\.yaml$/m);
});

test('CRLF checkout of the dispatcher still matches the manifest', async () => {
  const root = await installed();
  const p = join(root, '.harness/hooks/dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok dispatcher matches the manifest$/m);
});

test('package with no vitest config file: the note says so and gives the lines to create it', async () => {
  const { 'vitest.config.ts': _, ...noCfg } = REPO;
  const root = makeRepo(noCfg);
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^note TDD is off for the root package because it has no Vitest\/Jest config file: do this by hand: Create `vitest\.config\.ts` with:/m);
  expect(r.code).toBe(0);
});

test('doctor notes that the hooks may see a different PATH than this terminal', async () => {
  const r = run(await installed(), { path: bin('npm') });
  expect(r.out).toMatch(/^note Stop steps were checked against this terminal's PATH: Claude Code's hooks may see a different one \(for example when Claude Code starts from the GUI\); if Stop warns that a tool is not on its PATH, make the tool available there$/m);
  expect(r.code).toBe(0);
});
