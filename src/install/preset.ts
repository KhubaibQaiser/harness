import { defaults, type HarnessConfig, type StopStep } from '../core/config.js';
import type { Facts } from './detect.js';
import { testConfigChange } from './test-config.js';

const EXEMPT = ['**/*.tsx', '**/*.stories.*', '**/index.ts', '**/generated/**', '**/migrations/**'];
export const OFF_WHY = 'TDD and coverage support JS/TS (Vitest or Jest) only in this beta.';
export const srcGlob = (dir: string): string => (dir === '.' || dir === '' ? 'src/**' : `${dir}/src/**`);
const label = (dir: string) => (dir === '.' || dir === '' ? 'the root package' : `\`${dir}\``);
export const COVERAGE_HINT = 'install @vitest/coverage-v8 to turn on the coverage gate';
export const coverageWhy = (dir: string): string => `Coverage gate off for ${label(dir)}: ${COVERAGE_HINT}.`;
/** Dirs of Vitest packages with no coverage provider that the coverage gate skips (their src/** is in tdd.coverage_skip). */
export const coverageSkipped = (f: Facts, c: HarnessConfig): string[] =>
  f.packages.filter((p) => p.noCoverageProvider && c.tdd.coverage_skip.includes(srcGlob(p.dir))).map((p) => p.dir);
export const unsafeWhy = (dir: string): string =>
  `TDD off for ${label(dir)} because its test config could not be edited safely; add the printed lines, then add \`${srcGlob(dir)}\` to tdd.paths.`;

const RECURSIVE: Record<string, (berry: boolean) => string[]> = {
  pnpm: () => ['pnpm', '-r', 'test'],
  npm: () => ['npm', 'test', '--workspaces'],
  yarn: (berry) => (berry ? ['yarn', 'workspaces', 'foreach', '-A', 'run', 'test'] : ['yarn', 'workspaces', 'run', 'test']),
  bun: () => ['bun', '--filter', '*', 'test'], // no shell, so * is passed literally
};

export type Preset = {
  config: HarnessConfig;
  reasons: Record<string, string>;
  off: { gate: string; why: string }[];
  /** Packages left out of tdd.paths because their test config could not be edited safely, with the lines to add by hand. */
  tddOff: { dir: string; manual: string[] }[];
};

export function preset(f: Facts): Preset {
  const config = defaults();
  const reasons: Record<string, string> = {};
  const root = f.packages.find((p) => p.dir === '.' || p.dir === '');
  const scripts = root?.scripts ?? {};
  const tddOff: Preset['tddOff'] = [];
  // Red-first would deny every edit in a package whose results never get written, so such a package stays out of TDD.
  const jsTested = f.packages.filter((p) => {
    if (p.test === 'none') return false;
    const r = testConfigChange(p, f.root, config.tdd.results_dir);
    if (!('manual' in r)) return true;
    tddOff.push({ dir: p.dir, manual: r.manual });
    return false;
  });
  const tdd = jsTested.length > 0;
  const unsafe = tddOff.map((o) => unsafeWhy(o.dir));

  config.checks.tdd = tdd;
  config.checks.multiFile = true;
  config.tdd.paths = jsTested.map((p) => srcGlob(p.dir));
  // Init leaves Vitest coverage off where no provider is installed, so those packages never have coverage output.
  const noCov = jsTested.filter((p) => p.noCoverageProvider);
  config.tdd.coverage_skip = noCov.map((p) => srcGlob(p.dir));
  config.tdd.exempt = EXEMPT;
  config.tdd.diff_coverage = 80;
  config.unattended = { multi_file_gate: 'block', require_reason: false };

  const steps: StopStep[] = [];
  const first = (...names: string[]) => names.find((n) => n in scripts);
  for (const s of [first('format:check', 'format'), first('lint'), first('typecheck', 'type-check', 'tsc')]) if (s) steps.push(s);
  if ('test' in scripts) steps.push('test');
  else if (f.packageManager in RECURSIVE && f.packages.some((p) => 'test' in p.scripts)) steps.push({ name: 'test', run: RECURSIVE[f.packageManager](f.yarnBerry) });
  const py = f.python.tools;
  if (py.includes('ruff')) steps.push({ name: 'ruff', run: ['ruff', 'check', '.'] });
  if (py.includes('mypy')) steps.push({ name: 'mypy', run: ['mypy', '.'] });
  if (py.includes('pytest')) steps.push({ name: 'pytest', run: ['pytest'] });
  config.stop.steps = steps;
  config.stop.base_ref = `origin/${f.defaultBranch}`;
  config.stop.package_manager = f.packageManager;

  reasons['checks.tdd'] = tdd
    ? 'Found a Vitest or Jest setup, so tests must fail before code is written.'
    : unsafe.length ? unsafe.join(' ') : 'No Vitest or Jest setup found, so this stays off.';
  reasons['tdd.paths'] = tdd ? 'These are the `src` folders of packages with a test setup.' : 'No package has a test setup, so no paths are covered.';
  reasons['tdd.exempt'] = 'These files are hard to test first, so TDD skips them.';
  reasons['tdd.diff_coverage'] = 'Changed lines need at least 80% coverage.';
  reasons['tdd.coverage_skip'] = noCov.length
    ? 'No Vitest coverage provider is installed for these, so changed-line coverage skips them until you install @vitest/coverage-v8.'
    : 'Every TDD package can write coverage, so none is skipped.';
  reasons['checks.multiFile'] = 'Asks you once per turn before an agent edits a second source file; your approval covers the rest of that turn.';
  reasons['unattended.multi_file_gate'] = 'With no human watching, a multi-file edit is blocked.';
  reasons['unattended.require_reason'] = 'Only used when the unattended gate is allow-log: extra files then need a one-line reason. It has no effect while the gate is block.';
  reasons['stop.steps'] = steps.length
    ? 'These are the checks your repo already defines, in a fixed order.'
    : 'No lint, typecheck, or test scripts were found, so nothing runs before stopping.';
  reasons['stop.base_ref'] = `Changes are compared with \`origin/${f.defaultBranch}\`, your default branch.`;
  reasons['stop.package_manager'] = f.packageManager === 'none' ? 'No package manager was found, so scripts run as plain commands.' : `Detected \`${f.packageManager}\` from your lockfile or \`package.json\`.`;

  const why = unsafe.length ? unsafe.join(' ') : OFF_WHY;
  const off = tdd
    ? [...unsafe.map((w) => ({ gate: 'TDD', why: w })), ...noCov.map((p) => ({ gate: 'coverage', why: coverageWhy(p.dir) }))]
    : [{ gate: 'TDD', why }, { gate: 'coverage', why }];
  return { config, reasons, off, tddOff };
}
