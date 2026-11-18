// Review A, R2-1: a CLI command run before init leaves no .harness/ behind, so init's guard never refuses harness's own writes.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { makeRepo } from '../install/helpers.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_PLAIN_INIT: '1' };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX', 'HARNESS_TASK']) delete env[k];
const cli = (root: string, ...args: string[]) => spawnSync('node', [CLI, ...args], { cwd: root, env, encoding: 'utf8' });

test('commands run before init write nothing under .harness/, and init then installs', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }) + '\n',
    'package-lock.json': '{}\n',
    '.gitignore': 'node_modules\n',
  });
  for (const args of [['tdd', 'off'], ['tdd', 'on'], ['tdd', 'status'], ['task', 'draft', '.harness/tmp/w-1/t.json'], ['task', 'close', 't'], ['report'], ['verify'], ['review', '--keep', '7'], ['remember', 'sync'], ['remember', 'confirm', 'x'], ['remember', 'add', '--paths', 'src/**', '--rule', 'r'], ['stats'], ['status'], ['doctor']]) {
    cli(root, ...args);
    expect(existsSync(join(root, '.harness')), args.join(' ')).toBe(false);
  }
  const i = cli(root, 'init', '--yes');
  expect(i.status, i.stdout + i.stderr).toBe(0);
});
