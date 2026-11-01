import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { detect } from '../../src/install/detect.js';
import { makeRepo } from './helpers.js';

const pj = (o: object) => JSON.stringify(o);

test('empty repo', () => {
  const f = detect(makeRepo({ 'README.md': 'x' }));
  expect(f.packageManager).toBe('none');
  expect(f.packages).toEqual([]);
  expect(f.python).toEqual({ present: false, tools: [] });
  expect(f.existing).toEqual({ claudeMd: false, agentsMd: false, settings: false, settingsLocal: false, otherHooks: [] });
  expect(f.defaultBranch).toBe('main');
});

test('single npm package with vitest', () => {
  const f = detect(makeRepo({ 'package.json': pj({ name: 'a', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }), 'package-lock.json': '{}' }));
  expect(f.packageManager).toBe('npm');
  expect(f.packages).toEqual([{ dir: '.', name: 'a', scripts: { test: 'vitest run' }, test: 'vitest' }]);
});

test('package.json without lockfile is npm', () => {
  expect(detect(makeRepo({ 'package.json': '{}' })).packageManager).toBe('npm');
});

test('packageManager field wins over the lockfile', () => {
  expect(detect(makeRepo({ 'package.json': pj({ packageManager: 'pnpm@9.1.0' }), 'yarn.lock': '' })).packageManager).toBe('pnpm');
});

test('lockfiles', () => {
  expect(detect(makeRepo({ 'package.json': '{}', 'pnpm-lock.yaml': '' })).packageManager).toBe('pnpm');
  expect(detect(makeRepo({ 'package.json': '{}', 'yarn.lock': '' })).packageManager).toBe('yarn');
});

test('bun.lockb detected', () => {
  expect(detect(makeRepo({ 'package.json': '{}', 'bun.lockb': '' })).packageManager).toBe('bun');
  expect(detect(makeRepo({ 'package.json': '{}', 'bun.lock': '' })).packageManager).toBe('bun');
});

test('yarn berry from .yarnrc.yml', () => {
  const f = detect(makeRepo({ 'package.json': '{}', 'yarn.lock': '', '.yarnrc.yml': 'nodeLinker: node-modules' }));
  expect(f.yarnBerry).toBe(true);
  expect(detect(makeRepo({ 'package.json': '{}', 'yarn.lock': '' })).yarnBerry).toBe(false);
});

test('pnpm workspace globs expand', () => {
  const f = detect(
    makeRepo({
      'package.json': pj({ name: 'root' }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/skip"\n',
      'packages/b/package.json': pj({ name: 'b', devDependencies: { jest: '1' } }),
      'packages/a/package.json': pj({ name: 'a' }),
      'packages/skip/package.json': pj({ name: 'skip' }),
      'packages/node_modules/x/package.json': pj({ name: 'x' }),
      'packages/c/readme': 'no package.json',
    }),
  );
  expect(f.packages.map((p) => p.dir)).toEqual(['.', 'packages/a', 'packages/b']);
  expect(f.packages[2]!.test).toBe('jest');
});

test('package.json workspaces as array and as {packages}', () => {
  const files = { 'apps/w/package.json': pj({ name: 'w' }) };
  expect(detect(makeRepo({ ...files, 'package.json': pj({ workspaces: ['apps/*'] }) })).packages.map((p) => p.dir)).toEqual(['.', 'apps/w']);
  expect(detect(makeRepo({ ...files, 'package.json': pj({ workspaces: { packages: ['apps/*'] } }) })).packages.map((p) => p.dir)).toEqual(['.', 'apps/w']);
});

test('workspace walk does not follow symlinks', () => {
  const root = makeRepo({ 'package.json': pj({ workspaces: ['packages/*'] }), 'real/package.json': '{}', 'packages/.keep': '' });
  symlinkSync(join(root, 'real'), join(root, 'packages', 'link'));
  expect(detect(root).packages.map((p) => p.dir)).toEqual(['.']);
});

test('vite.config with a test key is vitest', () => {
  const f = detect(makeRepo({ 'package.json': '{}', 'vite.config.ts': 'export default { test: { globals: true } }' }));
  expect(f.packages[0]!.test).toBe('vitest');
  expect(f.packages[0]!.testConfig).toBe('vite.config.ts');
  expect(detect(makeRepo({ 'package.json': '{}', 'vite.config.ts': 'export default {}' })).packages[0]!.test).toBe('none');
});

test('jest via config file or package.json key', () => {
  expect(detect(makeRepo({ 'package.json': '{}', 'jest.config.js': '' })).packages[0]).toMatchObject({ test: 'jest', testConfig: 'jest.config.js' });
  expect(detect(makeRepo({ 'package.json': pj({ jest: {} }) })).packages[0]!.test).toBe('jest');
});

test('python tools from pyproject', () => {
  const f = detect(makeRepo({ 'pyproject.toml': '[tool.ruff]\nline-length=100\n[tool.mypy]\n[project]\ndependencies = ["pytest>=7", "black"]\n' }));
  expect(f.python).toEqual({ present: true, tools: ['pytest', 'ruff', 'mypy', 'black'] });
});

test('python tools from requirements', () => {
  const f = detect(makeRepo({ 'requirements-dev.txt': 'pytest==8\n# mypy\nruff\n' }));
  expect(f.python).toEqual({ present: true, tools: ['pytest', 'ruff'] });
});

test('default branch from origin/HEAD', () => {
  expect(detect(makeRepo({ a: '1' }, { remoteHead: 'develop' })).defaultBranch).toBe('develop');
});

test('default branch falls back to current branch', () => {
  const root = makeRepo({ a: '1' });
  expect(detect(root).defaultBranch).toBe('main');
});

test('existing claude setup and non-git dir', () => {
  const f = detect(makeRepo({ 'CLAUDE.md': '', 'AGENTS.md': '', '.claude/settings.json': '{}' }, { git: false }));
  expect(f.existing).toMatchObject({ claudeMd: true, agentsMd: true, settings: true, settingsLocal: false });
  expect(f.defaultBranch).toBe('main');
});

test('a malformed package.json gives a warning, not a throw', () => {
  const f = detect(makeRepo({ 'package.json': '{nope' }));
  expect(f.warnings.some((w) => w.includes('package.json'))).toBe(true);
  expect(f.packageManager).toBe('npm');
});

test('a settings.local.json with hooks is reported in otherHooks', () => {
  const hook = (command: string) => ({ hooks: [{ type: 'command', command }] });
  const f = detect(
    makeRepo({
      '.claude/settings.json': pj({ hooks: { PreToolUse: [hook('node .harness/hooks/dispatch.mjs pre')] } }),
      '.claude/settings.local.json': pj({ hooks: { Stop: [hook('notify.sh')] } }),
    }),
  );
  expect(f.existing.otherHooks).toEqual(['notify.sh']);
  expect(f.existing.settingsLocal).toBe(true);
  expect(detect(makeRepo({ '.claude/settings.json': '{bad' })).warnings.some((w) => w.includes('settings.json'))).toBe(true);
});
