import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument, type Document } from 'yaml';
import { join } from 'node:path';
import { packageDir } from '../core/package-dir.js';
import type { HarnessConfig } from '../core/config.js';
import { serializeConfig } from '../core/config-io.js';
import type { Change } from './apply.js';
import { lineHunks, revertHunks } from './diff.js';
import { prettierFormat, repoPrettier } from './format.js';
import type { Facts } from './detect.js';
import type { Catalog } from '../catalog/schema.js';
import { eolOf, withEol } from './text.js';
import type { Manifest } from './manifest.js';
import { STRUCTURAL, pinnedPlugins, type PinnedPlugin } from './merge.js';
import type { LoadedPreset } from '../catalog/presets.js';
import { type McpServer, type Plan, newPlan, planAgents, planAi, planIgnores, planMcp, planOwnFiles, planPresetFiles, planSettings, planTests } from './plan-steps.js';

/** The own items a config without `items` (every install before the recommend flow) always has. */
export const LEGACY_OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'pr-ship', 'agents-md'];
// The own files of the legacy items, for a plan without a catalog.
const LEGACY_FILES = [
  { id: 'staff-reviewer', from: 'agents/staff-reviewer.md', to: '.claude/agents/staff-reviewer.md' },
  { id: 'review-rubric', from: 'skills/review-rubric/SKILL.md', to: '.claude/skills/review-rubric/SKILL.md' },
  { id: 'pr-ship', from: 'skills/pr-ship/SKILL.md', to: '.claude/skills/pr-ship/SKILL.md' },
];

/** The ids with `selected: true`; the legacy own items when the config has no items. */
export const selectedIds = (config: HarnessConfig): string[] => (config.items.length ? config.items.filter((i) => i.selected).map((i) => i.id) : [...LEGACY_OWN]);

/** Sets in `doc` only the leaves of `want` that differ from `cur`, descending into maps, so the person's comments inside them survive. */
function setChanged(doc: Document, path: (string | number)[], cur: any, want: any): void {
  const map = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  // `items`: rows are matched by id, so a comment on an untouched row survives; a dropped or reordered row replaces the list.
  const ids = (l: any[]) => l.map((r) => r?.id);
  if (path.length === 1 && path[0] === 'items' && Array.isArray(cur) && cur.length > 0 && Array.isArray(want) && ids(cur).every((id) => ids(want).includes(id))) {
    cur.forEach((row, i) => setChanged(doc, ['items', i], row, want[ids(want).indexOf(row.id)]));
    for (const row of want) if (!ids(cur).includes(row.id)) doc.addIn(['items'], row);
    if (isDeepStrictEqual(ids(doc.toJS().items), ids(want))) return;
  }
  if (map(want) && map(cur)) {
    for (const k of Object.keys(want)) setChanged(doc, [...path, k], cur[k], want[k]);
    if (path.length === 0 && 'preset' in cur && !('preset' in want)) doc.deleteIn(['preset']); // preset turned off
  } else if (!isDeepStrictEqual(cur, want)) doc.setIn(path, want);
}

export { ESLINT } from './plan-steps.js';
const EXEC_MODE = 0o755;

type PlanCtx = { version: string; distDir: string; templatesDir?: string; legacyDir?: string; recorded?: string[]; catalog?: Catalog; mcpRecorded?: string[]; recordedFiles?: Manifest['files']; /** The loaded `config.preset`; without it a recorded preset is left alone. */ preset?: LoadedPreset; ai?: { picks: string; report: string; product: string } };

/**
 * Every file init (and update) would write, as Change[]: `create` when the file is absent, `update` when its
 * content differs, nothing when it would be unchanged. Reads the repo but never writes. Throws MergeError on a
 * file it cannot merge safely.
 */
export function planChanges(
  root: string,
  config: HarnessConfig,
  facts: Facts,
  /** `legacyDir`: update's old results folder; a package whose results file still names it is migrated, TDD on or off.
   * `recorded`: the settings blocks the manifest holds, so update replaces harness's own old hook groups in place. */
  ctx: PlanCtx,
): { changes: Change[]; manual: string[]; notes: string[]; dropped: string[]; /** The config as written: checks follow the selection on the AI path. */ config: HarnessConfig } {
  const templatesDir = ctx.templatesDir ?? packageDir('templates');
  const p = newPlan(root, ctx.recordedFiles);
  const g = gateItems(config, ctx, p.notes);
  config = g.config;
  planConfig(p, config, ctx, g.catalog);
  // LF whatever the package checkout uses (a Windows clone may have CRLF), so the bytes and the manifest hash are the same everywhere.
  const tpl = (...parts: string[]) => readFileSync(join(templatesDir, ...parts), 'utf8').replace(/\r\n/g, '\n');
  const ownFiles = g.catalog
    ? g.catalog.items.flatMap((i) => (i.source.type === 'own' ? (i.source.files ?? []).map((f) => ({ id: i.id, ...f })) : []))
    : LEGACY_FILES;
  planOwnFiles(p, ownFiles, { on: g.on, tpl, tagged: !!g.catalog });
  const lp = config.preset ? ctx.preset : undefined;
  planPresetFiles(p, config.preset, lp, ctx.recordedFiles);
  const dropped = planSettings(p, { config, selected: selectedIds(config), plugins: [...pinnedPlugins(g.chosen), ...g.keepPlugins], lp, recorded: ctx.recorded });
  const servers = [...g.chosen.flatMap((i) => (i.kind === 'mcp' && i.mcp ? [{ name: i.mcp.name, item: i.id, config: i.mcp.config }] : [])), ...g.keepServers];
  if (g.catalog && (servers.length || ctx.mcpRecorded?.length)) planMcp(p, servers, ctx.mcpRecorded, dropped);
  planAgents(p, { harness: g.on('agents-md'), lp, preset: config.preset });
  planIgnores(p, facts);
  planTests(p, facts, config, { legacyDir: ctx.legacyDir, tpl });
  if (ctx.ai) planAi(p, facts, ctx.ai);
  formatEdits(root, p.changes, p.notes);
  return { changes: p.changes, manual: p.manual, notes: p.notes, dropped, config };
}

/** The selection gates the own items. Without a catalog or items nothing is gated: the beta behaviour. */
function gateItems(config: HarnessConfig, ctx: PlanCtx, notes: string[]): Gate {
  const catalog = config.items.length ? ctx.catalog : undefined;
  const ids = new Set(selectedIds(config));
  const on = (id: string) => !catalog || ids.has(id);
  const chosen = catalog ? catalog.items.filter((i) => ids.has(i.id)) : [];
  const kept = catalog ? keptItems(catalog, ids, ctx, notes) : { keepPlugins: [], keepServers: [] };
  return { catalog, on, chosen, config: catalog ? { ...config, checks: checksOf(chosen) } : config, ...kept };
}

type Gate = { catalog?: Catalog; on: (id: string) => boolean; chosen: Catalog['items']; config: HarnessConfig; keepPlugins: PinnedPlugin[]; keepServers: McpServer[] };

/** checks come from the selected own items (any kind); sandbox is not derived */
function checksOf(chosen: Catalog['items']): HarnessConfig['checks'] {
  const checks = { guard: false, protect: false, depVerify: false, multiFile: false, tdd: false, stop: false, prSize: false, decisions: false };
  for (const i of chosen) if (i.source.type === 'own') for (const k of i.source.checks ?? []) checks[k] = true;
  return checks;
}

/** An id the catalog no longer has keeps its plugin or server: it is rebuilt from what the manifest recorded. */
function keptItems(catalog: Catalog, ids: Set<string>, ctx: PlanCtx, notes: string[]): { keepPlugins: PinnedPlugin[]; keepServers: McpServer[] } {
  const keepPlugins: PinnedPlugin[] = [];
  const keepServers: McpServer[] = [];
  const parse = (bs: string[] = []) => bs.flatMap((b) => { try { return [JSON.parse(b)]; } catch { return []; } });
  const market = parse(ctx.recorded).find((r) => r.marketplace)?.entry?.source?.plugins ?? [];
  for (const id of ids) {
    if (catalog.items.some((i) => i.id === id)) continue;
    notes.push(`Item "${id}" is not in this catalog; left as is.`);
    for (const r of parse(ctx.recorded)) {
      const name = typeof r.plugin === 'string' ? r.plugin.split('@')[0] : '';
      const e = r.item === id ? market.find((x: any) => x.name === name) : undefined;
      if (e) keepPlugins.push({ name, item: id, source: e.source, ...(e.lspServers ? { lspServers: e.lspServers } : {}) });
    }
    for (const r of parse(ctx.mcpRecorded)) if (r.item === id && typeof r.mcp === 'string') keepServers.push({ name: r.mcp, item: id, config: r.server });
  }
  return { keepPlugins, keepServers };
}

/** The dispatcher and `.harness/config.yaml`; on the AI path only the sections that differ are set, so comments survive. */
function planConfig(p: Plan, config: HarnessConfig, ctx: PlanCtx, catalog: Catalog | undefined): void {
  p.put('.harness/hooks/dispatch.mjs', readFileSync(join(ctx.distDir, 'hooks', 'dispatch.mjs'), 'utf8'), { mode: EXEC_MODE });
  const cfgBefore = p.read('.harness/config.yaml');
  let cfgText = serializeConfig(config, ctx.version);
  let rewritten = false;
  if (catalog && cfgBefore !== null) {
    // The person's text stays: only the top-level sections that differ are set, so their comments survive.
    const doc = parseDocument(cfgBefore);
    if (doc.errors.length) { rewritten = true; p.notes.push('`.harness/config.yaml` could not be parsed; it is rewritten from the selection and its comments are not kept.'); }
    else {
      setChanged(doc, [], doc.toJS() ?? {}, JSON.parse(JSON.stringify(config)));
      cfgText = withEol(doc.toString(), eolOf(cfgBefore));
    }
  }
  p.put('.harness/config.yaml', cfgText);
  const cfgChange = p.changes.at(-1);
  if (catalog && cfgChange?.kind === 'update' && cfgChange.rel === '.harness/config.yaml' && rewritten) cfgChange.rewrite = true;
}

const JS = /\.[cm]?[jt]s$/;
/**
 * Runs the repo's own Prettier on the JS/TS configs harness edits, so `prettier --check` stays clean. Only a file that
 * was Prettier-clean before is formatted (anything else would reformat the user's code), and only when the formatted
 * edit undoes cleanly. A failure leaves the edit unformatted, with a note.
 */
function formatEdits(root: string, changes: Change[], notes: string[]): void {
  for (const c of changes) {
    // Settings blocks are structural (uninstall removes them by deep equality), so formatting keeps them as they are.
    if (STRUCTURAL.has(c.rel) && (c.kind === 'create' || c.kind === 'update')) {
      formatStructural(root, c, notes);
      continue;
    }
    if (c.kind !== 'update' || c.rename || !JS.test(c.rel)) continue; // a rename is a plain substitution (ruling 6)
    if (c.rel.startsWith('.harness/')) continue; // harness's own files are written as built: update replacing the dispatcher must not format it
    formatJsEdit(root, c, notes);
  }
}

const firstLine = (e: unknown): string => String((e as Error).message).split('\n')[0];

/** A settings file: formatted whole when created, or when it was Prettier-clean before. */
function formatStructural(root: string, c: Change, notes: string[]): void {
  const bin = repoPrettier(root, c.rel);
  try {
    if (bin && c.kind === 'create') c.content = prettierFormat(bin, root, c.rel, c.content);
    else if (bin && c.kind === 'update' && prettierFormat(bin, root, c.rel, c.before) === c.before) c.after = prettierFormat(bin, root, c.rel, c.after);
  } catch (e) {
    notes.push(`Prettier could not format \`${c.rel}\` (${firstLine(e)}); it is left unformatted, so a format check may flag it.`);
  }
}

/** A JS/TS config edit: formatted only when it was Prettier-clean before and the formatted edit undoes cleanly. */
export function formatJsEdit(root: string, c: Extract<Change, { kind: 'update' }>, notes: string[]): void {
  const bin = repoPrettier(root, c.rel);
  if (!bin) return;
  try {
    if (prettierFormat(bin, root, c.rel, c.before) !== c.before) return;
    const after = prettierFormat(bin, root, c.rel, c.after);
    if (after === c.after) return;
    const replace = lineHunks(c.before, after);
    if (revertHunks(after, replace) !== c.before) throw new Error('the formatted edit does not undo cleanly');
    Object.assign(c, { after, blocks: [], replace, formatted: true });
  } catch (e) {
    c.unformatted = true;
    notes.push(`Prettier could not format \`${c.rel}\` (${firstLine(e)}); the edit is left unformatted, so a format check may flag it.`);
  }
}
