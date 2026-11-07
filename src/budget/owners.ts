// Who owns each always-loaded file: harness, a catalog pick, the preset, or the repo itself. From the manifest only.
import type { Catalog } from '../catalog/schema.js';
import type { Manifest } from '../install/manifest.js';
import { PRESET_ITEM } from '../install/plan-preset.js';

export type Owner = 'harness' | 'repo' | `catalog:${string}` | `preset:${string}`;

function ownerOf(f: Manifest['files'][number], own: Set<string>): Owner {
  // A merged file with no item (CLAUDE.md, AGENTS.md) is the repo's text; harness's blocks in it are split out by measureRepo.
  if (!f.item) return f.blocks?.length ? 'repo' : 'harness';
  if (f.item.startsWith(PRESET_ITEM)) return f.item as Owner;
  return own.has(f.item) ? 'harness' : `catalog:${f.item}`;
}

export function ownersFrom(m: Manifest | null, c: Catalog | null): Map<string, Owner> {
  const own = new Set((c?.items ?? []).filter((i) => i.source.type === 'own').map((i) => i.id));
  return new Map((m?.files ?? []).filter((f) => f.kind !== 'delete').map((f) => [f.rel, ownerOf(f, own)]));
}

export const harnessShare = (o: Owner): boolean => o !== 'repo';
