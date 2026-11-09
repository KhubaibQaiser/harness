import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { init } from '../../src/cli/init.js';
import type { Prompt } from '../../src/cli/prompt.js';
import { rules } from '../../src/cli/rules.js';
import { uninstall } from '../../src/cli/uninstall.js';
import type { Exec } from '../../src/core/exec.js';
import { makeRepo } from '../install/helpers.js';

const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('no network in tests'); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { env: { HARNESS_PLAIN_INIT: '1' }, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const HARNESS_FILE = '.harness/eslint/harness.config.mjs';
const STOP_LINE = (n: number) => `The stop gate's lint and typecheck steps will fail until these ${n} violations are fixed. CI fails too if it runs them.`;
const ESLINT_CFG = "import js from '@eslint/js';\n\nexport default [\n  js.configs.recommended,\n];\n";
const pkg = JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, dependencies: { next: '^15.0.0', react: '^19.0.0' }, devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0', eslint: '^9.0.0' } }, null, 2) + '\n';
const NEXT = (eslint: Record<string, string>) => ({
  'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'AGENTS.md': '# Mine\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  'app/page.tsx': 'export default function Page() { return null; }\n',
  ...eslint,
});
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const prompt = (answer: string | Error = ''): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async confirm(q) { asked.push(q); return false; },
    async edit(l) { asked.push(l); if (answer instanceof Error) throw answer; return answer; },
  };
};
/** A fake eslint in the repo's node_modules (resolveBin needs it), answered by `exec`. */
const fakeEslint = (root: string) => {
  const dir = join(root, 'node_modules', 'eslint');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'eslint', version: '9.0.0', bin: { eslint: 'bin/eslint.js' } }));
  writeFileSync(join(dir, 'bin', 'eslint.js'), '');
};
const report = (ids: string[]) => JSON.stringify([{ filePath: 'a.ts', messages: ids.map((ruleId) => ({ ruleId })) }]);
const execWith = (r: ReturnType<Exec>): Exec => (_cmd, [bin = '']) => (bin.endsWith('eslint.js') ? r : { status: 0, stdout: '' });

async function installed(eslint: Record<string, string>) {
  const root = makeRepo(NEXT(eslint));
  const original = Object.fromEntries(Object.keys(eslint).map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  await init(['--yes'], { ...base, root, out: () => {}, prompt: prompt() });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'harness');
  fakeEslint(root);
  return { root, original };
}
const run = async (root: string, args: string[], p: Prompt, exec: Exec, tty = true) => {
  const lines: string[] = [];
  const code = await rules(args, { root, env: {}, tty, out: (s) => lines.push(s), prompt: p, exec });
  return { code, out: lines.join('\n') };
};
const snapshot = (root: string) => git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored=no') + git(root, 'diff');

test('preview shows counts, safe rules and the stop-gate line; --apply + yes writes both files; uninstall restores the repo', async () => {
  const { root, original } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const exec = execWith({ status: 1, stdout: report(['max-depth', 'max-depth', 'no-empty', 'other/x']) });

  const preview = await run(root, [], prompt(), exec);
  expect(preview.code).toBe(0);
  const lines = preview.out.split('\n');
  expect(lines.indexOf('  max-depth: 2')).toBeLessThan(lines.indexOf('  no-empty: 1'));
  expect(preview.out).toMatch(/Safe to add now \(0 violations\):[\s\S]*max-params/);
  expect(preview.out).toContain(STOP_LINE(3));
  expect(preview.out).toMatch(/needs `eslint-plugin-react-hooks`/);
  expect(preview.out).toContain('No lint equivalent:');
  expect(preview.out).toContain(`+++ b/${HARNESS_FILE}`);
  expect(preview.out).toContain('+  ...harnessRules,');
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
  expect(snapshot(root)).toBe('');

  const p = prompt('yes');
  const applied = await run(root, ['--apply'], p, exec);
  expect(applied.code).toBe(0);
  expect(p.asked).toHaveLength(1);
  expect(readFileSync(join(root, HARNESS_FILE), 'utf8')).toContain('"max-depth"');
  expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  const manifest = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string }[] };
  expect(manifest.files.map((f) => f.rel)).toEqual(expect.arrayContaining([HARNESS_FILE, 'eslint.config.mjs']));

  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'rules');
  const un = await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: prompt() });
  expect(un).toBe(0);
  expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(original['eslint.config.mjs']);
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test.each([
  ['a legacy .eslintrc.json', { '.eslintrc.json': '{ "extends": "next" }\n' }],
  ['no ESLint config', {}],
])('--apply on %s is refused with manual steps and nothing is written', async (_n, eslint) => {
  const { root } = await installed(eslint);
  const before = snapshot(root);
  const p = prompt('yes');
  const r = await run(root, ['--apply'], p, execWith({ status: 0, stdout: '[]' }));
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/eslint\.config\.mjs/);
  expect(r.out).toMatch(/needs `eslint-plugin-react-hooks`/);
  expect(r.out).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  expect(p.asked).toEqual([]);
  expect(snapshot(root)).toBe(before);
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
});

test('an ESLint timeout shows the gate impact as unknown, never 0', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const r = await run(root, [], prompt(), execWith({ status: 1, stdout: '', timedOut: true }));
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/unknown/i);
  expect(r.out).toContain('The effect on the stop gate is unknown.');
  expect(r.out).not.toMatch(/: 0\b|\b0 violations/);
  expect(r.out).not.toContain('Safe to add now');
});

test.each([['y'], ['no'], ['YES'], [''], [new Error('input closed before an answer')]])('answer %s writes nothing', async (answer) => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const before = snapshot(root);
  const r = await run(root, ['--apply'], prompt(answer), execWith({ status: 0, stdout: '[]' }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('Nothing was written.');
  expect(snapshot(root)).toBe(before);
});

test('--apply without a terminal and bad flags are refused', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const exec = execWith({ status: 0, stdout: '[]' });
  expect((await run(root, ['--apply'], prompt('yes'), exec, false)).code).toBe(2);
  expect((await run(root, ['--yes'], prompt('yes'), exec)).code).toBe(2);
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
});
