import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from '../catalog/load.js';
import { checkPreset, identityProblems, listPresets, loadPreset } from '../catalog/presets.js';
import type { Catalog } from '../catalog/schema.js';
import { CONTROL, esc } from '../core/config.js';
import { packageDir } from '../core/package-dir.js';
import type { CliEnv } from './index.js';

export const PRESET_USAGE = 'Usage: harness preset list\n       harness preset check <dir>';

/** Quotes stay readable; control and hidden characters become \uXXXX so an error line can't drive the terminal. */
const safe = (l: string): string => [...l].map((c) => (CONTROL.test(c) ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c)).join('');

/** Every error for each `<id>.yaml` in `dir`, as `<id>: <error>` lines. `builtOnly` adds the shipped-id rule. */
export function checkPresetDir(dir: string, catalog: Catalog, builtOnly: boolean): { id: string; errors: string[] }[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => {
    const r = loadPreset(join(dir, f));
    return { id: f.slice(0, -5), errors: (r.ok ? [...checkPreset(r.loaded, catalog, { builtOnly }), ...identityProblems(r.loaded)] : r.errors).map(safe) };
  });
}

export function preset(args: string[], { root, out }: CliEnv & { home?: string }): number {
  if (args[0] === 'list' && args.length === 1) {
    const all = listPresets(root);
    out(all.length ? all.map((p) => `${esc(p.id)}  ${esc(p.description)}${p.where === 'repo' ? '  (repo)' : ''}`).join('\n') : 'No presets.');
    return 0;
  }
  if (args[0] !== 'check' || args.length !== 2) return out(PRESET_USAGE), 2;
  const dir = args[1];
  try { if (!statSync(dir).isDirectory()) return out(`${esc(dir)}: not a folder`), 1; } catch { return out(`${esc(dir)}: no such folder`), 1; }
  const results = checkPresetDir(dir, loadCatalog(packageDir('catalog')).catalog, true);
  if (!results.length) return out(`${esc(dir)}: no <id>.yaml found`), 1;
  const errors = results.flatMap((r) => r.errors);
  out(errors.length ? errors.join('\n') : 'ok');
  return errors.length ? 1 : 0;
}
