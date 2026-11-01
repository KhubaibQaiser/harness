import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { findOnPath, resolveStep, winCmdLine } from '../../../src/checks/stop/runner.js';

test('script step per package manager', () => {
  for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    expect(resolveStep('lint', pm, { lint: 'x' })).toEqual({ cmd: pm, args: ['run', 'lint'], label: 'lint' });
  }
  expect(resolveStep('lint', 'none', { lint: 'x' })).toBeNull();
});

test('command step runs as written', () => {
  expect(resolveStep({ name: 'lint', run: ['ruff', 'check', '.'] }, 'none', {})).toEqual({ cmd: 'ruff', args: ['check', '.'], label: 'lint' });
});

test('missing script skipped', () => {
  expect(resolveStep('lint', 'pnpm', {})).toBeNull();
  expect(resolveStep('toString', 'pnpm', {})).toBeNull();
});

test('windows resolves .cmd shims', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-path-'));
  writeFileSync(join(dir, 'pnpm.cmd'), '');
  expect(findOnPath('pnpm', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(join(dir, 'pnpm.cmd'));
  expect(findOnPath('pnpm', { Path: dir }, 'win32')).toBe(join(dir, 'pnpm.cmd'));
  expect(findOnPath('nope', { PATH: dir }, 'win32')).toBeNull();
});

test('posix needs an executable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-path-'));
  writeFileSync(join(dir, 'tool'), '', { mode: 0o755 });
  writeFileSync(join(dir, 'plain'), '', { mode: 0o644 });
  mkdirSync(join(dir, 'adir'));
  const env = { PATH: `/nonexistent:${dir}` };
  expect(findOnPath('tool', env, 'linux')).toBe(join(dir, 'tool'));
  expect(findOnPath('plain', env, 'linux')).toBeNull();
  expect(findOnPath('adir', env, 'linux')).toBeNull();
  expect(findOnPath('tool', {}, 'linux')).toBeNull();
});

test('winCmdLine quotes for cmd.exe', () => {
  const f = 'C:\\x\\pnpm.cmd';
  expect(winCmdLine(f, ['run', 'lint'])).toBe('"C:\\x\\pnpm.cmd ^"run^" ^"lint^""');
  expect(winCmdLine(f, ['a b'])).toBe('"C:\\x\\pnpm.cmd ^"a^ b^""');
  expect(winCmdLine(f, ['say "hi"'])).toBe('"C:\\x\\pnpm.cmd ^"say^ \\^"hi\\^"^""');
  expect(winCmdLine(f, ['a&b'])).toBe('"C:\\x\\pnpm.cmd ^"a^&b^""');
  expect(winCmdLine(f, ['100%'])).toBe('"C:\\x\\pnpm.cmd ^"100^%^""');
  expect(winCmdLine(f, ['a^b'])).toBe('"C:\\x\\pnpm.cmd ^"a^^b^""');
  expect(winCmdLine('C:\\Program Files\\n\\p.cmd', [])).toBe('"C:\\Program^ Files\\n\\p.cmd"');
  expect(winCmdLine(f, ['dir\\'])).toBe('"C:\\x\\pnpm.cmd ^"dir\\\\^""');
});
