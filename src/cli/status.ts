import { loadConfig } from '../core/config.js';
import { readManifest, ManifestError } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { OFF_WHY } from '../install/preset.js';
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
  const noJs = !detect(root).packages.some((p) => p.test !== 'none');
  const lines = [...warnings.map((w) => `warn ${w}`), `Harness ${VERSION} (installed ${m.version})`, 'Gates'];
  for (const [label, key] of GATES) {
    const on = config.checks[key];
    lines.push(`  ${label}: ${on ? 'on' : `off - ${key === 'tdd' && noJs ? OFF_WHY : OFF_CONFIG}`}`);
  }
  if (!config.checks.tdd) lines.push(`  coverage: off - ${noJs ? OFF_WHY : OFF_CONFIG}`);
  else lines.push(tddStatus(root));
  lines.push('Last day');
  lines.forEach((l) => out(l));
  return stats(['--days', '1'], cli);
}
