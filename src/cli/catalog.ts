import { checkCatalog } from '../catalog/check.js';
import { compactCatalog, loadCatalog } from '../catalog/load.js';
import { resolvePins } from '../catalog/resolve.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import { checkPresetDir } from './preset.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness catalog\n       harness catalog check [--resolve] [--only <id,...>]';

export function catalog(args: string[], { out }: CliEnv, deps: { dir?: string; exec?: Exec } = {}): number {
  const { catalog: c, errors } = loadCatalog(deps.dir ?? packageDir('catalog'));
  if (!args.length) {
    if (errors.length) return errors.forEach((e) => out(e)), 1;
    return out(JSON.stringify({ catalog_version: c.version, items: compactCatalog(c) }, null, 2)), 0;
  }
  if (args[0] !== 'check') return out(USAGE), 2;
  let resolve = false;
  let only: string[] | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--resolve') resolve = true;
    else if (args[i] === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) only = args[++i].split(',').filter(Boolean);
    else return out(USAGE), 2;
  }
  if (only && (!resolve || !only.length)) return out(USAGE), 2;
  const problems = [...errors, ...checkCatalog(c)];
  const pd = join(deps.dir ?? packageDir('catalog'), 'presets');
  if (existsSync(pd)) for (const r of checkPresetDir(pd, c, false)) problems.push(...r.errors.map((e) => `presets/${r.id}: ${e}`));
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
