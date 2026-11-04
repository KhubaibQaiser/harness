import { existsSync, readFileSync } from 'node:fs';
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
import { factsJson } from './facts.js';
import { finalizeReport } from '../ai/report.js';
import { matchesHash } from './text.js';
import type { Manifest } from './manifest.js';
import { STRUCTURAL, removeBlocks, mergeAgents, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeMcp, mergeSettings, pinnedPlugins, type PinnedPlugin } from './merge.js';
import { JEST_REPORTER, resultsRename, testConfigChange } from './test-config.js';

/** The own items a config without `items` (every install before the recommend flow) always has. */
export const LEGACY_OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'agents-md'];
// The own files of the legacy items, for a plan without a catalog.
const LEGACY_FILES = [
  { id: 'staff-reviewer', from: 'agents/staff-reviewer.md', to: '.claude/agents/staff-reviewer.md' },
  { id: 'review-rubric', from: 'skills/review-rubric/SKILL.md', to: '.claude/skills/review-rubric/SKILL.md' },
];

/** The ids with `selected: true`; the legacy own items when the config has no items. */
export const selectedIds = (config: HarnessConfig): string[] => (config.items.length ? config.items.filter((i) => i.selected).map((i) => i.id) : [...LEGACY_OWN]);

/** Sets in `doc` only the leaves of `want` that differ from `cur`, descending into maps, so the person's comments inside them survive. */
function setChanged(doc: Document, path: string[], cur: any, want: any): void {
  const map = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (map(want) && map(cur)) for (const k of Object.keys(want)) setChanged(doc, [...path, k], cur[k], want[k]);
  else if (!isDeepStrictEqual(cur, want)) doc.setIn(path, want);
}

export const ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];

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
  ctx: { version: string; distDir: string; templatesDir?: string; legacyDir?: string; recorded?: string[]; catalog?: Catalog; mcpRecorded?: string[]; recordedFiles?: Manifest['files']; ai?: { picks: string; report: string; product: string } },
): { changes: Change[]; manual: string[]; notes: string[]; dropped: string[] } {
  const templatesDir = ctx.templatesDir ?? packageDir('templates');
  const changes: Change[] = [];
  const manual: string[] = [];
  const notes: string[] = [];
  const read = (rel: string): string | null => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  const put = (rel: string, after: string, blocks: string[] = [], mode?: number, item?: string) => {
    const before = read(rel);
    const it = item ? { item } : {};
    if (before === null) changes.push({ kind: 'create', rel, content: after, ...(mode ? { mode } : {}), ...(blocks.length ? { blocks } : {}), ...it });
    // A CRLF checkout of an LF file (core.autocrlf) is unchanged; merged files already keep the file's own EOL.
    else if (before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')) changes.push({ kind: 'update', rel, before, after, blocks, ...it });
  };

  // The selection gates the own items. Without a catalog or items nothing is gated: the beta behaviour.
  const catalog = config.items.length ? ctx.catalog : undefined;
  const ids = new Set(selectedIds(config));
  const on = (id: string) => !catalog || ids.has(id);
  const chosen = catalog ? catalog.items.filter((i) => ids.has(i.id)) : [];
  // An id the catalog no longer has keeps its plugin or server: it is rebuilt from what the manifest recorded.
  const keepPlugins: PinnedPlugin[] = [];
  const keepServers: { name: string; item: string; config: Record<string, unknown> }[] = [];
  if (catalog) {
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
  }
  // checks come from the selected own items (any kind); sandbox is not derived
  if (catalog) {
    const checks = { guard: false, protect: false, depVerify: false, multiFile: false, tdd: false, stop: false };
    for (const i of chosen) if (i.source.type === 'own') for (const k of i.source.checks ?? []) checks[k] = true;
    config = { ...config, checks };
  }

  put('.harness/hooks/dispatch.mjs', readFileSync(join(ctx.distDir, 'hooks', 'dispatch.mjs'), 'utf8'), [], 0o755);
  const cfgBefore = read('.harness/config.yaml');
  let cfgText = serializeConfig(config, ctx.version);
  let rewritten = false;
  if (catalog && cfgBefore !== null) {
    // The person's text stays: only the top-level sections that differ are set, so their comments survive.
    const doc = parseDocument(cfgBefore);
    if (doc.errors.length) { rewritten = true; notes.push('`.harness/config.yaml` could not be parsed; it is rewritten from the selection and its comments are not kept.'); }
    else {
      setChanged(doc, [], doc.toJS() ?? {}, JSON.parse(JSON.stringify(config)));
      cfgText = doc.toString();
    }
  }
  put('.harness/config.yaml', cfgText);
  const cfgChange = changes.at(-1);
  if (catalog && cfgChange?.kind === 'update' && cfgChange.rel === '.harness/config.yaml' && rewritten) cfgChange.rewrite = true;
  // LF whatever the package checkout uses (a Windows clone may have CRLF), so the bytes and the manifest hash are the same everywhere.
  const tpl = (...p: string[]) => readFileSync(join(templatesDir, ...p), 'utf8').replace(/\r\n/g, '\n');
  const ownFiles = catalog
    ? catalog.items.flatMap((i) => (i.source.type === 'own' ? (i.source.files ?? []).map((f) => ({ id: i.id, ...f })) : []))
    : LEGACY_FILES;
  const entryOf = (rel: string) => ctx.recordedFiles?.find((f) => f.rel === rel);
  const backupOf = (e: Manifest['files'][number] | undefined) => (e?.backup ? read(e.backup) : null);
  for (const f of ownFiles) {
    if (on(f.id)) { put(f.to, tpl(...f.from.split('/')), [], undefined, catalog ? f.id : undefined); continue; }
    // Deselected: the manifest decides. Only a file harness wrote and the person left alone is removed or restored.
    const cur = read(f.to);
    if (cur === null) continue;
    const e = entryOf(f.to);
    const backup = backupOf(e);
    if (e?.kind === 'create' && matchesHash(cur, e.hash)) changes.push({ kind: 'delete', rel: f.to, before: cur });
    else if (e?.kind === 'update' && matchesHash(cur, e.hash) && backup !== null) changes.push({ kind: 'update', rel: f.to, before: cur, after: backup, blocks: [], restored: e.backup });
    else if (e?.kind === 'update' && matchesHash(cur, e.hash)) notes.push(`\`${f.to}\`: its backup is missing, so the file you had before init cannot be restored; kept although ${f.id} is no longer selected.`);
    else notes.push(e ? `\`${f.to}\` was edited since harness wrote it; it is kept although ${f.id} is no longer selected.` : `\`${f.to}\` is not recorded as written by harness; it is kept although ${f.id} is no longer selected.`);
  }

  const settings = mergeSettings(read('.claude/settings.json'), { sandbox: config.sandbox, recorded: ctx.recorded, plugins: [...pinnedPlugins(chosen), ...keepPlugins] });
  notes.push(...settings.notes);
  if (settings.blocks.length || settings.dropped.length) { // leaving `always` drops set blocks with no replacement
    put('.claude/settings.json', settings.after, settings.blocks);
    const c = changes.at(-1);
    if (c?.kind === 'update' && c.rel === '.claude/settings.json' && settings.dropped.length) c.dropped = settings.dropped;
  }

  const dropped = [...settings.dropped];
  const servers = [...chosen.flatMap((i) => (i.kind === 'mcp' && i.mcp ? [{ name: i.mcp.name, item: i.id, config: i.mcp.config }] : [])), ...keepServers];
  if (catalog && (servers.length || ctx.mcpRecorded?.length)) {
    const mcp = mergeMcp(read('.mcp.json'), servers, ctx.mcpRecorded);
    notes.push(...mcp.notes);
    dropped.push(...mcp.dropped);
    if (mcp.blocks.length || mcp.dropped.length) {
      put('.mcp.json', mcp.after, mcp.blocks);
      const c = changes.at(-1);
      if (c?.kind === 'update' && c.rel === '.mcp.json' && mcp.dropped.length) c.dropped = mcp.dropped;
    }
  }

  if (on('agents-md')) {
    const agents = mergeAgents(read('AGENTS.md'));
    put('AGENTS.md', agents.after, agents.blocks);
    const claude = mergeClaudeMd(read('CLAUDE.md'), true); // init always creates or merges AGENTS.md
    if (claude) put('CLAUDE.md', claude.after, claude.blocks);
  } else {
    // Deselected: undo the merge as uninstall does (delete what harness created, restore the backup, else cut the blocks).
    for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
      const e = entryOf(rel);
      const cur = read(rel);
      if (!e || cur === null || !e.blocks?.length) continue;
      const backup = backupOf(e);
      if (e.kind === 'create' && matchesHash(cur, e.hash)) changes.push({ kind: 'delete', rel, before: cur });
      else if (e.kind === 'update' && matchesHash(cur, e.hash) && backup !== null) changes.push({ kind: 'update', rel, before: cur, after: backup, blocks: [], restored: e.backup });
      else {
        const after = removeBlocks(cur, e.blocks);
        if (after !== cur) changes.push({ kind: 'update', rel, before: cur, after, blocks: [] });
        else notes.push(`\`${rel}\`: the harness block was not found; left as is.`);
      }
    }
  }

  const ignore = (rel: string, m: { after: string; blocks: string[] }) => m.blocks.length && put(rel, m.after, m.blocks);
  ignore('.gitignore', mergeGitignore(read('.gitignore')));
  // Prettier 3 reads .gitignore, but the committed .harness/ files are not in it, so they need .prettierignore.
  for (const rel of ['.prettierignore', '.eslintignore']) if (existsSync(join(root, rel)) || (rel === '.prettierignore' && facts.prettier)) ignore(rel, mergeIgnoreFile(read(rel), '.harness/'));
  const eslint = ESLINT.find((f) => existsSync(join(root, f)));
  if (eslint) {
    const m = mergeEslintFlatIgnores(read(eslint)!);
    if (m === null) manual.push(`${eslint}: add '.harness/' to the ignores array so linting skips the harness files`);
    else ignore(eslint, m);
  }

  // Also when TDD is off: a left-out Jest package's manual lines point at the reporter.
  if (facts.packages.some((p) => p.test === 'jest')) put(JEST_REPORTER, tpl('hooks', 'jest-results.cjs'));
  for (const pkg of facts.packages) {
    const rename = ctx.legacyDir === undefined ? null : resultsRename(pkg, root, config.tdd.results_dir, ctx.legacyDir);
    if (rename) changes.push(rename); // ponytail: one change per package; a rename and another config edit take two update runs
    else if (config.checks.tdd) {
      const r = testConfigChange(pkg, root, config.tdd.results_dir);
      if ('change' in r) changes.push(r.change);
      else if ('manual' in r) manual.push(...r.manual);
    }
  }
  if (ctx.ai) {
    put('.harness/facts.json', factsJson(facts) + '\n');
    put('.harness/picks.json', ctx.ai.picks);
    put('.harness/report.md', finalizeReport(ctx.ai.report));
    put('.harness/context/product.md', ctx.ai.product);
  }
  formatEdits(root, changes, notes);
  return { changes, manual, notes, dropped };
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
      const bin = repoPrettier(root, c.rel);
      try {
        if (bin && c.kind === 'create') c.content = prettierFormat(bin, root, c.rel, c.content);
        else if (bin && c.kind === 'update' && prettierFormat(bin, root, c.rel, c.before) === c.before) c.after = prettierFormat(bin, root, c.rel, c.after);
      } catch (e) {
        notes.push(`Prettier could not format \`${c.rel}\` (${String((e as Error).message).split('\n')[0]}); it is left unformatted, so a format check may flag it.`);
      }
      continue;
    }
    if (c.kind !== 'update' || c.rename || !JS.test(c.rel)) continue; // a rename is a plain substitution (ruling 6)
    if (c.rel.startsWith('.harness/')) continue; // harness's own files are written as built: update replacing the dispatcher must not format it
    const bin = repoPrettier(root, c.rel);
    if (!bin) continue;
    try {
      if (prettierFormat(bin, root, c.rel, c.before) !== c.before) continue;
      const after = prettierFormat(bin, root, c.rel, c.after);
      if (after === c.after) continue;
      const replace = lineHunks(c.before, after);
      if (revertHunks(after, replace) !== c.before) throw new Error('the formatted edit does not undo cleanly');
      Object.assign(c, { after, blocks: [], replace, formatted: true });
    } catch (e) {
      c.unformatted = true;
      notes.push(`Prettier could not format \`${c.rel}\` (${String((e as Error).message).split('\n')[0]}); the edit is left unformatted, so a format check may flag it.`);
    }
  }
}
