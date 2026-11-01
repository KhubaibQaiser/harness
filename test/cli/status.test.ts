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
  });
  expect(r.out).toMatch(/tdd: on/);
  expect(r.out).toMatch(/guard: on/);
  let out = '';
  expect(status([], { root: makeRepo({ a: 'b' }), env: {}, out: (s) => (out += s) })).toBe(1);
  expect(out).toContain('not installed');
});
