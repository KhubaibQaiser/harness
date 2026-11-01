import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const installed = async () => {
  const root = makeRepo(REPO);
  await init(['--yes'], { env: {}, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  return root;
};
const bin = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-bin-'));
  writeFileSync(join(d, name), '#!/bin/sh\n');
  chmodSync(join(d, name), 0o755);
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
  expect(r.lines.every((l) => l.startsWith('ok '))).toBe(true);
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
