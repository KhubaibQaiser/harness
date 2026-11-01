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

test('default branch: origin/HEAD wins', () => {
  expect(detect(makeRepo({ a: '1' }, { remoteHead: 'develop' })).defaultBranch).toBe('develop');
});
test('default branch: falls back to main', () => {
  expect(detect(makeRepo({ a: '1' }, { branch: 'main' })).defaultBranch).toBe('main');
});
test('default branch: falls back to master when there is no main', () => {
  expect(detect(makeRepo({ a: '1' }, { branch: 'master' })).defaultBranch).toBe('master');
});
test('default branch: falls back to the current branch when there is no origin/HEAD, main or master', () => {
  expect(detect(makeRepo({ a: '1' }, { branch: 'trunk' })).defaultBranch).toBe('trunk');
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

// Spec section 8 fixture shapes.
test('fixture: npm with Vitest', () => {
  const f = detect(makeRepo({ 'package.json': pj({ name: 'n', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } }), 'package-lock.json': '{}', 'vitest.config.ts': 'export default {}' }));
  expect(f.packageManager).toBe('npm');
  expect(f.packages).toEqual([{ dir: '.', name: 'n', scripts: { test: 'vitest run' }, test: 'vitest', testConfig: 'vitest.config.ts' }]);
});

test('fixture: pnpm monorepo with Vitest', () => {
  const f = detect(
    makeRepo({
      'package.json': pj({ name: 'root', packageManager: 'pnpm@9.0.0' }),
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': '',
      'packages/b/package.json': pj({ name: 'b', scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } }),
      'packages/b/vitest.config.mts': 'export default {}',
      'packages/a/package.json': pj({ name: 'a', devDependencies: { vitest: '2' } }),
    }),
  );
  expect(f.packageManager).toBe('pnpm');
  expect(f.packages.map((p) => [p.dir, p.test, p.testConfig])).toEqual([
    ['.', 'none', undefined],
    ['packages/a', 'vitest', undefined],
    ['packages/b', 'vitest', 'vitest.config.mts'],
  ]);
});

test('fixture: yarn with Jest', () => {
  const f = detect(makeRepo({ 'package.json': pj({ name: 'y', scripts: { test: 'jest' }, devDependencies: { jest: '29' } }), 'yarn.lock': '', 'jest.config.js': 'module.exports = {}' }));
  expect(f.packageManager).toBe('yarn');
  expect(f.packages[0]).toMatchObject({ test: 'jest', testConfig: 'jest.config.js', scripts: { test: 'jest' } });
});

test('fixture: bun with Vitest', () => {
  const f = detect(makeRepo({ 'package.json': pj({ devDependencies: { vitest: '2' } }), 'bun.lock': '', 'vitest.config.ts': 'export default {}' }));
  expect(f.packageManager).toBe('bun');
  expect(f.packages[0]).toMatchObject({ test: 'vitest', testConfig: 'vitest.config.ts' });
});

test('fixture: Python with pytest and ruff', () => {
  const f = detect(makeRepo({ 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[tool.ruff]\nline-length = 100\n' }));
  expect(f.python).toEqual({ present: true, tools: ['pytest', 'ruff'] });
  expect(f.packageManager).toBe('none');
  expect(f.packages).toEqual([]);
});

test('fixture: a repo with no tests', () => {
  const f = detect(makeRepo({ 'package.json': pj({ name: 'x', scripts: { build: 'tsc' } }), 'src/index.ts': '' }));
  expect(f.packages[0]).toEqual({ dir: '.', name: 'x', scripts: { build: 'tsc' }, test: 'none' });
  expect(f.python.tools).toEqual([]);
});

test('fixture: existing CLAUDE.md, AGENTS.md, settings with other hooks, CRLF files', () => {
  const crlf = (o: object) => JSON.stringify(o, null, 2).replace(/\n/g, '\r\n');
  const f = detect(
    makeRepo({
      'CLAUDE.md': '# c\r\n',
      'AGENTS.md': '# a\r\n',
      'package.json': crlf({ name: 'crlf', scripts: { test: 'vitest' }, devDependencies: { vitest: '2' } }),
      '.claude/settings.json': crlf({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'prettier --write' }, { type: 'command', command: 'node .harness/hooks/dispatch.mjs post' }] }] } }),
      '.claude/settings.local.json': crlf({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } }),
    }),
  );
  expect(f.existing).toEqual({ claudeMd: true, agentsMd: true, settings: true, settingsLocal: true, otherHooks: ['prettier --write', 'notify.sh'] });
  expect(f.packages[0]).toMatchObject({ name: 'crlf', test: 'vitest' });
  expect(f.warnings).toEqual([]);
});

test('fixture: a Vitest config that cannot be edited safely is still reported', () => {
  const f = detect(makeRepo({ 'package.json': pj({ devDependencies: { vitest: '2' } }), 'vitest.config.ts': "import base from './vite.config';\nexport default mergeConfig(base, defineConfig({ test: {} }));" }));
  expect(f.packages[0]).toMatchObject({ test: 'vitest', testConfig: 'vitest.config.ts' });
});

// Warnings are shown to users: repo-relative backticked paths, what happened, next step.
test('warnings use repo-relative paths, never the absolute root', () => {
  const root = makeRepo({
    'package.json': pj({ workspaces: ['packages/*', '../outside/*'] }),
    'packages/a/package.json': '{nope',
    '.claude/settings.json': '[]',
    'pnpm-workspace.yaml': 'packages: [',
    'pyproject.toml/placeholder': '',
  });
  const f = detect(root);
  expect(f.warnings).toContain('Could not parse `packages/a/package.json`; its scripts and test framework are skipped. Fix the JSON and run init again.');
  expect(f.warnings).toContain('`.claude/settings.json` is not a JSON object; its hooks are not reported. Fix the file and run init again.');
  expect(f.warnings).toContain('Could not parse `pnpm-workspace.yaml`; its workspace packages are skipped. Fix the YAML and run init again.');
  expect(f.warnings.some((w) => w.includes('`../outside/*`'))).toBe(true);
  expect(f.warnings.length).toBeGreaterThan(0);
  for (const w of f.warnings) expect(w).not.toContain(root);
});

test('a workspace glob outside the root is not walked', () => {
  const root = makeRepo({ 'sub/package.json': pj({ workspaces: ['../*'] }), 'sibling/package.json': '{}' });
  const f = detect(join(root, 'sub'));
  expect(f.packages.map((p) => p.dir)).toEqual(['.']);
  expect(f.warnings.some((w) => w.includes('outside the repo'))).toBe(true);
});

test('unreadable files become warnings, not throws', () => {
  const f = detect(makeRepo({ 'package.json': '{}', 'pyproject.toml/x': '' })); // pyproject.toml is a directory: EISDIR
  expect(f.warnings.some((w) => w.includes('`pyproject.toml`'))).toBe(true);
  expect(() => detect('/nonexistent/harness-root')).not.toThrow();
});
