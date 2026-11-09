import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from '../core/config.js';
import type { LoadedPreset } from '../catalog/presets.js';
import { ApplyError, type Change } from './apply.js';
import type { Facts } from './detect.js';
import { factsJson } from './facts.js';
import { finalizeReport } from '../ai/report.js';
import { matchesHash } from './text.js';
import { backupText, type Manifest } from './manifest.js';
import { removeBlocks, mergeClaudeMd, mergeEslintFlatIgnores, mergeGitignore, mergeIgnoreFile, mergeMcp, mergeSettings, type PinnedPlugin } from './merge.js';
import { PRESET_ITEM, mergeAgentsFile, mergeSettingsPreset, presetFiles } from './plan-preset.js';
import { JEST_REPORTER, resultsRename, testConfigChange } from './test-config.js';

export const ESLINT = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts'];

type Entry = Manifest['files'][number];
export interface PutOpts { blocks?: string[]; mode?: number; item?: string }
export type McpServer = { name: string; item: string; config: Record<string, unknown> };

/** The plan being built: what it writes, what is left by hand, its notes, and how it reads the repo and the manifest. */
export interface Plan {
  root: string;
  changes: Change[];
  manual: string[];
  notes: string[];
  read: (rel: string) => string | null;
  /** `create` when the file is absent, `update` when its content differs, nothing when it would be unchanged. */
  put: (rel: string, after: string, o?: PutOpts) => void;
  entryOf: (rel: string) => Entry | undefined;
  backupOf: (e: Entry | undefined) => string | null;
  /** Deselected: the manifest decides. Only a file harness wrote and the person left alone is removed or restored. */
  dropOwn: (rel: string, who: string) => void;
}

/** The memory files harness merges into: a symlink there is refused, dry runs included. */
const MEMORY_FILES = new Set(['AGENTS.md', 'CLAUDE.md']);

export function newPlan(root: string, recordedFiles?: Manifest['files']): Plan {
  const changes: Change[] = [];
  const notes: string[] = [];
  const read = (rel: string): string | null => {
    // Refused before reading, as apply would refuse the write: a link's target (a dotenv file, say) never reaches a diff.
    if (MEMORY_FILES.has(rel) && lstatSync(join(root, rel), { throwIfNoEntry: false })?.isSymbolicLink()) throw new ApplyError(`refusing symlink: ${rel}`);
    return existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null;
  };
  const put = (rel: string, after: string, { blocks = [], mode, item }: PutOpts = {}) => {
    const before = read(rel);
    const it = item ? { item } : {};
    if (before === null) changes.push({ kind: 'create', rel, content: after, ...(mode ? { mode } : {}), ...(blocks.length ? { blocks } : {}), ...it });
    // A CRLF checkout of an LF file (core.autocrlf) is unchanged; merged files already keep the file's own EOL.
    else if (before.replace(/\r\n/g, '\n') !== after.replace(/\r\n/g, '\n')) changes.push({ kind: 'update', rel, before, after, blocks, ...it });
  };
  const entryOf = (rel: string) => recordedFiles?.find((f) => f.rel === rel);
  const backupOf = (e: Entry | undefined) => backupText(root, e?.backup);
  const dropOwn = (rel: string, who: string) => {
    const cur = read(rel);
    if (cur === null) return;
    const e = entryOf(rel);
    const backup = backupOf(e);
    if (e?.kind === 'create' && matchesHash(cur, e.hash)) changes.push({ kind: 'delete', rel, before: cur });
    else if (e?.kind === 'update' && matchesHash(cur, e.hash) && backup !== null) changes.push({ kind: 'update', rel, before: cur, after: backup, blocks: [], restored: e.backup });
    else if (e?.kind === 'update' && matchesHash(cur, e.hash)) notes.push(`\`${rel}\`: its backup is missing, so the file you had before init cannot be restored; kept although ${who} is no longer selected.`);
    else notes.push(e ? `\`${rel}\` was edited since harness wrote it; it is kept although ${who} is no longer selected.` : `\`${rel}\` is not recorded as written by harness; it is kept although ${who} is no longer selected.`);
  };
  return { root, changes, manual: [], notes, read, put, entryOf, backupOf, dropOwn };
}

/** The own items' files: written when selected, dropped (by the manifest's rules) when not. */
export function planOwnFiles(p: Plan, files: { id: string; from: string; to: string }[], o: { on: (id: string) => boolean; tpl: (...p: string[]) => string; tagged: boolean }): void {
  for (const f of files) {
    if (o.on(f.id)) p.put(f.to, o.tpl(...f.from.split('/')), { item: o.tagged ? f.id : undefined });
    else p.dropOwn(f.to, f.id);
  }
}

/** The preset's skills; a config.preset whose folder was not loaded is left alone, a removed preset (or a gone stack) drops its files. */
export function planPresetFiles(p: Plan, preset: HarnessConfig['preset'], lp: LoadedPreset | undefined, recordedFiles?: Manifest['files']): void {
  const wanted = lp ? presetFiles(lp, preset!.items) : [];
  for (const f of wanted) p.put(f.to, f.content, { item: `${PRESET_ITEM}${lp!.preset.id}` });
  if (!preset || lp) for (const e of recordedFiles ?? []) if (e.item?.startsWith(PRESET_ITEM) && !wanted.some((f) => f.to === e.rel)) p.dropOwn(e.rel, `the ${e.item.slice(PRESET_ITEM.length)} preset`);
}

/** `.claude/settings.json` with harness's and the preset's blocks; returns the dropped blocks. */
export function planSettings(p: Plan, o: { config: HarnessConfig; selected: string[]; plugins: PinnedPlugin[]; lp?: LoadedPreset; recorded?: string[] }): string[] {
  const settings = mergeSettings(p.read('.claude/settings.json'), { sandbox: o.config.sandbox, recorded: o.recorded, plugins: o.plugins });
  const ps = mergeSettingsPreset(settings.after, { preset: o.lp, selected: o.selected, recorded: o.recorded ?? [], keep: !!o.config.preset && !o.lp });
  const dropped = [...settings.dropped, ...(ps?.dropped ?? [])];
  p.notes.push(...settings.notes, ...(ps?.notes ?? []));
  if (settings.blocks.length || ps?.blocks.length || dropped.length) { // leaving `always` drops set blocks with no replacement
    p.put('.claude/settings.json', ps?.after ?? settings.after, { blocks: [...settings.blocks, ...(ps?.blocks ?? [])] });
    const c = p.changes.at(-1);
    if (c?.kind === 'update' && c.rel === '.claude/settings.json' && dropped.length) c.dropped = [...dropped];
  }
  return dropped;
}

const isEmptyJson = (text: string): boolean => !Object.keys((() => { try { return JSON.parse(text); } catch { return { x: 1 }; } })()).length;

/** `.mcp.json` with the selected and kept servers; its dropped blocks join `dropped`. */
export function planMcp(p: Plan, servers: McpServer[], mcpRecorded: string[] | undefined, dropped: string[]): void {
  const mcp = mergeMcp(p.read('.mcp.json'), servers, mcpRecorded);
  p.notes.push(...mcp.notes);
  dropped.push(...mcp.dropped);
  if (!mcp.blocks.length && !mcp.dropped.length) return;
  p.put('.mcp.json', mcp.after, { blocks: mcp.blocks });
  const c = p.changes.at(-1);
  if (c?.kind === 'update' && c.rel === '.mcp.json' && mcp.dropped.length) c.dropped = mcp.dropped;
  // A harness-created .mcp.json that ends with nothing in it goes away.
  if (c?.kind === 'update' && c.rel === '.mcp.json' && p.entryOf('.mcp.json')?.kind === 'create' && isEmptyJson(c.after)) p.changes[p.changes.length - 1] = { kind: 'delete', rel: c.rel, before: c.before };
}

/** AGENTS.md is put once (harness and preset blocks together); CLAUDE.md points at it. */
export function planAgents(p: Plan, o: { harness: boolean; lp?: LoadedPreset; preset: HarnessConfig['preset'] }): void {
  if (o.harness || o.lp) {
    const agents = mergeAgentsFile(p.read('AGENTS.md'), { harness: o.harness, recorded: p.entryOf('AGENTS.md')?.blocks ?? [], preset: o.lp, keep: !!o.preset && !o.lp });
    p.put('AGENTS.md', agents.after, { blocks: agents.blocks });
    const claude = mergeClaudeMd(p.read('CLAUDE.md'), true); // init always creates or merges AGENTS.md
    if (claude) p.put('CLAUDE.md', claude.after, { blocks: claude.blocks });
  } else if (!o.preset) undoAgents(p); // a preset whose folder was not loaded leaves AGENTS.md as it is
}

/** Deselected: undo the merge as uninstall does (delete what harness created, restore the backup, else cut the blocks). */
function undoAgents(p: Plan): void {
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
    const e = p.entryOf(rel);
    const cur = p.read(rel);
    if (!e || cur === null || !e.blocks?.length) continue;
    const backup = p.backupOf(e);
    if (e.kind === 'create' && matchesHash(cur, e.hash)) p.changes.push({ kind: 'delete', rel, before: cur });
    else if (e.kind === 'update' && matchesHash(cur, e.hash) && backup !== null) p.changes.push({ kind: 'update', rel, before: cur, after: backup, blocks: [], restored: e.backup });
    else {
      const after = removeBlocks(cur, e.blocks);
      if (after !== cur) p.changes.push({ kind: 'update', rel, before: cur, after, blocks: [] });
      else p.notes.push(`\`${rel}\`: the harness block was not found; left as is.`);
    }
  }
}

/** `.harness/` in the ignore files the repo has (and the eslint flat config's ignores). */
export function planIgnores(p: Plan, facts: Facts): void {
  const ignore = (rel: string, m: { after: string; blocks: string[] }) => m.blocks.length && p.put(rel, m.after, { blocks: m.blocks });
  ignore('.gitignore', mergeGitignore(p.read('.gitignore')));
  // Prettier 3 reads .gitignore, but the committed .harness/ files are not in it, so they need .prettierignore.
  for (const rel of ['.prettierignore', '.eslintignore']) if (existsSync(join(p.root, rel)) || (rel === '.prettierignore' && facts.prettier)) ignore(rel, mergeIgnoreFile(p.read(rel), '.harness/'));
  const eslint = ESLINT.find((f) => existsSync(join(p.root, f)));
  if (eslint) {
    const m = mergeEslintFlatIgnores(p.read(eslint)!);
    if (m === null) p.manual.push(`${eslint}: add '.harness/' to the ignores array so linting skips the harness files`);
    else ignore(eslint, m);
  }
}

/** The Jest reporter, each package's results-folder rename, and (TDD on) its test config. */
export function planTests(p: Plan, facts: Facts, config: HarnessConfig, o: { legacyDir?: string; tpl: (...p: string[]) => string }): void {
  // Also when TDD is off: a left-out Jest package's manual lines point at the reporter.
  if (facts.packages.some((pkg) => pkg.test === 'jest')) p.put(JEST_REPORTER, o.tpl('hooks', 'jest-results.cjs'));
  for (const pkg of facts.packages) {
    const rename = o.legacyDir === undefined ? null : resultsRename(pkg, p.root, config.tdd.results_dir, o.legacyDir);
    if (rename) p.changes.push(rename); // ponytail: one change per package; a rename and another config edit take two update runs
    else if (config.checks.tdd) {
      const r = testConfigChange(pkg, p.root, config.tdd.results_dir);
      if ('change' in r) p.changes.push(r.change);
      else if ('manual' in r) p.manual.push(...r.manual);
    }
  }
}

/** The AI path's own files. */
export function planAi(p: Plan, facts: Facts, ai: { picks: string; report: string; product: string }): void {
  p.put('.harness/facts.json', factsJson(facts) + '\n');
  p.put('.harness/picks.json', ai.picks);
  p.put('.harness/report.md', finalizeReport(ai.report));
  p.put('.harness/context/product.md', ai.product);
}
