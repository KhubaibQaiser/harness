import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
import type { Manifest } from './apply.js';
import { itemFiles } from './manifest.js';
import { selectedIds } from './plan.js';

/**
 * The selected ids harness installed (the person approved their cost then). A file or structural block in the manifest
 * names the item; an own item with no file of its own counts when its record is there: the agents-md block in the
 * manifest, or its checks on in the config. A selection made by hand and never applied is not approved.
 */
export function approvedIds(config: HarnessConfig, m: Manifest | null, cat: Catalog): string[] {
  if (!m) return [];
  return selectedIds(config).filter((id) => {
    if (itemFiles(m, id).length) return true;
    const src = cat.items.find((i) => i.id === id)?.source;
    if (src?.type !== 'own') return false;
    // A pre-catalog install recorded own files without an item tag: match them by path.
    if (src.files?.length) return src.files.every((f) => m.files.some((e) => e.rel === f.to));
    if (src.merge?.includes('agents-md')) return m.files.some((f) => (f.rel === 'AGENTS.md' || f.rel === 'CLAUDE.md') && f.blocks?.length);
    return !!src.checks?.length && src.checks.every((k) => config.checks[k]);
  });
}
