import type { Picks } from '../ai/picks.js';
import { conflictPairs, requiresClosure } from '../catalog/relations.js';
import type { Catalog, OutsideSource } from '../catalog/schema.js';
import { esc, type Selected } from '../core/config.js';
import { itemContext, itemContextLine } from '../budget/measure.js';
import { olderThan } from '../core/min-claude.js';

export interface ChecklistRow {
  id: string; title: string; include: 'recommended' | 'optional'; ticked: boolean; reason: string; cost: string;
  /** From itemContextLine. */
  context: string;
  side_effects: string[]; /** 'Runs unpinned code at launch.' when the catalog marks the item unpinned_runtime, else ''. */ unpinned: string; unpinned_reason: string; local_only: boolean; stance_reason: string; no_alternative: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One row per pick: recommended first (ticked), then optional, each by id. Picks are validated, so ids exist. */
export function checklist(p: Picks, c: Catalog, dirs: { templates: string }): ChecklistRow[] {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  return p.items
    .filter((x) => byId.has(x.id))
    .sort((a, b) => cmp(a.include, b.include) * -1 || cmp(a.id, b.id)) // 'recommended' > 'optional' alphabetically, so reversed
    .map((x) => {
      const it = byId.get(x.id)!;
      return {
        id: x.id, title: it.title, include: x.include, ticked: x.include === 'recommended', reason: x.reason,
        cost: `context ${it.cost.context}, setup ${it.cost.setup}`, context: itemContextLine(itemContext(it, dirs)), side_effects: it.side_effects,
        unpinned: it.unpinned_runtime ? 'Runs unpinned code at launch.' : '', unpinned_reason: it.unpinned_runtime ?? '',
        local_only: it.kind === 'plugin' || it.kind === 'external-skill', stance_reason: it.stance_reason, no_alternative: x.no_alternative ?? '',
      };
    });
}

/** Errors for chosen ids the reviewer never picked. Ids that a picked, chosen item requires are allowed. */
export function notPicked(chosen: string[], p: Picks, c: Catalog): string[] {
  const picked = new Set(p.items.map((x) => x.id));
  const allowed = new Set([...picked, ...requiresClosure(chosen.filter((id) => picked.has(id)), c).ids]);
  return chosen.filter((id) => !allowed.has(id)).map((id) => `"${esc(id)}" was not in the picks; run the recommend step again or pick from the checklist.`);
}

/** Adds requires, drops items the installed Claude Code is too old for, and reports conflicts. */
export function resolveSelection(chosen: string[], c: Catalog, claudeVersion: string | null): { ids: string[]; notices: string[]; errors: string[] } {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const unknown = chosen.filter((id) => !byId.has(id));
  if (unknown.length) return { ids: [], notices: [], errors: unknown.map((id) => `Unknown item "${esc(id)}".`) };
  const { ids: all, added } = requiresClosure([...new Set(chosen)], c);
  const dropped = new Set<string>();
  const notices: string[] = claudeVersion === null ? ['Claude Code version unknown; not checking which items need a newer Claude Code.'] : [];
  const tooNew = (id: string) => claudeVersion !== null && olderThan(claudeVersion, byId.get(id)!.min_claude_code);
  for (const id of all) if (tooNew(id)) {
    dropped.add(id);
    notices.push(`Skipped ${id}: needs Claude Code ${byId.get(id)!.min_claude_code} or newer (you have ${claudeVersion}).`);
  }
  // A dependent without its requirement would install half a feature: drop it too, until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of all) {
      const dep = dropped.has(id) ? undefined : byId.get(id)!.requires.find((r) => dropped.has(r));
      if (dep) changed = !!dropped.add(id), notices.push(`Skipped ${id}: requires ${dep}, which needs a newer Claude Code.`);
    }
  }
  const ids = all.filter((id) => !dropped.has(id));
  if (!ids.length && all.length) return { ids, notices, errors: ['Nothing is left to install: every chosen item was skipped.'] };
  const addedNotices = added.filter((a) => !dropped.has(a.id)).map((a) => `Added ${a.id} because ${a.by} requires it.`);
  return { ids, notices: [...addedNotices, ...notices], errors: conflictPairs(ids, c).map(([a, b]) => `${a} and ${b} conflict; pick one.`) };
}

export const pinOf = (s: object): string => ((s as OutsideSource & { sha?: string; version?: string }).sha ?? (s as { version?: string }).version ?? '');

/** Every pick (selected when chosen) plus every id that requires pulled in. */
export function toSelected(p: Picks, ids: string[], c: Catalog): Selected[] {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const chosen = new Set(ids);
  const picked = new Set(p.items.map((x) => x.id));
  const pin = (id: string) => pinOf(byId.get(id)?.source ?? {});
  const rows: Selected[] = p.items.map((x) => ({ id: x.id, include: x.include, selected: chosen.has(x.id), reason: x.reason, addresses: x.addresses, pin: pin(x.id) }));
  for (const id of ids) if (!picked.has(id)) {
    const by = ids.find((o) => o !== id && byId.get(o)?.requires.includes(id));
    rows.push({ id, include: 'optional', selected: true, reason: by ? `Required by ${by}.` : 'Chosen by you.', addresses: [], pin: pin(id) });
  }
  return rows;
}
