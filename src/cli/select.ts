import { readFileSync } from 'node:fs';
import type { Picks } from '../ai/picks.js';
import { loadCatalog } from '../catalog/load.js';
import { claudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { checklist, resolveSelection, toSelected } from '../install/select.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness select --picks <file> [--choose <id,...>]';

/** Without --choose prints the checklist; with it prints { ids, notices, selected } or the errors (exit 2). Safe in a plain terminal. */
export function select(args: string[], { out }: CliEnv): number {
  if ((args.length !== 2 && args.length !== 4) || args[0] !== '--picks' || (args.length === 4 && args[2] !== '--choose')) return out(USAGE), 2;
  let picks: Picks;
  try {
    picks = JSON.parse(readFileSync(args[1], 'utf8'));
    if (!Array.isArray(picks?.items)) throw new Error('no items');
  } catch (e) {
    return out(`picks: could not read a picks file at ${JSON.stringify(args[1])} (${(e as NodeJS.ErrnoException).code ?? 'invalid'})`), 2;
  }
  const { catalog, errors } = loadCatalog(packageDir('catalog'));
  if (errors.length) return errors.forEach((e) => out(`catalog: ${e}`)), 2;
  if (args.length === 2) return out(JSON.stringify(checklist(picks, catalog), null, 2)), 0;
  const r = resolveSelection(args[3].split(',').filter(Boolean), catalog, claudeVersion());
  if (r.errors.length) return r.errors.forEach((e) => out(e)), 2;
  out(JSON.stringify({ ids: r.ids, notices: r.notices, selected: toSelected(picks, r.ids, catalog) }, null, 2));
  return 0;
}
