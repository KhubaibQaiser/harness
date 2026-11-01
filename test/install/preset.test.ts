import { expect, it } from 'vitest';
import { validateConfig } from '../../src/core/config-io.js';
import { detect, type Facts } from '../../src/install/detect.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from './helpers.js';

const pj = (o: object) => JSON.stringify(o);
const WHY = 'TDD and coverage support JS/TS (Vitest or Jest) only in this beta.';
const PATHS = ['checks.tdd', 'checks.multiFile', 'tdd.paths', 'tdd.exempt', 'tdd.diff_coverage', 'unattended.multi_file_gate', 'unattended.require_reason', 'stop.steps', 'stop.base_ref', 'stop.package_manager'];

it('pnpm monorepo preset', () => {
  const f = detect(makeRepo({
    'package.json': pj({ name: 'root', scripts: { lint: 'eslint .', typecheck: 'tsc', format: 'prettier -w .' }, devDependencies: { vitest: '1' } }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'packages/a/package.json': pj({ name: 'a', scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }),
    'packages/b/package.json': pj({ name: 'b' }),
  }, { remoteHead: 'main' }));
  const p = preset(f);
  expect(validateConfig(p.config).ok).toBe(true);
  expect(p.config.checks.tdd).toBe(true);
  expect(p.config.checks.multiFile).toBe(true);
  expect(p.config.tdd.paths).toEqual(['src/**', 'packages/a/src/**']);
  expect(p.config.tdd.exempt).toContain('**/*.tsx');
  expect(p.config.tdd.diff_coverage).toBe(80);
  expect(p.config.unattended).toEqual({ multi_file_gate: 'block', require_reason: false });
  expect(p.config.stop.steps).toEqual(['format', 'lint', 'typecheck', { name: 'test', run: ['pnpm', '-r', 'test'] }]);
  expect(p.config.stop.base_ref).toBe('origin/main');
  expect(p.off).toEqual([]);
});

const base = (pm: Facts['packageManager'], yarnBerry = false): Facts => ({
  root: '/x', packageManager: pm, yarnBerry,
  packages: [{ dir: '.', scripts: {}, test: 'none' }, { dir: 'packages/a', scripts: { test: 'vitest' }, test: 'vitest' }],
  python: { present: false, tools: [] },
  existing: { claudeMd: false, agentsMd: false, settings: false, settingsLocal: false, otherHooks: [] },
  defaultBranch: 'develop', warnings: [],
});

it.each([
  ['pnpm', false, ['pnpm', '-r', 'test']],
  ['npm', false, ['npm', 'test', '--workspaces']],
  ['yarn', true, ['yarn', 'workspaces', 'foreach', '-A', 'run', 'test']],
  ['yarn', false, ['yarn', 'workspaces', 'run', 'test']],
  ['bun', false, ['bun', '--filter', '*', 'test']],
] as const)('monorepo without root test script suggests recursive test (%s, berry %s)', (pm, berry, run) => {
  const p = preset(base(pm, berry));
  expect(p.config.stop.steps).toEqual([{ name: 'test', run: [...run] }]);
  expect(p.config.stop.base_ref).toBe('origin/develop');
  expect(validateConfig(p.config).ok).toBe(true);
});

it('root test script wins and prefers format:check, type-check fallback', () => {
  const f = base('npm');
  f.packages[0].scripts = { 'format:check': 'a', format: 'b', 'type-check': 'c', test: 'd' };
  expect(preset(f).config.stop.steps).toEqual(['format:check', 'type-check', 'test']);
});

it('python-only repo: TDD off with the exact why, plus ruff and pytest steps', () => {
  const f = detect(makeRepo({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' }));
  const p = preset(f);
  expect(f.python.tools).toEqual(['pytest', 'ruff']);
  expect(p.config.checks.tdd).toBe(false);
  expect(p.config.tdd.paths).toEqual([]);
  expect(p.off.map((o) => o.gate)).toEqual(['TDD', 'coverage']);
  expect(p.off.every((o) => o.why === WHY)).toBe(true);
  expect(p.config.stop.steps).toEqual([{ name: 'ruff', run: ['ruff', 'check', '.'] }, { name: 'pytest', run: ['pytest'] }]);
  expect(validateConfig(p.config).ok).toBe(true);
});

it('no tests at all: steps empty and TDD off', () => {
  const p = preset(detect(makeRepo({ 'README.md': 'x' })));
  expect(p.config.stop.steps).toEqual([]);
  expect(p.config.checks.tdd).toBe(false);
  expect(p.off).toHaveLength(2);
  expect(validateConfig(p.config).ok).toBe(true);
});

it('every config path the preset sets has a reason', () => {
  for (const f of [base('pnpm'), detect(makeRepo({ 'README.md': 'x' }))]) {
    const { reasons } = preset(f);
    for (const k of PATHS) {
      expect(reasons[k], k).toMatch(/^[^\n]+\.$/);
      expect(reasons[k]).not.toMatch(/please/i);
    }
  }
});
