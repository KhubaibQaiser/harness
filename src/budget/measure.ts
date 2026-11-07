// Offline estimate of the context harness always loads. No network, no API key, no env or dotenv reads: the
// exact count (CountTokens) is the budget build's seam, and M3 never passes one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Catalog, CatalogItem } from '../catalog/schema.js';
import { LEGACY_OWN } from '../install/plan.js';

export const DEFAULT_CONTEXT_BUDGET = 2000;
/** Claude Code cuts a skill's description (plus when_to_use) at this many characters in the listing. */
export const SKILL_DESCRIPTION_MAX = 1536;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Skills and agents load only their name and description before use (code.claude.com docs); the other two load whole. A skill adds when_to_use, is cut at SKILL_DESCRIPTION_MAX, and costs nothing with disable-model-invocation: true. */
export function alwaysLoadedText(kind: 'agents-block' | 'claude-import' | 'skill' | 'agent', text: string): string {
  if (kind === 'agents-block' || kind === 'claude-import') return text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  try {
    const y = parse(fm) as Record<string, unknown> | null;
    const str = (k: string): string | null => (y?.[k] != null ? String(y[k]).trim() : null);
    if (kind === 'skill') {
      if (y?.['disable-model-invocation'] === true) return '';
      const desc = [str('description'), str('when_to_use')].filter((v) => v !== null).join(' ').slice(0, SKILL_DESCRIPTION_MAX);
      return [str('name') !== null ? `name: ${str('name')}` : null, desc ? `description: ${desc}` : null].filter((v) => v !== null).join('\n');
    }
    return (['name', 'description'] as const).filter((k) => y?.[k] != null).map((k) => `${k}: ${str(k)}`).join('\n');
  } catch {
    return fm; // unparseable frontmatter: count all of it; over-counting is safe
  }
}

export interface ContextEntry { id: string; tokens: number | null; exempt?: true }
export interface ContextMeasure { entries: ContextEntry[]; tokens: number; unmeasured: string[]; method: 'estimate' | 'exact' }
export type CountTokens = (texts: { id: string; text: string }[]) => Promise<Record<string, number> | null>;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export function itemContext(item: CatalogItem, dirs: { templates: string }): ContextEntry {
  const id = item.id;
  if (item.kind === 'plugin' || item.kind === 'external-skill' || item.kind === 'mcp') return { id, tokens: null };
  if (item.source.type !== 'own') return { id, tokens: null };
  if (item.source.merge?.includes('agents-md')) return { id, tokens: estimateTokens(read(join(dirs.templates, 'agents-block.md')) + '@AGENTS.md\n') };
  const kind = item.kind === 'own-skill' ? 'skill' : item.kind === 'own-agent' ? 'agent' : null;
  if (!kind) return { id, tokens: 0 }; // hooks, settings, ci: not loaded as text
  return { id, tokens: (item.source.files ?? []).reduce((n, f) => n + estimateTokens(alwaysLoadedText(kind, read(join(dirs.templates, f.from)))), 0) };
}

function pluginEntry(plugin: string): ContextEntry {
  const root = join(plugin, 'skills');
  const names = existsSync(root) ? readdirSync(root) : [];
  const skills = names.reduce((n, d) => n + estimateTokens(alwaysLoadedText('skill', read(join(root, d, 'SKILL.md')))), 0);
  // The agents plugin.json registers load their name and description too.
  let agents: string[] = [];
  try {
    agents = (JSON.parse(read(join(plugin, '.claude-plugin', 'plugin.json'))) as { agents?: string[] }).agents ?? [];
  } catch {
    // no readable manifest: count the skills only
  }
  return { id: 'harness-plugin', tokens: skills + agents.reduce((n, a) => n + estimateTokens(alwaysLoadedText('agent', read(join(plugin, a)))), 0) };
}

/** `extra` entries (measured elsewhere) are added as they are. `exempt` ids (items the person already approved) keep an entry but add nothing and are never unmeasured. harness-plugin is never exempt. */
export async function measureSelection(
  ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, opts: { count?: CountTokens; exempt?: string[]; extra?: ContextEntry[] } = {},
): Promise<ContextMeasure> {
  return measureSelectionSync(ids, c, dirs, opts);
}

/** The same estimate without the async seam, for `status`. */
export function measureSelectionSync(
  ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, opts: { exempt?: string[]; extra?: ContextEntry[] } = {},
): ContextMeasure {
  const byId = new Map(c.items.map((i) => [i.id, i]));
  const exempt = new Set(opts.exempt ?? []);
  const entries: ContextEntry[] = [pluginEntry(dirs.plugin)];
  for (const id of new Set(ids)) {
    const it = byId.get(id);
    if (!it) continue;
    const e = itemContext(it, dirs);
    entries.push(exempt.has(id) ? { ...e, exempt: true } : e);
  }
  entries.push(...(opts.extra ?? [])); // the preset's own rows, measured by presetContext
  // opts.count is the budget build's seam; with none (always, in M3) the estimate stands.
  return {
    entries,
    tokens: entries.reduce((n, e) => n + (e.exempt ? 0 : e.tokens ?? 0), 0),
    unmeasured: entries.filter((e) => e.tokens === null && !e.exempt).map((e) => e.id),
    method: 'estimate',
  };
}

export interface BudgetVerdict { budget: number; before: ContextMeasure; after: ContextMeasure; ask: boolean; added_unmeasured: string[] }

export function budgetVerdict(before: ContextMeasure, after: ContextMeasure, budget: number): BudgetVerdict {
  const added_unmeasured = after.unmeasured.filter((id) => !before.unmeasured.includes(id));
  const ask = (after.tokens > budget && after.tokens > before.tokens) || added_unmeasured.length > 0;
  return { budget, before, after, ask, added_unmeasured };
}

export function budgetLines(v: BudgetVerdict): string[] {
  const approved = v.after.entries.filter((e) => e.exempt).map((e) => e.id);
  return [
    `Always-loaded context from harness: ~${v.after.tokens} tokens (${v.after.method}), budget ${v.budget}.`,
    ...(approved.length ? [`Approved earlier, not counted: ${approved.join(', ')}.`] : []),
    ...(v.added_unmeasured.length ? [`Not measured before install: ${v.added_unmeasured.join(', ')}.`] : []),
    ...(v.ask ? ['Over budget: confirm before installing.'] : []),
  ];
}

export const itemContextLine = (e: ContextEntry): string => (e.tokens === null ? 'not measured before install' : `~${e.tokens} tokens (estimate)`);

/** Always-loaded tokens of the default install: the plugin plus the legacy own items. */
export const footprint = (dirs: { templates: string; plugin: string }, c: Catalog): number => measureSelectionSync(LEGACY_OWN, c, dirs).tokens;
