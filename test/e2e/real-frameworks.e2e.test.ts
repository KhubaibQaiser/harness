import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { readResults } from '../../src/checks/tdd/results.js';
import { makeRepo } from '../install/helpers.js';
import { PREFIX, cleanup } from './fixtures.js';

// Installs the real frameworks from npm, so it only runs in CI (HARNESS_E2E_REAL=1). The first real run is on CI.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const VITEST = '5.0.5';
const VITE = '8.3.5'; // vitest's required peer
const JEST = '30.0.0';
const PRETTIER = '3.9.4';
const ESLINT = '9.39.4';

const made: string[] = [];
afterEach(() => void made.splice(0).forEach(cleanup));

const run = (cwd: string, cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: r.stdout + r.stderr };
};
/** Asserts exit 0, showing the command's output when it is not. */
const ok = (r: { code: number | null; out: string }) => expect(r.code, r.out).toBe(0);
// --legacy-peer-deps: npm 10's arborist crashes ("Cannot read properties of null (reading 'edgesOut')") walking
// vitest 5.0.5's optional browser peers once a newer vitest (5.1.0) exists; legacy mode skips that walk. It also skips
// auto-installing required peers, so the Vitest fixtures list vite themselves.
const npmInstall = (root: string) => ok(run(root, 'npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps']));

const FIXTURES = {
  vitest: {
    'package.json': JSON.stringify({ name: 'real-vitest', scripts: { test: 'vitest run' }, devDependencies: { vitest: VITEST, '@vitest/coverage-v8': VITEST, vite: VITE } }, null, 2) + '\n',
    'vitest.config.js': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
    'src/a.js': 'export const a = () => 1;\n',
    'src/a.test.js': "import { expect, test } from 'vitest';\nimport { a } from './a.js';\ntest('a', () => expect(a()).toBe(1));\n",
  },
  jest: {
    'package.json': JSON.stringify({ name: 'real-jest', scripts: { test: 'jest' }, devDependencies: { jest: JEST } }, null, 2) + '\n',
    'jest.config.js': 'module.exports = {};\n',
    'src/a.js': 'exports.a = () => 1;\n',
    'src/a.test.js': "const { a } = require('./a');\ntest('a', () => expect(a()).toBe(1));\n",
  },
};

describe.skipIf(process.env.HARNESS_E2E_REAL !== '1')('real frameworks', () => {
  test.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])('%s: init writes config the framework honours', (name) => {
    const root = makeRepo({ ...FIXTURES[name], '.gitignore': 'node_modules\n' }, { prefix: PREFIX });
    made.push(root);
    npmInstall(root);
    run(root, 'git', ['add', '-A']);
    ok(run(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'deps']));

    const init = run(root, 'node', [CLI, 'init', '--yes']);
    expect(init.code, init.out).toBe(0);
    const t = run(root, 'npm', ['test']);
    expect(t.code, t.out).toBe(0);
    expect(t.out).not.toContain('Haste module naming collision'); // .harness/backup holds a copy of package.json

    const dir = join(root, '.harness/results');
    expect(existsSync(join(dir, 'root.json'))).toBe(true);
    expect(readResults(root, dir)).toMatchObject([{ file: 'src/a.test.js', status: 'passed', tests: [{ status: 'passed' }] }]);
    expect(existsSync(join(root, 'coverage/coverage-final.json'))).toBe(true);
  }, 300_000);

  // C2: a repo that passes `prettier --check` and ESLint 9 (flat config, recommended rules) still passes after init.
  test('prettier and eslint stay clean after init', () => {
    const pj = { name: 'real-format', type: 'module', scripts: { test: 'vitest run', 'format:check': 'prettier --check .', lint: 'eslint .' }, devDependencies: { vitest: VITEST, '@vitest/coverage-v8': VITEST, vite: VITE, prettier: PRETTIER, eslint: ESLINT, '@eslint/js': ESLINT } };
    const root = makeRepo({
      'package.json': JSON.stringify(pj, null, 2) + '\n',
      'vitest.config.js': 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  plugins: [],\n});\n',
      'eslint.config.js': 'import js from "@eslint/js";\n\nexport default [js.configs.recommended];\n',
      'src/a.js': 'export const a = () => 1;\n',
      '.gitignore': 'node_modules\n',
    }, { prefix: PREFIX });
    made.push(root);
    npmInstall(root);
    const check = () => [run(root, 'npx', ['prettier', '--check', '.']), run(root, 'npx', ['eslint', '.'])];
    for (const r of check()) expect(r.code, r.out).toBe(0);
    run(root, 'git', ['add', '-A']);
    ok(run(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'deps']));

    const init = run(root, 'node', [CLI, 'init', '--yes']);
    expect(init.code, init.out).toBe(0);
    expect(init.out).not.toContain('Do these by hand');
    for (const r of check()) expect(r.code, r.out).toBe(0);
  }, 300_000);

  // N1: inline layouts overflow Prettier's width; init runs the repo's Prettier, and uninstall gives the original back.
  test('one-line Vitest test object and globalIgnores([...]) ESLint config: clean after init, original after uninstall', () => {
    const pj = { name: 'real-format-inline', type: 'module', scripts: { test: 'vitest run', 'format:check': 'prettier --check .', lint: 'eslint .' }, devDependencies: { vitest: VITEST, '@vitest/coverage-v8': VITEST, vite: VITE, prettier: PRETTIER, eslint: ESLINT, '@eslint/js': ESLINT } };
    const files = {
      'package.json': JSON.stringify(pj, null, 2) + '\n',
      'vitest.config.js': 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: { globals: true },\n});\n',
      'eslint.config.js': 'import js from "@eslint/js";\nimport { defineConfig, globalIgnores } from "eslint/config";\n\nexport default defineConfig([globalIgnores(["dist/"]), js.configs.recommended]);\n',
      'src/a.js': 'export const a = () => 1;\n',
      '.gitignore': 'node_modules\n',
    };
    const root = makeRepo(files, { prefix: PREFIX });
    made.push(root);
    npmInstall(root);
    const check = () => [run(root, 'npx', ['prettier', '--check', '.']), run(root, 'npx', ['eslint', '.'])];
    for (const r of check()) expect(r.code, r.out).toBe(0);
    const commit = (m: string) => {
      run(root, 'git', ['add', '-A']);
      ok(run(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', m]));
    };
    commit('deps');
    const init = run(root, 'node', [CLI, 'init', '--yes']);
    expect(init.code, init.out).toBe(0);
    expect(init.out).not.toContain('Prettier could not format');
    for (const r of check()) expect(r.code, r.out).toBe(0);
    commit('harness');
    rmSync(join(root, '.harness/backup'), { recursive: true, force: true }); // as on a teammate's clone
    ok(run(root, 'node', [CLI, 'uninstall', '--yes']));
    for (const f of ['vitest.config.js', 'eslint.config.js'] as const) expect(readFileSync(join(root, f), 'utf8')).toBe(files[f]);
  }, 300_000);
});
