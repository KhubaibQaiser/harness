import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { findOnPath, resolveStep, syncCommand, winCmdLine } from '../../../src/checks/stop/runner.js';

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

test('windows prefers pnpm.cmd over the extensionless shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-path-'));
  writeFileSync(join(dir, 'pnpm'), '');
  writeFileSync(join(dir, 'pnpm.cmd'), '');
  expect(findOnPath('pnpm', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(join(dir, 'pnpm.cmd'));
  expect(findOnPath('pnpm.cmd', { PATH: dir }, 'win32')).toBe(join(dir, 'pnpm.cmd'));
});

// POSIX only: Windows has no executable bit, and its tmpdir (C:\\...) cannot sit in a `:`-separated PATH.
test.skipIf(process.platform === 'win32')('posix needs an executable file', () => {
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

test('syncCommand runs Windows .cmd shims through cmd.exe and leaves other commands as they are', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h-path-'));
  writeFileSync(join(dir, 'npm.cmd'), '');
  writeFileSync(join(dir, 'claude.exe'), '');
  const env = { PATH: dir, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  expect(syncCommand('npm', ['view', 'a&b'], 'win32', env)).toEqual(['C:\\Windows\\system32\\cmd.exe', ['/d', '/s', '/c', winCmdLine(join(dir, 'npm.cmd'), ['view', 'a&b'])], { windowsVerbatimArguments: true }]);
  expect(syncCommand('claude', ['--version'], 'win32', env)).toEqual([join(dir, 'claude.exe'), ['--version'], {}]);
  expect(syncCommand('nope', ['x'], 'win32', env)).toEqual(['nope', ['x'], {}]);
  expect(syncCommand('npm', ['view'], 'linux', env)).toEqual(['npm', ['view'], {}]);
});
