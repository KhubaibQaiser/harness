import { checkCatalog } from '../catalog/check.js';
import { compactCatalog, loadCatalog } from '../catalog/load.js';
import { resolvePins } from '../catalog/resolve.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness catalog\n       harness catalog check [--resolve] [--only <id,...>]';

export function catalog(args: string[], { out }: CliEnv, deps: { dir?: string; exec?: Exec } = {}): number {
  const { catalog: c, errors } = loadCatalog(deps.dir ?? packageDir('catalog'));
  if (!args.length) return out(JSON.stringify({ catalog_version: c.version, items: compactCatalog(c) }, null, 2)), 0;
  if (args[0] !== 'check') return out(USAGE), 2;
  let resolve = false;
  let only: string[] | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--resolve') resolve = true;
    else if (args[i] === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) only = args[++i].split(',').filter(Boolean);
    else return out(USAGE), 2;
  }
  if (only && !resolve) return out(USAGE), 2;
  const problems = [...errors, ...checkCatalog(c)];
  let unpinned: { id: string; reason: string }[] = [];
  if (resolve) {
    const r = resolvePins(c, deps.exec ?? defaultExec, only);
    problems.push(...r.problems);
    unpinned = r.unpinned;
  }
  problems.forEach((p) => out(p));
  if (unpinned.length) out(`Unpinned:\n${unpinned.map((u) => `  ${u.id}: ${u.reason}`).join('\n')}`);
  return problems.length ? 1 : 0;
}
