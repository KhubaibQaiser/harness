import { readFileSync } from 'node:fs';
import { esc } from '../core/config.js';
import type { Picks } from '../ai/picks.js';
import { PROJECT_TYPES } from '../catalog/schema.js';
import { loadCatalog } from '../catalog/load.js';
import { claudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { checkPreset, findPreset, loadPreset, presetRows } from '../catalog/presets.js';
import { detect } from '../install/detect.js';
import { checklist, notPicked, resolveSelection, toSelected } from '../install/select.js';
import type { CliEnv } from './index.js';

const ok = (x: any) => typeof x?.id === 'string' && (x.include === 'recommended' || x.include === 'optional') && typeof x.reason === 'string' && Array.isArray(x.addresses);
// JSON.stringify leaves C1 controls raw; escape them so picks text can't drive the terminal.
const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const USAGE = 'Usage: harness select --picks <file> [--preset <id> --answers <file>] [--choose <id,...>]';

/** Without --choose prints the checklist; with it prints { ids, notices, selected } or the errors (exit 2). Safe in a plain terminal. */
export function select(args: string[], { out, root }: CliEnv): number {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--picks', '--preset', '--answers', '--choose'].includes(args[i]) || i + 1 >= args.length || args[i] in flags) return out(USAGE), 2;
    flags[args[i]] = args[i + 1];
  }
  if (!flags['--picks'] || ('--preset' in flags) !== ('--answers' in flags)) return out(USAGE), 2;
  let picks: Picks;
  try {
    picks = JSON.parse(readFileSync(flags['--picks'], 'utf8'));
    if (!Array.isArray(picks?.items) || !Array.isArray(picks.findings) || !picks.items.every(ok)) throw new Error('malformed');
  } catch (e) {
    return out(`picks: could not read a picks file at "${esc(flags['--picks'])}" (${(e as NodeJS.ErrnoException).code ?? 'invalid'})`), 2;
  }
  const choose = '--choose' in flags ? flags['--choose'].split(',').filter(Boolean) : null;
  if (choose && !choose.length) return out(USAGE), 2;
  const { catalog, errors } = loadCatalog(packageDir('catalog'));
  if (errors.length) return errors.forEach((e) => out(`catalog: ${e}`)), 2;
  const unknown = picks.items.filter((x) => !catalog.items.some((i) => i.id === x.id));
  if (unknown.length) return unknown.forEach((x) => out(`picks: unknown item "${esc(x.id)}"`)), 2;
  const dirs = { templates: packageDir('templates') };
  let rows = checklist(picks, catalog, dirs);
  let own: string[] = [];
  const reasons: Record<string, string> = {};
  if ('--preset' in flags) {
    const id = flags['--preset'];
    const file = findPreset(id, root);
    if (!file) return out(`preset: "${esc(id)}" is not a shipped or repo preset (harness preset list shows them)`), 2;
    const lp = loadPreset(file);
    if (!lp.ok) return lp.errors.forEach((e) => out(`preset: ${e}`)), 2;
    let type: unknown;
    try { type = JSON.parse(readFileSync(flags['--answers'], 'utf8'))?.project?.type; } catch { /* reported below */ }
    if (typeof type !== 'string' || !(PROJECT_TYPES as string[]).includes(type)) return out(`answers: project.type in "${esc(flags['--answers'])}" must be one of ${PROJECT_TYPES.join(', ')}`), 2;
    const l = lp.loaded;
    const bad = checkPreset(l, catalog);
    if (bad.length) return bad.forEach((e) => out(`preset: ${e}`)), 2;
    own = [l.preset.core, ...l.items.map((i) => i.id)];
    const extra = presetRows(l, catalog, detect(root), type, picks.items.map((x) => x.id), dirs);
    extra.forEach((r) => { reasons[r.id] = r.reason; });
    rows = [...rows, ...extra];
  }
  if (!choose) return out(json(rows)), 0;
  const np = notPicked(choose, picks, catalog, Object.keys(reasons));
  if (np.length) return np.forEach((e) => out(e)), 2;
  const r = resolveSelection(choose.filter((id) => !own.includes(id)), catalog, claudeVersion());
  if (r.errors.length) return r.errors.forEach((e) => out(e)), 2;
  out(json({ ids: r.ids, notices: r.notices, selected: toSelected(picks, r.ids, catalog, reasons), ...(own.length ? { preset_items: choose.filter((id) => own.includes(id)) } : {}) }));
  return 0;
}
