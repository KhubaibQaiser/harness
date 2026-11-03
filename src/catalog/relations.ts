import type { Catalog } from './schema.js';

/** Conflicting pairs among `ids`, from either side's `conflicts_with`; each pair sorted, list sorted. */
export function conflictPairs(ids: string[], c: Catalog): [string, string][] {
  const set = new Set(ids);
  const pairs = new Map<string, [string, string]>();
  for (const it of c.items) {
    if (!set.has(it.id)) continue;
    for (const o of it.conflicts_with) if (set.has(o)) {
      const p = [it.id, o].sort() as [string, string];
      pairs.set(p.join('\0'), p);
    }
  }
  return [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

/** `ids` plus everything they transitively require; `added` says which item pulled each extra one in. */
export function requiresClosure(ids: string[], c: Catalog): { ids: string[]; added: { id: string; by: string }[] } {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const out = [...ids];
  const added: { id: string; by: string }[] = [];
  for (let i = 0; i < out.length; i++) {
    for (const r of byId.get(out[i])?.requires ?? []) if (!out.includes(r)) {
      out.push(r);
      added.push({ id: r, by: out[i] });
    }
  }
  return { ids: out, added };
}
