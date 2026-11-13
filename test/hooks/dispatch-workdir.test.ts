import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { handRun } from '../../src/checks/pr-size/hand-run.js';
import { registry } from '../../src/hooks/dispatch.js';
import { repo, send } from '../checks/pr-size/helpers.js';

// The built bundle, as installed skills call it: `node .harness/hooks/dispatch.mjs --workdir`.
const run = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'hooks', 'dispatch.mjs'), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20000 });
  return { code: r.status, out: r.stdout.trim() };
};
const fresh = () => realpathSync(mkdtempSync(join(tmpdir(), 'harness-dwd-')));

describe('dispatch.mjs --workdir', () => {
  test('makes a fresh git-ignored folder under the repo root, from a subfolder too, without reading stdin', () => {
    const root = repo();
    mkdirSync(join(root, 'src'), { recursive: true });
    const a = run(join(root, 'src'), '--workdir');
    expect(a.code).toBe(0);
    expect(dirname(a.out)).toBe(join(realpathSync(root), '.harness', 'tmp'));
    expect(existsSync(a.out)).toBe(true);
    expect(existsSync(join(root, '.harness/tmp/.gitignore'))).toBe(true);
    expect(run(root, '--workdir').out).not.toBe(a.out);
  });

  test('--clean removes only that folder; other paths and extra words are refused with exit 2', () => {
    const root = fresh();
    const a = run(root, '--workdir').out, b = run(root, '--workdir').out;
    for (const p of [a, b]) expect(dirname(p)).toBe(join(root, '.harness', 'tmp')); // before any write, so a failure never writes into the cwd
    writeFileSync(join(a, 'body.md'), 'x');
    expect(run(root, '--workdir', '--clean', a).code).toBe(0);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(true);
    for (const p of [join(root, '.harness/tmp'), root, join(root, '.harness/tmp/.gitignore'), '/tmp']) expect(run(root, '--workdir', '--clean', p).code, p).toBe(2);
    expect(existsSync(b)).toBe(true);
    expect(run(root, '--workdir', 'extra').code).toBe(2);
  });

  test('a symlinked .harness/tmp is refused', () => {
    const root = fresh(), elsewhere = fresh();
    mkdirSync(join(root, '.harness'));
    symlinkSync(elsewhere, join(root, '.harness/tmp'));
    expect(run(root, '--workdir').code).toBe(2);
  });

  test('is an entry flag: the hand-run deny lets it through, and the full registry allows the skill\'s commands', async () => {
    const root = repo();
    const w = { root, env: {} };
    for (const c of ['node .harness/hooks/dispatch.mjs --workdir', 'node .harness/hooks/dispatch.mjs --workdir --clean .harness/tmp/w-abc']) {
      expect(handRun(c, w), c).toBeNull();
      expect(await send(root, 'PreToolUse', c, {}, registry), c).toBe('');
    }
  });
});
