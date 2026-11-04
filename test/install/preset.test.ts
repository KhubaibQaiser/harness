import { expect, it } from 'vitest';
import { validateConfig } from '../../src/core/config-io.js';
import { detect, type Facts } from '../../src/install/detect.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from './helpers.js';

const pj = (o: object) => JSON.stringify(o);
const WHY = 'TDD and coverage support JS/TS (Vitest or Jest) only in this beta.';
const ALL = (cmd: string) => `/bin/${cmd}`; // every tool resolves
const PATHS = ['checks.tdd', 'checks.multiFile', 'tdd.paths', 'tdd.exempt', 'tdd.diff_coverage', 'tdd.coverage_skip', 'unattended.multi_file_gate', 'unattended.require_reason', 'stop.steps', 'stop.base_ref', 'stop.package_manager'];

it('pnpm monorepo preset', () => {
  const f = detect(makeRepo({
    'package.json': pj({ name: 'root', scripts: { lint: 'eslint .', typecheck: 'tsc', format: 'prettier -w .' }, devDependencies: { vitest: '1', '@vitest/coverage-v8': '1' } }),
    'vitest.config.ts': "export default { test: {} };\n",
    'packages/a/vitest.config.ts': "export default { test: {} };\n",
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'packages/a/package.json': pj({ name: 'a', scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }),
    'packages/b/package.json': pj({ name: 'b' }),
  }, { remoteHead: 'main' }));
  const p = preset(f, ALL);
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
  existing: { claudeMd: false, agentsMd: false, settings: false, settingsLocal: false, claudeDir: false, otherHooks: [] },
  defaultBranch: 'develop', warnings: [],
  deps: [], apps: [], frameworks: [], routers: [], testRunners: [], ciFiles: [], docker: false, iac: [], dbClients: [], authSdks: [], expo: false, deploy: [], gitHooks: 'none',
});

it.each([
  ['pnpm', false, ['pnpm', '-r', 'test']],
  ['npm', false, ['npm', 'test', '--workspaces']],
  ['yarn', true, ['yarn', 'workspaces', 'foreach', '-A', 'run', 'test']],
  ['yarn', false, ['yarn', 'workspaces', 'run', 'test']],
  ['bun', false, ['bun', '--filter', '*', 'test']],
] as const)('monorepo without root test script suggests recursive test (%s, berry %s)', (pm, berry, run) => {
  const p = preset(base(pm, berry), ALL);
  expect(p.config.stop.steps).toEqual([{ name: 'test', run: [...run] }]);
  expect(p.config.stop.base_ref).toBe('origin/develop');
  expect(validateConfig(p.config).ok).toBe(true);
});

it('root test script wins and prefers format:check, type-check fallback', () => {
  const f = base('npm');
  f.packages[0].scripts = { 'format:check': 'a', format: 'b', 'type-check': 'c', test: 'd' };
  expect(preset(f, ALL).config.stop.steps).toEqual(['format:check', 'type-check', 'test']);
});

it('python-only repo: TDD off with the exact why, plus ruff and pytest steps', () => {
  const f = detect(makeRepo({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' }));
  const p = preset(f, ALL);
  expect(f.python.tools).toEqual(['pytest', 'ruff']);
  expect(p.config.checks.tdd).toBe(false);
  expect(p.config.tdd.paths).toEqual([]);
  expect(p.off.map((o) => o.gate)).toEqual(['TDD', 'coverage']);
  expect(p.off.every((o) => o.why === WHY)).toBe(true);
  expect(p.config.stop.steps).toEqual([{ name: 'ruff', run: ['ruff', 'check', '.'] }, { name: 'pytest', run: ['pytest'] }]);
  expect(p.config.stop.package_manager).toBe('none');
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

const VCFG = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n";
const UNSAFE = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src' } });\n";

it('a package whose test config cannot be edited safely is left out of tdd.paths, with the why', () => {
  const f = detect(makeRepo({
    'package.json': pj({ name: 'root', devDependencies: { '@vitest/coverage-v8': '1' } }),
    'pnpm-lock.yaml': '',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'packages/a/package.json': pj({ name: 'a', scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }),
    'packages/a/vitest.config.ts': VCFG,
    'packages/b/package.json': pj({ name: 'b', scripts: { test: 'vitest' }, devDependencies: { vitest: '1' } }),
    'packages/b/vitest.config.ts': UNSAFE,
  }));
  const p = preset(f);
  expect(p.config.checks.tdd).toBe(true);
  expect(p.config.tdd.paths).toEqual(['packages/a/src/**']);
  expect(p.tddOff.map((o) => o.dir)).toEqual(['packages/b']);
  expect(p.tddOff[0].manual.join('\n')).toContain('outputFile');
  expect(p.off).toEqual([{ gate: 'TDD', why: 'TDD off for `packages/b` because its test config could not be edited safely; add the printed lines, then add `packages/b/src/**` to tdd.paths.' }]);
  expect(validateConfig(p.config).ok).toBe(true);
});

it('no package left with a safe test config: checks.tdd false with that reason', () => {
  const p = preset(detect(makeRepo({
    'package.json': pj({ name: 'u', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }),
    'vitest.config.ts': UNSAFE,
  })));
  expect(p.config.checks.tdd).toBe(false);
  expect(p.config.tdd.paths).toEqual([]);
  expect(p.tddOff.map((o) => o.dir)).toEqual(['.']);
  const why = 'TDD off for the root package because its test config could not be edited safely; add the printed lines, then add `src/**` to tdd.paths.';
  expect(p.off).toEqual([{ gate: 'TDD', why }, { gate: 'coverage', why }]);
  expect(p.reasons['checks.tdd']).toContain('could not be edited safely');
});

it('vitest without a coverage provider: TDD on, coverage gate skips that package, with the install hint', () => {
  const p = preset(detect(makeRepo({
    'package.json': pj({ name: 'u', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }),
    'vitest.config.ts': VCFG,
  })));
  expect(p.config.checks.tdd).toBe(true);
  expect(p.config.tdd.paths).toEqual(['src/**']);
  expect(p.config.tdd.coverage_skip).toEqual(['src/**']);
  expect(p.off).toEqual([{ gate: 'coverage', why: 'Coverage gate off for the root package: install @vitest/coverage-v8 to turn on the coverage gate.' }]);
  expect(p.reasons['tdd.coverage_skip']).toMatch(/^[^\n]+\.$/);
  expect(validateConfig(p.config).ok).toBe(true);
});

it('vitest with a coverage provider and jest: coverage_skip stays empty', () => {
  const p = preset(detect(makeRepo({
    'package.json': pj({ name: 'u', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1', '@vitest/coverage-v8': '1' } }),
    'vitest.config.ts': VCFG,
  })));
  expect(p.config.tdd.coverage_skip).toEqual([]);
  expect(p.off).toEqual([]);
});

it('stop steps whose tool does not resolve are left out and listed with why', () => {
  const f = detect(makeRepo({ 'pyproject.toml': '[tool.ruff]\n[tool.pytest.ini_options]\n' }));
  const p = preset(f, (cmd) => (cmd === 'pytest' ? '/bin/pytest' : null));
  expect(p.config.stop.steps).toEqual([{ name: 'pytest', run: ['pytest'] }]);
  expect(p.skippedSteps).toEqual([{ name: 'ruff', why: '`ruff` is not on PATH' }]);
  expect(p.reasons['stop.steps']).toMatch(/^[^\n]+\.$/);
});

it('script steps need the package manager itself to resolve', () => {
  const f = base('pnpm');
  f.packages[0].scripts = { lint: 'eslint .', test: 'vitest' };
  const p = preset(f, () => null);
  expect(p.config.stop.steps).toEqual([]);
  expect(p.skippedSteps).toEqual([{ name: 'lint', why: '`pnpm` is not on PATH' }, { name: 'test', why: '`pnpm` is not on PATH' }]);
});

it('a vitest package with no config file is left out with its own reason', () => {
  const p = preset(detect(makeRepo({ 'package.json': pj({ name: 'n', scripts: { test: 'vitest run' }, devDependencies: { vitest: '1' } }) })), ALL);
  expect(p.config.checks.tdd).toBe(false);
  expect(p.off[0].why).toBe('TDD off for the root package because it has no Vitest/Jest config file; create one with the printed lines, then add `src/**` to tdd.paths.');
});
