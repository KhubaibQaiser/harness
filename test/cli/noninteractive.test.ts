import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { update } from '../../src/cli/update.js';
import { makeRepo } from '../install/helpers.js';

const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
};
const MSG = 'No terminal to answer prompts. Run with --yes (add --config <file> for init), or use --dry-run to preview.';
const prompt = (): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return false; }, async edit(_l, v) { return v; } };
};
const env = (root: string, p: Prompt) => ({ env: {}, root, tty: false, out: (s: string) => lines.push(s), prompt: p, version: '1.0.0', templatesDir: join(process.cwd(), 'templates'), distDir: join(process.cwd(), 'dist') });
let lines: string[] = [];

test('dry-run never prompts', async () => {
  lines = [];
  const p = prompt();
  expect(await init(['--dry-run'], { ...env(makeRepo(REPO), p), tty: true })).toBe(0);
  expect(p.asked).toEqual([]);
  expect(lines.join('\n')).toContain('Dry run: nothing was written.');
});

test('non-TTY without --yes exits 2 with the message (init, uninstall, update)', async () => {
  const root = makeRepo(REPO);
  for (const [name, run] of [
    ['init', () => init([], env(root, prompt()))],
    ['uninstall', () => uninstall([], env(root, prompt()))],
    ['update', () => update([], env(root, prompt()))],
  ] as const) {
    lines = [];
    expect(await run(), name).toBe(2);
    expect(lines, name).toEqual([MSG]);
  }
});

test('built CLI: init --dry-run with stdin closed exits 0 and settles', () => {
  const root = makeRepo(REPO);
  const r = spawnSync('node', [join(process.cwd(), 'dist/cli.mjs'), 'init', '--dry-run'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout + r.stderr).not.toMatch(/unsettled/i);
  expect(r.stdout).toContain('Dry run: nothing was written.');
});

test('built CLI: init without --yes on a non-TTY refuses with exit 2', () => {
  const r = spawnSync('node', [join(process.cwd(), 'dist/cli.mjs'), 'init'], { cwd: makeRepo(REPO), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(r.status).toBe(2);
  expect(r.stdout).toContain(MSG);
  expect(r.stderr).not.toMatch(/unsettled/i);
});
