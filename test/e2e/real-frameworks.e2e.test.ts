import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { readResults } from '../../src/checks/tdd/results.js';
import { makeRepo } from '../install/helpers.js';
import { PREFIX, cleanup } from './fixtures.js';

// Installs the real frameworks from npm, so it only runs in CI (HARNESS_E2E_REAL=1). The first real run is on CI.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const VITEST = '5.0.5';
const JEST = '30.0.0';

const made: string[] = [];
afterEach(() => void made.splice(0).forEach(cleanup));

const run = (cwd: string, cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: r.stdout + r.stderr };
};

const FIXTURES = {
  vitest: {
    'package.json': JSON.stringify({ name: 'real-vitest', scripts: { test: 'vitest run' }, devDependencies: { vitest: VITEST, '@vitest/coverage-v8': VITEST } }, null, 2) + '\n',
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
    expect(run(root, 'npm', ['install', '--no-audit', '--no-fund']).code).toBe(0);
    run(root, 'git', ['add', '-A']);
    expect(run(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'deps']).code).toBe(0);

    const init = run(root, 'node', [CLI, 'init', '--yes']);
    expect(init.code, init.out).toBe(0);
    const t = run(root, 'npm', ['test']);
    expect(t.code, t.out).toBe(0);

    const dir = join(root, '.harness/state/test-results');
    expect(existsSync(join(dir, 'root.json'))).toBe(true);
    expect(readResults(root, dir).length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(root, 'coverage/coverage-final.json'))).toBe(true);
  }, 300_000);
});
