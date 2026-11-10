import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type LoadedCatalog } from '../catalog/load.js';
import { contextSet } from '../budget/summary.js';
import { contextDirs, contextLine } from './doctor-context.js';
import { decisionsStatusLine } from './doctor-decisions.js';
import { pinnedPlugins } from '../install/merge.js';
import { pluginList } from '../install/plugin-install.js';
import { selectedIds } from '../install/plan.js';
import { PRESET_ITEM } from '../install/plan-preset.js';
import { loadConfig } from '../core/config.js';
import { GATES } from '../core/gates.js';
import { lastConfigChangeBlocked, lastHarnessFilesChange } from '../core/events.js';
import { readHookEnv } from '../core/hook-env.js';
import { LOCK_RECOVERY, LOCK_REL, readManifest, ManifestError } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { isHarnessHook } from '../install/merge.js';
import { BLOCKING } from './doctor.js';
import { OFF_WHY, coverageSkipped, coverageWhy, noConfigFile, srcGlob, unsafeWhy } from '../install/preset.js';
import { stats, tddStatus, type CliEnv } from './index.js';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';
const OFF_CONFIG = 'turned off in `.harness/config.yaml`';

export type StatusDeps = { platform?: NodeJS.Platform; pluginList?: typeof pluginList };

export function status(args: string[], cli: CliEnv, deps: StatusDeps = {}): number {
  const { root, out } = cli;
  const platform = deps.platform ?? process.platform;
  if (args.length) return out('Usage: harness status'), 2;
  let m;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.'), 1;

  const { config, warnings } = loadConfig(root);
  const facts = detect(root);
  const noJs = !facts.packages.some((p) => p.test !== 'none');
  // Packages init left out of TDD that are still out of it.
  const left = (m.tddOff ?? []).filter((d) => !(config.checks.tdd && config.tdd.paths.includes(srcGlob(d)))).map((d) => unsafeWhy(d, noConfigFile(facts.packages.find((p) => p.dir === d))));
  const tddOffWhy = noJs ? OFF_WHY : left.length ? left.join(' ') : OFF_CONFIG;
  const lines = [...warnings.map((w) => `warn ${w}`), `Harness ${VERSION} (installed ${m.version})`, ...(existsSync(join(root, LOCK_REL)) ? [`Lock: ${LOCK_REL} exists. ${LOCK_RECOVERY}`] : []), 'Gates'];
  for (const [label, key] of GATES) {
    const on = config.checks[key];
    lines.push(`  ${label}: ${on ? 'on' : `off - ${key === 'tdd' ? tddOffWhy : OFF_CONFIG}`}`);
  }
  if (!config.checks.tdd) lines.push(`  coverage: off - ${tddOffWhy}`);
  else lines.push(...left.map((w) => `  ${w}`), ...coverageSkipped(facts, config).map((p) => `  ${coverageWhy(p)}`), tddStatus(root));
  const where =
    platform === 'darwin' ? 'macOS: available' : platform === 'win32' ? 'native Windows: not available'
    : platform !== 'linux' ? `${platform}: not checked` : cli.env.WSL_DISTRO_NAME ? 'WSL2: available' : 'Linux: available';
  const lc = loadCatalog(); // one load for the Context: line and the item lines
  lines.push(contextLine(contextSet(root, config, contextDirs(), undefined, { catalog: lc })));
  lines.push(decisionsStatusLine(root, config));
  lines.push(`Enforcement: sandbox ${config.sandbox} (${where})`);
  lines.push(blocksOnFailure(root)
    ? 'Hook failure: blocks tool calls, prompts and settings changes; the Stop gate fails open'
    : 'Hook failure: a harness hook in `.claude/settings.json` lacks `onFailure: "block"`, so a failure may not block; run harness doctor');
  const he = readHookEnv(root);
  lines.push(he ? `Hooks run Node ${he.node} (${he.ts})` : 'Hooks run Node: not recorded yet');
  const blocked = lastConfigChangeBlocked(root);
  if (blocked) lines.push(`Last blocked settings change: ${blocked.ts} (${blocked.reason})`);
  const changed = lastHarnessFilesChange(root);
  if (changed) lines.push(`Harness files last changed during a session: ${changed.ts} (${changed.files.map((f) => `\`${f}\``).join(', ')}); review with git diff -- .harness .claude/settings.json`);
  if (config.items.length) lines.push(...itemLines(config, lc, deps.pluginList ?? pluginList));
  const pr = config.preset;
  if (pr) lines.push(`Preset: ${pr.id}`, ...m.files.filter((f) => f.item === `${PRESET_ITEM}${pr.id}`).map((f) => `  ${f.rel}`));
  lines.push('Last day');
  lines.forEach((l) => out(l));
  return stats(['--days', '1'], cli);
}

/** Whether each blocking event runs the dispatcher with onFailure "block" (no template read: status ships alone). */
function blocksOnFailure(root: string): boolean {
  let hooks: any;
  try {
    hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'))?.hooks;
  } catch {
    return false;
  }
  return BLOCKING.every((ev) => Array.isArray(hooks?.[ev]) && hooks[ev].some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => isHarnessHook(h) && h.onFailure === 'block')));
}

/** Catalog version, selected items, and plugins not installed. A catalog that fails to load adds nothing. */
function itemLines(config: ReturnType<typeof loadConfig>['config'], lc: LoadedCatalog, list: typeof pluginList): string[] {
  if (lc.errors.length) return [];
  const ids = selectedIds(config);
  const lines = [`Catalog ${config.catalog_version}`, `Items: ${ids.length} selected`];
  const wanted = pinnedPlugins(lc.catalog.items.filter((i) => ids.includes(i.id))).map((p) => `${p.name}@harness-pins`);
  if (wanted.length) {
    const have = list(); // one call
    lines.push(have ? `Plugins not installed: ${wanted.filter((id) => !have.some((p) => p.id === id)).length}` : 'Plugins not installed: unknown (claude not found)');
  }
  return lines;
}
