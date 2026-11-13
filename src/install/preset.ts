import { defaults, type HarnessConfig, type StopStep } from '../core/config.js';
import type { Facts, PackageFacts } from './detect.js';
import { testConfigChange } from './test-config.js';
import { findOnPath, resolveStep } from '../checks/stop/runner.js';

const EXEMPT = ['**/*.tsx', '**/*.stories.*', '**/index.ts', '**/generated/**', '**/migrations/**'];
export const OFF_WHY = 'TDD and coverage support JS/TS (Vitest or Jest) only in this beta.';
export const srcGlob = (dir: string): string => (dir === '.' || dir === '' ? 'src/**' : `${dir}/src/**`);
const label = (dir: string) => (dir === '.' || dir === '' ? 'the root package' : `\`${dir}\``);
export const COVERAGE_HINT = 'install @vitest/coverage-v8 to turn on the coverage gate';
/** The packages whose coverage output the gate can never read: Vitest with no provider, Jest with a coverage config it can't read. */
export const noCoverage = (p: PackageFacts): boolean => !!(p.noCoverageProvider || p.coverageUnreadable);
/** What to do so the coverage gate can read a package's coverage. */
export const coverageHint = (p: PackageFacts): string =>
  p.coverageUnreadable ? `${p.coverageUnreadable}; the gate reads coverage/coverage-final.json, so keep 'json' in \`coverageReporters\` and the default \`coverageDirectory\`, then remove \`${srcGlob(p.dir)}\` from tdd.coverage_skip` : COVERAGE_HINT;
export const coverageWhy = (p: PackageFacts): string => `Coverage gate off for ${label(p.dir)}: ${coverageHint(p)}.`;
/** Packages the coverage gate skips because it can't read their coverage (their src/** is in tdd.coverage_skip). */
export const coverageSkipped = (f: Facts, c: HarnessConfig): PackageFacts[] =>
  f.packages.filter((p) => noCoverage(p) && c.tdd.coverage_skip.includes(srcGlob(p.dir)));
/** A Vitest package with no config file: init has nothing to edit, so the user creates one. */
export const noConfigFile = (p: { test: string; testConfig?: string } | undefined): boolean => p?.test === 'vitest' && !p.testConfig;
export const offCause = (noConfig: boolean): string => (noConfig ? 'it has no Vitest/Jest config file' : 'its test config could not be edited safely');
export const unsafeWhy = (dir: string, noConfig = false): string =>
  `TDD off for ${label(dir)} because ${offCause(noConfig)}; ${noConfig ? 'create one with' : 'add'} the printed lines, then add \`${srcGlob(dir)}\` to tdd.paths.`;

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
  tddOff: { dir: string; manual: string[]; noConfig: boolean }[];
  /** Stop steps left out because their tool (or the package manager running them) is not on PATH. */
  skippedSteps: { name: string; why: string }[];
};

export type Which = (cmd: string) => string | null;
const pathWhich: Which = (cmd) => findOnPath(cmd, process.env, process.platform);

export function preset(f: Facts, which: Which = pathWhich, platform: NodeJS.Platform = process.platform): Preset {
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
    tddOff.push({ dir: p.dir, manual: r.manual, noConfig: noConfigFile(p) });
    return false;
  });
  const tdd = jsTested.length > 0;
  const unsafe = tddOff.map((o) => unsafeWhy(o.dir, o.noConfig));

  config.checks.tdd = tdd;
  config.checks.multiFile = true;
  config.tdd.paths = jsTested.map((p) => srcGlob(p.dir));
  // Init leaves Vitest coverage off where no provider is installed, and a Jest coverage config can put the output where
  // the gate does not look, so those packages never have readable coverage output.
  const noCov = jsTested.filter(noCoverage);
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
  // A step whose tool is missing would only fail every Stop; leave it out and say so.
  const skippedSteps: Preset['skippedSteps'] = [];
  config.stop.steps = steps.filter((s) => {
    const r = resolveStep(s, f.packageManager, scripts);
    if (!r || which(r.cmd)) return true;
    skippedSteps.push({ name: r.label, why: `\`${r.cmd}\` is not on PATH` });
    return false;
  });
  config.stop.base_ref = `origin/${f.defaultBranch}`;
  config.stop.package_manager = f.packageManager;

  reasons['checks.tdd'] = tdd
    ? 'Found a Vitest or Jest setup, so tests must fail before code is written.'
    : unsafe.length ? unsafe.join(' ') : 'No Vitest or Jest setup found, so this stays off.';
  reasons['tdd.paths'] = tdd ? 'These are the `src` folders of packages with a test setup.' : 'No package has a test setup, so no paths are covered.';
  reasons['tdd.exempt'] = 'These files are hard to test first, so TDD skips them.';
  reasons['tdd.diff_coverage'] = 'Changed lines need at least 80% coverage.';
  reasons['tdd.coverage_skip'] = noCov.length
    ? noCov.map((p) => coverageWhy(p)).join(' ') + ' Changed-line coverage skips these until then.'
    : 'Every TDD package can write coverage, so none is skipped.';
  reasons['checks.multiFile'] = 'Asks you once per turn before an agent edits a second source file (test files never count); your approval covers the rest of that turn.';
  reasons['unattended.multi_file_gate'] = 'With no human watching, a multi-file edit is blocked.';
  reasons['unattended.require_reason'] = 'Only used when the unattended gate is allow-log: extra files then need a one-line reason. It has no effect while the gate is block.';
  const skipped = skippedSteps.length ? ` Left out because their tool is not on PATH: ${skippedSteps.map((s) => `\`${s.name}\``).join(', ')}.` : '';
  reasons['stop.steps'] = (config.stop.steps.length
    ? 'These are the checks your repo already defines, in a fixed order.'
    : steps.length ? 'No step can run here, so nothing runs before stopping.' : 'No lint, typecheck, or test scripts were found, so nothing runs before stopping.') + skipped;
  reasons['stop.base_ref'] = `Changes are compared with \`origin/${f.defaultBranch}\`, your default branch.`;
  reasons['stop.package_manager'] = f.packageManager === 'none' ? 'No package manager was found, so scripts run as plain commands.' : `Detected \`${f.packageManager}\` from your lockfile or \`package.json\`.`;

  // Claude Code's sandbox on by default where it runs (owner ruling, 2026-11-13): macOS, and Linux or WSL2 with bwrap and socat.
  const sandboxWhy = platform === 'win32' ? 'native Windows has no Claude Code sandbox, so it is required for unattended runs only (sandbox: unattended)'
    : platform !== 'darwin' && !(which('bwrap') && which('socat')) ? 'the Linux sandbox needs bwrap and socat, which are not on PATH; install them, then set sandbox: always and run /harness:update' : '';
  config.sandbox = sandboxWhy ? 'unattended' : 'always';
  reasons.sandbox = sandboxWhy ? `Required for unattended runs only: ${sandboxWhy}.` : 'Claude Code\'s sandbox is on in every session, so a Bash write to a harness file fails at the OS level. Its network allowlist starts empty: allow hosts under sandbox.network.allowedDomains.';

  const why = unsafe.length ? unsafe.join(' ') : OFF_WHY;
  const off = tdd
    ? [...unsafe.map((w) => ({ gate: 'TDD', why: w })), ...noCov.map((p) => ({ gate: 'coverage', why: coverageWhy(p) }))]
    : [{ gate: 'TDD', why }, { gate: 'coverage', why }];
  if (sandboxWhy) off.push({ gate: 'sandbox', why: sandboxWhy });
  return { config, reasons, off, tddOff, skippedSteps };
}
