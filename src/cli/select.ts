import { readFileSync } from 'node:fs';
import { esc } from '../core/config.js';
import type { Picks } from '../ai/picks.js';
import { loadCatalog } from '../catalog/load.js';
import { claudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { checklist, resolveSelection, toSelected } from '../install/select.js';
import type { CliEnv } from './index.js';

const ok = (x: any) => typeof x?.id === 'string' && (x.include === 'recommended' || x.include === 'optional') && typeof x.reason === 'string' && Array.isArray(x.addresses);
// JSON.stringify leaves C1 controls raw; escape them so picks text can't drive the terminal.
const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const USAGE = 'Usage: harness select --picks <file> [--choose <id,...>]';

/** Without --choose prints the checklist; with it prints { ids, notices, selected } or the errors (exit 2). Safe in a plain terminal. */
export function select(args: string[], { out }: CliEnv): number {
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--picks' || (args.length === 4 && args[2] !== '--choose')) return out(USAGE), 2;
  let picks: Picks;
  try {
    picks = JSON.parse(readFileSync(args[1], 'utf8'));
    if (!Array.isArray(picks?.items) || !picks.items.every(ok)) throw new Error('malformed');
  } catch (e) {
    return out(`picks: could not read a picks file at "${esc(args[1])}" (${(e as NodeJS.ErrnoException).code ?? 'invalid'})`), 2;
  }
  const choose = args.length === 4 ? args[3].split(',').filter(Boolean) : null;
  if (choose && !choose.length) return out(USAGE), 2;
  const { catalog, errors } = loadCatalog(packageDir('catalog'));
  if (errors.length) return errors.forEach((e) => out(`catalog: ${e}`)), 2;
  if (!choose) return out(json(checklist(picks, catalog))), 0;
  const r = resolveSelection(choose, catalog, claudeVersion());
  if (r.errors.length) return r.errors.forEach((e) => out(e)), 2;
  out(json({ ids: r.ids, notices: r.notices, selected: toSelected(picks, r.ids, catalog) }));
  return 0;
}
