// The one offline always-loaded set every context-budget view reads (spec §3). measureRepo already counts every file
// harness installed (the agents-md block, installed skills), so the selection side adds only what is not a file in the
// repo: the harness plugin's own skills and agents, and catalog plugins, outside skills and MCP servers.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadCatalog, type LoadedCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import type { HarnessConfig } from '../core/config.js';
import { readManifest } from '../install/manifest.js';
import { selectedIds } from '../install/plan.js';
import { realIO, type RepoIO } from './imports.js';
import { measureSelectionSync } from './measure.js';
import { ownersFrom, type Owner } from './owners.js';
import { measureRepo, type SourceEntry } from './sources.js';

export const STATE_CARD_MAX_TOKENS = 300;
const BAD_CATALOG = "the catalog has errors; catalog picks not measured, and harness's share includes them";
const NO_TEXT_NOTE = 'size from the catalog record';
const PICK_KINDS = new Set(['plugin', 'external-skill', 'mcp']);

export interface ContextSet {
  always: SourceEntry[]; onDemand: SourceEntry[]; unmeasured: string[]; notes: string[];
  total: number; harness: number; catalog: number; repo: number; budget: number; method: 'estimate' | 'exact'; model: string | null;
}

export const repoOnly = (s: { always: SourceEntry[] }): SourceEntry[] => s.always.filter((e) => e.owner === 'repo');

/** `skills harness:a, b` plus the agents plugin.json registers. */
function pluginLabel(plugin: string): string {
  const skills = join(plugin, 'skills');
  let agents: string[] = [];
  try {
    agents = (JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) as { agents?: string[] }).agents ?? [];
  } catch { /* no readable manifest: skills only */ }
  const names = existsSync(skills) ? readdirSync(skills) : [];
  return `skills harness:${names.join(', ')}${agents.length ? ` + agents ${agents.map((a) => basename(a, '.md')).join(', ')}` : ''}`;
}

/** `catalog`: one already loaded (status shares its load). `catalogDir`: for tests. The bundled catalog by default. */
export function contextSet(root: string, config: HarnessConfig, dirs: { templates: string; plugin: string }, io: RepoIO = realIO, o: { catalog?: LoadedCatalog; catalogDir?: string } = {}): ContextSet {
  const loaded = o.catalog ?? loadCatalog(o.catalogDir);
  const cat: Catalog | null = loaded.errors.length ? null : loaded.catalog;
  // Without the catalog own items can't be told from picks; harness wrote every manifest file, so it owns them.
  const owners = ownersFrom(readManifest(root), cat);
  if (!cat) for (const [k, v] of owners) if (v.startsWith('catalog:')) owners.set(k, 'harness');
  const repo = measureRepo(root, { owners, preset: config.preset?.id ?? null }, io);
  const always = [...repo.always];
  const unmeasured = [...repo.unmeasured];
  const notes = [...repo.notes];
  if (!cat) notes.push(BAD_CATALOG);

  const byId = new Map((cat?.items ?? []).map((i) => [i.id, i]));
  const picks = selectedIds(config).filter((id) => PICK_KINDS.has(byId.get(id)?.kind ?? ''));
  // Own skills and the agents-md block are files measureRepo already read; the plugin row and the picks are the rest.
  const counted = new Set(always.map((e) => e.owner));
  const m = measureSelectionSync(picks, cat ?? { version: 1, items: [] }, dirs);
  for (const e of m.entries) {
    const isPlugin = e.id === 'harness-plugin';
    const owner: Owner = isPlugin ? 'harness' : `catalog:${e.id}`;
    if (!isPlugin && counted.has(owner)) continue; // a pick that left files in the repo is already in the repo rows
    if (e.tokens === null) { unmeasured.push(`plugin: ${e.id}`); continue; }
    const label = isPlugin ? pluginLabel(dirs.plugin) : e.id;
    // measureSelectionSync strips the text, so chars is 0 (ponytail: keep real chars only if measure.ts ever returns it); path is not a file.
    // A pick's tokens come from the catalog record; the plugin row is measured from harness's own files.
    always.push({ id: e.id, path: isPlugin ? 'plugin:harness' : owner, label, owner, load: 'always', tokens: e.tokens, chars: 0, ...(isPlugin ? {} : { note: NO_TEXT_NOTE }) });
  }

  return { always, onDemand: repo.onDemand, unmeasured, notes, ...ownerTotals(always), budget: config.context.budget_tokens, method: 'estimate', model: null };
}

/** The always-loaded total and its three shares; preset rows count with harness. */
export function ownerTotals(always: SourceEntry[]): Pick<ContextSet, 'total' | 'harness' | 'catalog' | 'repo'> {
  const sumOf = (f: (o: Owner) => boolean) => always.reduce((n, e) => n + (f(e.owner) ? e.tokens : 0), 0);
  const harness = sumOf((o) => o === 'harness' || o.startsWith('preset:'));
  const catalog = sumOf((o) => o.startsWith('catalog:'));
  const repo = sumOf((o) => o === 'repo');
  return { total: harness + catalog + repo, harness, catalog, repo };
}
