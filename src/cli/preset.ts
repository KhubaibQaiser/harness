import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadCatalog } from '../catalog/load.js';
import { checkPreset, identityProblems, listPresets, loadPreset } from '../catalog/presets.js';
import type { Catalog } from '../catalog/schema.js';
import { CONTROL, esc } from '../core/config.js';
import { packageDir } from '../core/package-dir.js';
import type { CliEnv } from './index.js';
import { NO_TTY, type Prompt } from './prompt.js';

export const PRESET_USAGE = 'Usage: harness preset list\n       harness preset check <dir>\n       harness preset install <dir> [--dry-run|--yes]';

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
  const r = checkDir(args[1], out);
  if (typeof r === 'number') return r;
  const errors = r.flatMap((x) => x.errors);
  out(errors.length ? errors.join('\n') : 'ok');
  return errors.length ? 1 : 0;
}

/** The folder's per-preset check results, or the exit code after printing why it can't be checked. */
function checkDir(dir: string, out: (s: string) => void): { id: string; errors: string[] }[] | number {
  try { if (!statSync(dir).isDirectory()) return out(`${esc(dir)}: not a folder`), 1; } catch { return out(`${esc(dir)}: no such folder`), 1; }
  const results = checkPresetDir(dir, loadCatalog(packageDir('catalog')).catalog, true);
  return results.length ? results : (out(`${esc(dir)}: no <id>.yaml found`), 1);
}

const filesUnder = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(d, e.name)) : [join(d, e.name)]));

/** `preset install <dir> [--dry-run|--yes]`: checks the folder, then copies each `<id>.yaml` and `<id>/` to `.harness/presets/`. */
export async function presetInstall(args: string[], cli: CliEnv & { prompt: Prompt }): Promise<number> {
  const { root, out } = cli;
  const flags = args.filter((a) => a.startsWith('--'));
  const dirs = args.filter((a) => !a.startsWith('--'));
  const dryRun = flags.includes('--dry-run'), yes = flags.includes('--yes');
  if (dirs.length !== 1 || flags.some((f) => f !== '--dry-run' && f !== '--yes') || (dryRun && yes)) return out(PRESET_USAGE), 2;
  const [dir] = dirs;
  const results = checkDir(dir, out);
  if (typeof results === 'number') return results;
  const errors = results.flatMap((r) => r.errors);
  if (errors.length) return out(errors.join('\n')), 1;
  const dest = join(root, '.harness', 'presets');
  const rel = (p: string) => relative(root, p).split('\\').join('/');
  for (const { id } of results) {
    const taken = [join(dest, id), join(dest, `${id}.yaml`)].find(existsSync);
    if (taken) return out(`${rel(taken)}${taken.endsWith('.yaml') ? '' : '/'} already exists; remove it first.`), 1;
  }
  const copies = results.flatMap(({ id }) => [[join(dir, `${id}.yaml`), join(dest, `${id}.yaml`)], ...(existsSync(join(dir, id)) ? filesUnder(join(dir, id)).map((f) => [f, join(dest, id, relative(join(dir, id), f))]) : [])]);
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;
  out(copies.map(([, to]) => rel(to)).join('\n'));
  if (dryRun) return 0;
  if (!yes) {
    if (!(await cli.prompt.confirm(`Copy these ${copies.length} files into .harness/presets/? [y/N]`))) return out('Cancelled. Nothing was written.'), 0;
  }
  // ponytail: the check and the copy read the tree at different times; safe unless someone races the person's own local install.
  for (const [from, to] of copies) { mkdirSync(join(to, '..'), { recursive: true }); cpSync(from, to); }
  return out(`Installed: ${results.map((r) => r.id).join(', ')}. Choose it in /harness:init or /harness:update.`), 0;
}
