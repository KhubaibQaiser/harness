// Offline estimate of the context harness always loads. No network, no API key, no env or dotenv reads: the
// exact count (CountTokens, see count-api.ts) is opt-in through measureSelection's `count`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Catalog, CatalogItem } from '../catalog/schema.js';
import type { Owner } from './owners.js';
import { stripComments } from './text.js';

export const DEFAULT_CONTEXT_BUDGET = 2000;
const BLOCK_END = '<!-- harness:end -->';
/** Claude Code cuts a skill's description (plus when_to_use) at this many characters in the listing. */
export const SKILL_DESCRIPTION_MAX = 1536;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** Skills and agents load only their name and description before use (code.claude.com docs); the other two load whole. A skill adds when_to_use, is cut at SKILL_DESCRIPTION_MAX, and costs nothing with disable-model-invocation: true. */
export function alwaysLoadedText(kind: 'agents-block' | 'claude-import' | 'skill' | 'agent', text: string): string {
  if (kind === 'agents-block' || kind === 'claude-import') return text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  let y: Record<string, unknown> | null;
  try {
    y = parse(fm) as Record<string, unknown> | null;
  } catch {
    throw new Error('frontmatter does not parse'); // callers report the file as not measured; counting it raw would overstate
  }
  const str = (k: string): string | null => (y?.[k] != null ? String(y[k]).trim() : null);
  if (kind === 'skill') {
    if (y?.['disable-model-invocation'] === true) return '';
    const name = str('name');
    const desc = [str('description'), str('when_to_use')].filter((v) => v !== null).join(' ').slice(0, SKILL_DESCRIPTION_MAX);
    return [name !== null ? `name: ${name}` : null, desc ? `description: ${desc}` : null].filter((v) => v !== null).join('\n');
  }
  return (['name', 'description'] as const).filter((k) => y?.[k] != null).map((k) => `${k}: ${str(k)}`).join('\n');
}

/** `text` is what was measured, kept so an exact count can re-measure it; measureSelection strips it. */
export interface ContextEntry { id: string; tokens: number | null; exempt?: true; text?: string; owner?: Owner }
export interface ContextMeasure { entries: ContextEntry[]; tokens: number; unmeasured: string[]; method: 'estimate' | 'exact' }
export type CountTokens = (texts: { id: string; text: string }[]) => Promise<Record<string, number> | null>;

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export function itemContext(item: CatalogItem, dirs: { templates: string }): ContextEntry {
  const id = item.id;
  if (item.kind === 'plugin' || item.kind === 'external-skill') return { id, tokens: item.cost.context_tokens ?? null }; // recorded, no text: never replaced by an API count
  if (item.kind === 'mcp') return { id, tokens: null };
  if (item.source.type !== 'own') return { id, tokens: null };
  if (item.source.merge?.includes('agents-md')) {
    // Installed, these are two rows, each rounded: the block cut at its end marker (the newline after it is the repo's) and
    // the CLAUDE.md line. Measuring the same text the same way keeps the preview equal to the installed count. Markers count 0 (spec 3.4).
    const raw = read(join(dirs.templates, 'agents-block.md'));
    const end = raw.lastIndexOf(BLOCK_END);
    const parts = [stripComments(end < 0 ? raw : raw.slice(0, end + BLOCK_END.length)), '@AGENTS.md\n'];
    return { id, tokens: parts.reduce((n, t) => n + estimateTokens(t), 0), text: parts.join('') };
  }
  const kind = item.kind === 'own-skill' ? 'skill' : item.kind === 'own-agent' ? 'agent' : null;
  if (!kind) return { id, tokens: 0 }; // hooks, settings, ci: not loaded as text
  try {
    const loaded = (item.source.files ?? []).map((f) => alwaysLoadedText(kind, read(join(dirs.templates, f.from))));
    return { id, tokens: loaded.reduce((n, t) => n + estimateTokens(t), 0), text: loaded.join('\n') };
  } catch {
    return { id, tokens: null }; // unparseable frontmatter: not measured
  }
}

export function pluginEntry(plugin: string): ContextEntry {
  const root = join(plugin, 'skills');
  const names = existsSync(root) ? readdirSync(root) : [];
  // The agents plugin.json registers load their name and description too.
  let agents: string[] = [];
  try {
    agents = (JSON.parse(read(join(plugin, '.claude-plugin', 'plugin.json'))) as { agents?: string[] }).agents ?? [];
  } catch {
    // no readable manifest: count the skills only
  }
  const texts: ['skill' | 'agent', string][] = [...names.map((d): ['skill', string] => ['skill', read(join(root, d, 'SKILL.md'))]), ...agents.map((a): ['agent', string] => ['agent', read(join(plugin, a))])];
  try {
    const loaded = texts.map(([k, t]) => alwaysLoadedText(k, t));
    return { id: 'harness-plugin', tokens: loaded.reduce((n, t) => n + estimateTokens(t), 0), text: loaded.join('\n') };
  } catch {
    return { id: 'harness-plugin', tokens: null }; // a skill or agent whose frontmatter does not parse: not measured
  }
}

/** `extra` entries (measured elsewhere) are added as they are. `exempt` ids (items the person already approved) count in the total but are never unmeasured, so with the same ids on both sides of a verdict they never ask again. harness-plugin is never exempt. With `count`, every entry that kept its text is measured exactly in one call; a null answer leaves the estimate. */
export async function measureSelection(
  ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, opts: { count?: CountTokens; exempt?: string[]; extra?: ContextEntry[] } = {},
): Promise<ContextMeasure> {
  const entries = collect(ids, c, dirs, opts);
  const texts = entries.flatMap((e) => (e.text !== undefined && e.text !== '' && e.tokens !== null ? [{ id: e.id, text: e.text }] : []));
  const counts = opts.count && texts.length ? await opts.count(texts) : null;
  const counted = new Set<string>();
  if (counts) for (const { id } of texts) if (Object.hasOwn(counts, id)) { counted.add(id); }
  for (const e of entries) if (counted.has(e.id)) e.tokens = counts![e.id];
  // 'exact' only when every counted-in-principle entry got a count; a mix stays an estimate.
  const method: ContextMeasure['method'] = counts && entries.every((e) => !e.tokens || counted.has(e.id)) ? 'exact' : 'estimate';
  return { ...summarize(entries), method };
}

/** The same estimate without the async seam, for `status`. */
export function measureSelectionSync(
  ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, opts: { exempt?: string[]; extra?: ContextEntry[] } = {},
): ContextMeasure {
  return { ...summarize(collect(ids, c, dirs, opts)), method: 'estimate' };
}

function collect(ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, opts: { exempt?: string[]; extra?: ContextEntry[] }): ContextEntry[] {
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
  return entries;
}

function summarize(all: ContextEntry[]): Omit<ContextMeasure, 'method'> {
  const entries = all.map(({ text: _t, ...e }) => e);
  return {
    entries,
    tokens: entries.reduce((n, e) => n + (e.tokens ?? 0), 0),
    unmeasured: entries.filter((e) => e.tokens === null && !e.exempt).map((e) => e.id),
  };
}

export interface BudgetVerdict { budget: number; before: ContextMeasure; after: ContextMeasure; ask: boolean; added_unmeasured: string[] }

export function budgetVerdict(before: ContextMeasure, after: ContextMeasure, budget: number): BudgetVerdict {
  const added_unmeasured = after.unmeasured.filter((id) => !before.unmeasured.includes(id));
  const ask = (after.tokens > budget && after.tokens > before.tokens) || added_unmeasured.length > 0;
  return { budget, before, after, ask, added_unmeasured };
}

/** Whole tokens with thousands separators, as every context line prints them (spec §7.1). */
export const fmt = (n: number): string => n.toLocaleString('en-US');

export function budgetLines(v: BudgetVerdict): string[] {
  const approved = v.after.entries.filter((e) => e.exempt).map((e) => e.id);
  const h = v.after.entries.reduce((n, e) => n + (e.owner === 'repo' ? 0 : e.tokens ?? 0), 0);
  return [
    `Always-loaded context: ~${fmt(v.after.tokens)} tokens (${v.after.method}), budget ${fmt(v.budget)}; harness and its picks ~${fmt(h)}.`,
    ...(approved.length ? [`Approved earlier: ${approved.join(', ')}.`] : []),
    ...(v.added_unmeasured.length ? [`Not measured before install: ${v.added_unmeasured.join(', ')}.`] : []),
    ...(v.ask ? ['Over budget: confirm before installing.'] : []),
  ];
}

export const itemContextLine = (e: ContextEntry): string => (e.tokens === null ? 'not measured before install' : `~${e.tokens} tokens (estimate)`);
