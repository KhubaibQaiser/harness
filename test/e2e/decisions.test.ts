import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, expect, test } from 'vitest';
import { build, cleanup, npmVitest } from './fixtures.js';

// Team decisions spec 4.4 (C7): uninstall restores every harness-written file and leaves docs/decisions/ alone.
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'h-e2e-home-'));
// Attended with no TTY, so `--yes` is the approval; HOME is a temp dir, so the real ~/.claude is never touched.
const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_PLAIN_INIT: '1', HOME, USERPROFILE: HOME };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX']) delete env[k];

const made: string[] = [];
afterEach(() => void made.splice(0).forEach(cleanup));
afterAll(() => cleanup(HOME));
const repo = () => {
  const root = build(npmVitest());
  made.push(root);
  return root;
};
const cli = (root: string, ...args: string[]) => {
  const r = spawnSync('node', [CLI, ...args], { cwd: root, encoding: 'utf8', env });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  return r.stdout;
};
const walk = (root: string, dir = root, out = new Map<string, string>()): Map<string, string> => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else out.set(relative(root, p), readFileSync(p).toString('base64'));
  }
  return out;
};

test('init, remember add twice, retire, uninstall: byte-identical except the two decision files', () => {
  const root = repo();
  const before = walk(root);
  cli(root, 'init', '--yes');
  cli(root, 'remember', 'add', '--title', 'Keep a small', '--rule', 'Export only constants from a.ts.', '--path', 'src/a.ts', '--yes');
  cli(root, 'remember', 'add', '--title', 'Name exports', '--rule', 'Name every export.', '--path', 'src/**', '--yes');
  expect(readdirSync(join(root, '.claude/rules')).filter((f) => f.startsWith('harness-decision-'))).toHaveLength(2);
  const [first] = readdirSync(join(root, 'docs/decisions')).sort();
  cli(root, 'remember', 'retire', first!.replace(/\.md$/, ''), '--yes');
  cli(root, 'uninstall', '--yes');

  const after = walk(root);
  const decisions = [...after.keys()].filter((k) => k.startsWith(join('docs', 'decisions')));
  expect(decisions).toHaveLength(2);
  for (const k of decisions) after.delete(k);
  expect(after).toEqual(before);
  expect(existsSync(join(root, '.claude/rules'))).toBe(false);
});

test('init then uninstall is unchanged by team decisions', () => {
  const root = repo();
  const before = walk(root);
  cli(root, 'init', '--yes');
  cli(root, 'uninstall', '--yes');
  expect(walk(root)).toEqual(before);
  expect(existsSync(join(root, 'docs'))).toBe(false);
});
