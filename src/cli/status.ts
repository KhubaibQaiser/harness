import { loadConfig } from '../core/config.js';
import { readManifest, ManifestError } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { OFF_WHY, coverageSkipped, coverageWhy, srcGlob, unsafeWhy } from '../install/preset.js';
import { stats, tddStatus, type CliEnv } from './index.js';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';
const OFF_CONFIG = 'turned off in `.harness/config.yaml`';

const GATES: [string, keyof ReturnType<typeof loadConfig>['config']['checks']][] = [
  ['guard', 'guard'], ['protect', 'protect'], ['dep-verify', 'depVerify'], ['multi-file', 'multiFile'], ['tdd', 'tdd'], ['stop', 'stop'],
];

export function status(args: string[], cli: CliEnv): number {
  const { root, out } = cli;
  if (args.length) return out('Usage: harness status'), 2;
  let m;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run harness init to install it.'), 1;

  const { config, warnings } = loadConfig(root);
  const facts = detect(root);
  const noJs = !facts.packages.some((p) => p.test !== 'none');
  // Packages init left out of TDD that are still out of it.
  const left = (m.tddOff ?? []).filter((d) => !(config.checks.tdd && config.tdd.paths.includes(srcGlob(d)))).map(unsafeWhy);
  const tddOffWhy = noJs ? OFF_WHY : left.length ? left.join(' ') : OFF_CONFIG;
  const lines = [...warnings.map((w) => `warn ${w}`), `Harness ${VERSION} (installed ${m.version})`, 'Gates'];
  for (const [label, key] of GATES) {
    const on = config.checks[key];
    lines.push(`  ${label}: ${on ? 'on' : `off - ${key === 'tdd' ? tddOffWhy : OFF_CONFIG}`}`);
  }
  if (!config.checks.tdd) lines.push(`  coverage: off - ${tddOffWhy}`);
  else lines.push(...left.map((w) => `  ${w}`), ...coverageSkipped(facts, config).map((d) => `  ${coverageWhy(d)}`), tddStatus(root));
  lines.push('Last day');
  lines.forEach((l) => out(l));
  return stats(['--days', '1'], cli);
}
