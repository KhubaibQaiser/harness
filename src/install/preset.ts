import { defaults, type HarnessConfig, type StopStep } from '../core/config.js';
import type { Facts } from './detect.js';

const EXEMPT = ['**/*.tsx', '**/*.stories.*', '**/index.ts', '**/generated/**', '**/migrations/**'];
const OFF_WHY = 'TDD and coverage support JS/TS (Vitest or Jest) only in this beta.';

const RECURSIVE: Record<string, (berry: boolean) => string[]> = {
  pnpm: () => ['pnpm', '-r', 'test'],
  npm: () => ['npm', 'test', '--workspaces'],
  yarn: (berry) => (berry ? ['yarn', 'workspaces', 'foreach', '-A', 'run', 'test'] : ['yarn', 'workspaces', 'run', 'test']),
  bun: () => ['bun', '--filter', '*', 'test'], // no shell, so * is passed literally
};

export function preset(f: Facts): { config: HarnessConfig; reasons: Record<string, string>; off: { gate: string; why: string }[] } {
  const config = defaults();
  const reasons: Record<string, string> = {};
  const root = f.packages.find((p) => p.dir === '.' || p.dir === '');
  const scripts = root?.scripts ?? {};
  const jsTested = f.packages.filter((p) => p.test !== 'none');
  const tdd = jsTested.length > 0;

  config.checks.tdd = tdd;
  config.checks.multiFile = true;
  config.tdd.paths = jsTested.map((p) => (p.dir === '.' || p.dir === '' ? 'src/**' : `${p.dir}/src/**`));
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
  if (f.packageManager !== 'none') config.stop.package_manager = f.packageManager;

  reasons['checks.tdd'] = tdd ? 'Found a Vitest or Jest setup, so tests must fail before code is written.' : 'No Vitest or Jest setup found, so this stays off.';
  reasons['tdd.paths'] = tdd ? 'These are the `src` folders of packages with a test setup.' : 'No package has a test setup, so no paths are covered.';
  reasons['tdd.exempt'] = 'These files are hard to test first, so TDD skips them.';
  reasons['tdd.diff_coverage'] = 'Changed lines need at least 80% coverage.';
  reasons['checks.multiFile'] = 'Asks you once per turn before an agent edits a second source file; your approval covers the rest of that turn.';
  reasons['unattended.multi_file_gate'] = 'With no human watching, a multi-file edit is blocked.';
  reasons['unattended.require_reason'] = 'Only used when the unattended gate is allow-log: extra files then need a one-line reason. It has no effect while the gate is block.';
  reasons['stop.steps'] = steps.length
    ? 'These are the checks your repo already defines, in a fixed order.'
    : 'No lint, typecheck, or test scripts were found, so nothing runs before stopping.';
  reasons['stop.base_ref'] = `Changes are compared with \`origin/${f.defaultBranch}\`, your default branch.`;
  reasons['stop.package_manager'] = f.packageManager === 'none' ? 'No package manager was found, so scripts run as plain commands.' : `Detected \`${f.packageManager}\` from your lockfile or \`package.json\`.`;

  return { config, reasons, off: tdd ? [] : [{ gate: 'TDD', why: OFF_WHY }, { gate: 'coverage', why: OFF_WHY }] };
}
