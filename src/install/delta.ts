import { conflictPairs } from '../catalog/relations.js';
import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
import type { Facts } from './detect.js';
import { pinOf } from './select.js';

/** What the catalog did to the installed selection. Retired = no longer in the catalog (the schema has no retired flag). */
export function catalogDelta(config: HarnessConfig, c: Catalog): { changed: string[]; retired: string[]; conflicting: [string, string][] } {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const retired = config.items.filter((i) => !byId.has(i.id)).map((i) => i.id);
  const changed = config.items.filter((i) => byId.has(i.id) && pinOf(byId.get(i.id)!.source) !== i.pin).map((i) => i.id);
  const conflicting = conflictPairs(config.items.filter((i) => i.selected && byId.has(i.id)).map((i) => i.id), c);
  return { changed, retired, conflicting };
}

const appKeys = (f: Facts) => f.apps.map((a) => `${a.dir}\0${a.kind}`).sort().join('\n');

/** The answer keys the facts now contradict; `prev` is null when .harness/facts.json is missing (nothing to compare, so nothing is re-asked). */
export function contradictions(prev: Facts | null, now: Facts, _config: HarnessConfig): string[] {
  if (!prev) return [];
  return [...(appKeys(prev) !== appKeys(now) ? ['apps'] : []), ...(prev.deploy.join() !== now.deploy.join() ? ['project.deploy_target'] : [])];
}
