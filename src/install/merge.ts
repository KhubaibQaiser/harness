import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseModule } from 'magicast';
import { packageDir } from '../core/package-dir.js';
import { HARNESS_LOCAL } from '../core/paths.js';
import type { SandboxMode } from '../core/config.js';
import { denyWritePaths } from '../checks/protect.js';
import { eolOf, jsonIndentOf, quoteOf, requote, withEol } from './text.js';
import type { CatalogItem } from '../catalog/schema.js';
import type { Manifest } from './manifest.js';
import { TELEMETRY_ENV } from '../catalog/telemetry-env.js';
import type { LoadedPreset } from '../catalog/presets.js';

export class MergeError extends Error {
  constructor(message: string) { super(message); this.name = 'MergeError'; }
}

const template = (name: string): string => {
  const p = join(packageDir('templates'), name);
  if (!existsSync(p)) throw new MergeError(`template ${name} not found at ${p}`);
  return readFileSync(p, 'utf8');
};
export const settingsFragment = (): any => JSON.parse(template('settings.fragment.json'));

/**
 * Removes each text block from `after`: the last occurrence that starts at a line boundary, else the
 * last occurrence (init appends, so the last one is ours even if earlier user text contains it). For every
 * text merge except the AGENTS.md marker replace, this returns the pre-merge content byte for byte.
 * Settings blocks are structural JSON and are not removed this way.
 */
export function removeBlocks(after: string, blocks: string[]): string {
  let out = after;
  for (const block of blocks) {
    // The checkout may have other line endings than the install that recorded the block (core.autocrlf).
    const b = [block, block.replace(/\r?\n/g, '\r\n'), block.replace(/\r\n/g, '\n')].find((x) => out.includes(x)) ?? block;
    const last = out.lastIndexOf(b);
    let i = last;
    while (i > 0 && out[i - 1] !== '\n') i = out.lastIndexOf(b, i - 1);
    if (i === -1) i = last; // no occurrence at a line start: fall back to the last one
    if (i !== -1) out = out.slice(0, i) + out.slice(i + b.length);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const SETTINGS = '.claude/settings.json';
const bad = (msg: string): never => { throw new MergeError(`${SETTINGS}: ${msg}`); };

/** A harness hook runs the repo's dispatcher: `command`, or any string in `args`, names it. */
export const isHarnessHook = (h: unknown): boolean =>
  isObj(h) && [h.command, ...(Array.isArray(h.args) ? h.args : [])].some((x) => typeof x === 'string' && x.includes('.harness/hooks/dispatch.mjs'));

/** `s` as JSON text in the file's own indent and line endings (2 spaces and LF for a new file). */
const dump = (s: unknown, before: string | null): string => {
  const eol = before === null ? '\n' : eolOf(before);
  return withEol(JSON.stringify(s, null, before === null ? 2 : jsonIndentOf(before)), eol) + (before === null || /\n$/.test(before) ? eol : '');
};

const parse = (b: string): unknown => { try { return JSON.parse(b); } catch { return null; } };

// The `always` keys (owner ruling, 2026-11-13): the sandbox on for interactive sessions too, and a session refuses to
// run Bash unsandboxed rather than fall back. A teammate on a platform with no sandbox turns it off in their own
// `.claude/settings.local.json` (see the Sandbox section of docs/reference.md).
const SANDBOX = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false };
const NETWORK_NOTE = `${SETTINGS}: Claude Code's sandbox is on (sandbox: always). Its network allowlist starts empty, so a package install or an HTTPS git push asks the first time, and some tools fail inside it; allow a host under sandbox.network.allowedDomains in ${SETTINGS}.`;

/**
 * Deletes each recorded `{"set":[...path],"value":v}` key of `s` whose value still deep-equals v, deepest path first, so a
 * created parent (`value: {}`) goes only once it is empty. Returns those blocks, and the dotted paths of changed values kept.
 */
export function removeSets(s: unknown, blocks: string[]): { sets: string[]; changed: string[] } {
  const sets = blocks.map((b) => [b, parse(b)] as [string, any]).filter(([, p]) => isObj(p) && Array.isArray(p.set) && p.set.length).sort((a, b) => b[1].set.length - a[1].set.length);
  const changed: string[] = [];
  for (const [, { set, value }] of sets) {
    const parent = set.slice(0, -1).reduce((o: unknown, k: string) => (isObj(o) ? o[k] : undefined), s);
    const k = set.at(-1);
    if (!isObj(parent) || !Object.hasOwn(parent, k)) continue;
    if (isDeepStrictEqual(parent[k], value)) delete parent[k];
    else if (!isObj(value)) changed.push(set.join('.')); // a parent the person added keys to is theirs now: no note
  }
  return { sets: sets.map(([b]) => b), changed };
}

type EventOut = { recorded?: string[]; blocks: string[]; dropped: string[]; notes: string[] };

/** One event's harness groups, matched to the fragment's by content, then by matcher:
 *  - a group equal to any fragment group stays, duplicates too (uninstall removes every copy of a recorded block);
 *  - a recorded older group is replaced in place by the free fragment group with its matcher, else the first free one, and is
 *    removed when none is free (its block is dropped);
 *  - then an edited group is kept with a note and takes the free slot with its matcher, else the first free one;
 *  - any fragment group still free is added. */
function mergeEvent(ev: string, list: any[], wants: any[], o: EventOut): void {
  const present = new Set<number>();
  const older: [number, string][] = [];
  const edited: number[] = [];
  list.forEach((g, i) => {
    if (!isObj(g) || !Array.isArray(g.hooks)) return void o.notes.push(`${SETTINGS}: hooks.${ev}[${i}] is not a group with a "hooks" array; left untouched.`);
    g.hooks.forEach((h: unknown, j: number) => {
      if (!isObj(h) || typeof h.command !== 'string') o.notes.push(`${SETTINGS}: hooks.${ev}[${i}].hooks[${j}] is not a command hook; left untouched.`);
    });
    if (!g.hooks.some(isHarnessHook)) return;
    const hit = wants.findIndex((w) => isDeepStrictEqual(g, w));
    if (hit >= 0) return void present.add(hit);
    const rec = o.recorded?.find((b) => isDeepStrictEqual(parse(b), { event: ev, group: g }));
    if (rec === undefined) edited.push(i);
    else older.push([i, rec]);
  });
  const slot = (g: any) => {
    const free = wants.map((_, k) => k).filter((k) => !present.has(k));
    const k = free.find((n) => wants[n].matcher === g.matcher) ?? free[0];
    if (k !== undefined) present.add(k);
    return k;
  };
  const gone: number[] = [];
  for (const [i, rec] of older) {
    const k = slot(list[i]);
    o.dropped.push(rec);
    if (k === undefined) {
      gone.push(i);
      continue;
    }
    list[i] = wants[k];
    o.blocks.push(JSON.stringify({ event: ev, group: wants[k] }));
  }
  for (const i of edited) {
    slot(list[i]);
    o.notes.push(`${SETTINGS}: hooks.${ev}[${i}] is a harness hook you edited; left as is. harness doctor checks it.`);
  }
  for (const i of gone.reverse()) list.splice(i, 1);
  wants.forEach((w, k) => {
    if (present.has(k)) return;
    list.push(w);
    o.blocks.push(JSON.stringify({ event: ev, group: w }));
  });
}

/**
 * `blocks` for settings are structural, not text (JSON re-serialization changes the bytes):
 * one JSON.stringify string per inserted hook group, `{"event":"Stop","group":{...}}`,
 * and one per inserted deny rule, `{"deny":"Read(./secrets/**)"}`. Uninstall removes them by deep equality.
 * A harness group equal to a `recorded` block but not to the fragment is replaced at its index; its old block is `dropped`.
 */
export function mergeSettings(before: string | null, opts: { sandbox: SandboxMode; recorded?: string[]; plugins?: PinnedPlugin[] }): { after: string; blocks: string[]; dropped: string[]; notes: string[]; market: string } {
  let s: any;
  try { s = before === null ? {} : JSON.parse(before); } catch (e) { return bad(`is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(s)) bad('must be a JSON object');
  if (s.hooks !== undefined && !isObj(s.hooks)) bad('"hooks" must be an object');
  if (s.permissions !== undefined && !isObj(s.permissions)) bad('"permissions" must be an object');
  if (s.permissions?.deny !== undefined && !Array.isArray(s.permissions.deny)) bad('"permissions.deny" must be an array');
  if (s.enabledPlugins !== undefined && !isObj(s.enabledPlugins)) bad('"enabledPlugins" must be an object');
  if (s.extraKnownMarketplaces !== undefined && !isObj(s.extraKnownMarketplaces)) bad('"extraKnownMarketplaces" must be an object');

  const frag = settingsFragment();
  const blocks: string[] = [];
  const dropped: string[] = [];
  const notes: string[] = [];
  s.hooks ??= {};
  for (const [ev, wants] of Object.entries<any[]>(frag.hooks)) {
    if (s.hooks[ev] !== undefined && !Array.isArray(s.hooks[ev])) {
      notes.push(`${SETTINGS}: hooks.${ev} is not an array; left untouched and the harness ${ev} hook was not added.`);
      continue;
    }
    mergeEvent(ev, (s.hooks[ev] ??= []), wants, { recorded: opts.recorded, blocks, dropped, notes });
  }
  s.permissions ??= {};
  s.permissions.deny ??= [];
  for (const d of frag.permissions.deny as string[]) {
    if (s.permissions.deny.includes(d)) continue;
    s.permissions.deny.push(d);
    blocks.push(JSON.stringify({ deny: d }));
  }
  if (opts.sandbox === 'always') {
    if (s.sandbox !== undefined && !isObj(s.sandbox)) bad('"sandbox" must be an object');
    if (s.sandbox === undefined) {
      s.sandbox = {};
      blocks.push(JSON.stringify({ set: ['sandbox'], value: {} }));
    }
    for (const [k, v] of Object.entries(SANDBOX)) {
      if (!Object.hasOwn(s.sandbox, k)) {
        s.sandbox[k] = v;
        blocks.push(JSON.stringify({ set: ['sandbox', k], value: v }));
        if (k === 'enabled') notes.push(NETWORK_NOTE);
      } else if (!isDeepStrictEqual(s.sandbox[k], v)) notes.push(`${SETTINGS}: sandbox.${k} is already ${JSON.stringify(s.sandbox[k])}; left as is (harness would set ${JSON.stringify(v)}).`);
    }
  } else {
    const r = removeSets(s, (opts.recorded ?? []).filter((b) => (parse(b) as any)?.set?.[0] === 'sandbox')); // preset set blocks are not ours to drop here
    dropped.push(...r.sets);
    for (const p of r.changed) notes.push(`\`${SETTINGS}\`: \`${p}\` was changed; left as is.`);
  }
  mergeDenyWrite(s, blocks, notes);
  const market = pinsName(opts.plugins ?? []);
  mergePlugins(s, opts.plugins ?? [], market, opts.recorded ?? [], blocks, dropped, notes);
  return { after: dump(s, before), blocks, dropped, notes, market };
}

/**
 * `sandbox.filesystem.denyWrite`: every protected harness path (denyWritePaths), in every sandbox mode, so whenever the
 * sandbox runs (an unattended `--settings` launch, `/sandbox`, `sandbox: always`) a Bash write to them fails at the OS
 * level. One `{"denyWrite":path}` block per path harness adds, as for deny rules: a path already there is the person's,
 * a removed one comes back, and uninstall drops the paths and the containers it made. A non-object or non-array on the
 * way is a hand edit: left as is, with a note.
 */
function mergeDenyWrite(s: any, blocks: string[], notes: string[]): void {
  const skip = (what: string): void => void notes.push(`${SETTINGS}: ${what}; left as is and harness's sandbox.filesystem.denyWrite was not added.`);
  if (s.sandbox !== undefined && !isObj(s.sandbox)) return skip('"sandbox" is not an object');
  s.sandbox ??= {};
  if (s.sandbox.filesystem !== undefined && !isObj(s.sandbox.filesystem)) return skip('sandbox.filesystem is not an object');
  s.sandbox.filesystem ??= {};
  if (s.sandbox.filesystem.denyWrite !== undefined && !Array.isArray(s.sandbox.filesystem.denyWrite)) return skip('sandbox.filesystem.denyWrite is not an array');
  const list: unknown[] = (s.sandbox.filesystem.denyWrite ??= []);
  for (const p of denyWritePaths()) {
    if (list.includes(p)) continue;
    list.push(p);
    blocks.push(JSON.stringify({ denyWrite: p }));
  }
}

export type SetBlock = { set: string[]; value: unknown };

/** The leaf settings keys a preset wants. `env` is false for the global path, which writes no environment variables. */
export function presetSets(l: LoadedPreset, opts: { selected: string[]; env: boolean }): SetBlock[] {
  const out: SetBlock[] = [];
  if (l.preset.settings.attribution === 'off') out.push({ set: ['attribution'], value: false });
  if (opts.env) {
    const seen = new Set<string>();
    for (const id of l.preset.settings.telemetry_off) {
      const e = Object.hasOwn(TELEMETRY_ENV, id) ? TELEMETRY_ENV[id] : undefined;
      if (!opts.selected.includes(id) || !e || seen.has(e.name)) continue;
      seen.add(e.name);
      out.push({ set: ['env', e.name], value: e.value });
    }
  }
  return out;
}

/** Adds the wanted keys that are missing (a created parent first), keeps a differing value with a note, and drops recorded preset set blocks (not sandbox, not context apply's skillOverrides) no longer wanted. `who` names the writer in the note. */
export function mergePresetSettings(before: string | null, want: SetBlock[], recorded: string[], label = SETTINGS, who = 'the preset'): { after: string; blocks: string[]; dropped: string[]; notes: string[] } {
  let s: any;
  try { s = before === null ? {} : JSON.parse(before); } catch (e) { throw new MergeError(`${label}: is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(s)) throw new MergeError(`${label}: must be a JSON object`);
  const blocks: string[] = [], notes: string[] = [];
  const keep = (set: string[]) => want.some((w) => set.every((k, i) => w.set[i] === k));
  const stale = recorded.filter((b) => { const p: any = parse(b); return Array.isArray(p?.set) && p.set[0] !== 'sandbox' && p.set[0] !== 'skillOverrides' && !keep(p.set); });
  const r = removeSets(s, stale);
  const dropped = [...r.sets];
  for (const p of r.changed) notes.push(`\`${label}\`: \`${p}\` was changed; left as is.`);
  for (const { set, value } of want) {
    const path = set.join('.');
    const parent = set.slice(0, -1).reduce((o: any, k, i) => {
      if (o[k] === undefined) { o[k] = {}; blocks.push(JSON.stringify({ set: set.slice(0, i + 1), value: {} })); }
      if (!isObj(o[k])) throw new MergeError(`${label}: "${set.slice(0, i + 1).join('.')}" must be an object`);
      return o[k];
    }, s);
    const k = set.at(-1)!;
    if (!Object.hasOwn(parent, k)) { parent[k] = value; blocks.push(JSON.stringify({ set, value })); }
    else if (!isDeepStrictEqual(parent[k], value)) notes.push(`\`${label}\`: \`${path}\` is already ${JSON.stringify(parent[k])}; left as is (${who} would set ${JSON.stringify(value)}).`);
  }
  return { after: dump(s, before), blocks, dropped, notes };
}

export const TSCONFIG = 'tsconfig.json';
export const STRUCTURAL: ReadonlySet<string> = new Set([SETTINGS, '.mcp.json', TSCONFIG]);

/** Sets each missing `compilerOptions` key (a key the file already has, whatever its value, stays). Null when the file is not plain JSON (comments, trailing commas). */
export function mergeTsconfigOptions(before: string, opts: Record<string, true>): { after: string; blocks: string[] } | null {
  try {
    const r = mergePresetSettings(before, Object.entries(opts).map(([k, value]) => ({ set: ['compilerOptions', k], value })), [], TSCONFIG);
    return { after: r.blocks.length ? r.after : before, blocks: r.blocks };
  } catch {
    return null;
  }
}
const MCP = '.mcp.json';
/** The name every install used before content names: Claude Code keeps one user-level copy per name, so repos sharing it get each other's pins. */
export const LEGACY_PINS = 'harness-pins';
/** Every name harness has written for its pins marketplace. */
export const PINS_NAME = /^harness-pins(-[0-9a-f]+)?$/;
const CONTENT_PINS = /^harness-pins-[0-9a-f]{12}$/;
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
/** Named after the pins themselves: identical pins may share a name harmlessly, different pins never do (forks, branches, worktrees included). */
// Every field counts (a hand-added `hooks` or `strict` changes what loads); only `item`, harness's catalog id, is not written to the entry.
export function pinsName(plugins: PinnedPlugin[]): string {
  const list = plugins.map(({ item: _item, ...rest }) => rest).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return `${LEGACY_PINS}-${createHash('sha256').update(canonical(list)).digest('hex').slice(0, 12)}`;
}
/** settingsPins of the repo's settings file; throws MergeError when it can't be read, so no install guesses a name. */
export function pinsAt(root: string): string {
  let s: unknown;
  try { s = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')); } catch (e) { throw new MergeError(`\`${SETTINGS}\` could not be read (${(e as Error).message.split('\n')[0]}).`); }
  return settingsPins(s);
}
/** The content-named pins entries in a parsed settings file, in key order. */
export const contentPins = (s: unknown): string[] => (isObj(s) && isObj(s.extraKnownMarketplaces) ? Object.keys(s.extraKnownMarketplaces).filter((k) => CONTENT_PINS.test(k)) : []);
/** The pins marketplace a parsed settings file uses now: its content-named entry, else the old shared name. Two entries refuse: neither is safe to pick. */
export function settingsPins(s: unknown): string {
  const m = contentPins(s);
  if (m.length > 1) throw new MergeError(`\`${SETTINGS}\` has two harness pins marketplaces, ${m.join(' and ')}; keep the one your plugin keys use and delete the other, then run /harness:sync.`);
  return m[0] ?? LEGACY_PINS;
}
/** Content-named entries whose pins no longer hash to their name: an edit that would let another repo's copy stand in for them. */
export function pinsMismatch(s: unknown): string[] {
  return contentPins(s).filter((k) => {
    const e = (s as any).extraKnownMarketplaces[k];
    return !Array.isArray(e?.source?.plugins) || pinsName(e.source.plugins) !== k;
  });
}

export interface PinnedPlugin {
  name: string;
  item: string;
  source: { source: 'github'; repo: string; sha: string } | { source: 'git-subdir'; url: string; path: string; sha: string };
  lspServers?: Record<string, unknown>;
}

/** The outside plugins among the selected items, each pinned to its commit. */
export function pinnedPlugins(items: CatalogItem[]): PinnedPlugin[] {
  const out: PinnedPlugin[] = [];
  for (const i of items) {
    const s = i.source;
    if ((i.kind !== 'plugin' && i.kind !== 'external-skill') || (s.type !== 'github' && s.type !== 'git-subdir')) continue;
    out.push({
      name: s.plugin, item: i.id,
      // git-subdir takes a git URL: an `owner/repo` shorthand is cloned over SSH (live check A1, Claude Code 2.1.322), which fails
      // for anyone without a GitHub SSH key, so harness writes the HTTPS URL.
      source: s.type === 'github' ? { source: 'github', repo: s.repo, sha: s.sha } : { source: 'git-subdir', url: `https://github.com/${s.repo}.git`, path: s.path, sha: s.sha },
      ...(i.lsp_servers ? { lspServers: i.lsp_servers } : {}),
    });
  }
  return out;
}

const pinsEntry = (plugins: PinnedPlugin[], market: string) => ({ source: { source: 'settings', name: market, owner: { name: 'harness' }, plugins: plugins.map((p) => ({ name: p.name, source: p.source, ...(p.lspServers ? { lspServers: p.lspServers } : {}) })) } });
const renameKey = (o: Record<string, unknown>, from: string, to: string, v: unknown) => Object.fromEntries(Object.entries(o).map(([k, x]) => (k === from ? [to, v] : [k, x])));

/**
 * Moves harness's keys and entry from an older pins name (the shared `harness-pins`, or the name of older pins) to `market`,
 * in place. A key keeps its value. Returns the records still to merge; throws MergeError when an old entry was edited.
 */
function migratePins(s: any, plugins: PinnedPlugin[], market: string, recorded: string[], blocks: string[], dropped: string[]): string[] {
  const recs = recorded.map((b) => [b, parse(b)] as [string, any]);
  const old = (n: unknown): n is string => typeof n === 'string' && n !== market && PINS_NAME.test(n);
  const edited = recs.filter(([, r]) => isObj(r) && old(r.marketplace) && s.extraKnownMarketplaces?.[r.marketplace] !== undefined && !isDeepStrictEqual(s.extraKnownMarketplaces[r.marketplace], r.entry));
  // Merging past it would record picks that are never enabled, so the whole plan stops here.
  if (edited.length) throw new MergeError(`\`${SETTINGS}\`: the ${edited[0][1].marketplace} marketplace was edited, so harness can't change the plugin pins. Undo the edit, or delete that entry, then run /harness:sync.`);
  const rest: string[] = [];
  for (const [b, r] of recs) {
    const at = isObj(r) && typeof r.plugin === 'string' ? r.plugin.lastIndexOf('@') : -1;
    if (at > 0 && old(r.plugin.slice(at + 1))) {
      const p = plugins.find((x) => x.name === r.plugin.slice(0, at));
      const key = `${p?.name}@${market}`;
      if (p && isObj(s.enabledPlugins) && Object.hasOwn(s.enabledPlugins, r.plugin) && !Object.hasOwn(s.enabledPlugins, key)) {
        s.enabledPlugins = renameKey(s.enabledPlugins, r.plugin, key, s.enabledPlugins[r.plugin]);
        blocks.push(JSON.stringify({ plugin: key, item: p.item }));
        dropped.push(b);
        continue;
      }
    } else if (isObj(r) && old(r.marketplace)) {
      dropped.push(b);
      if (s.extraKnownMarketplaces?.[r.marketplace] === undefined) continue; // the person removed it
      if (plugins.length && !Object.hasOwn(s.extraKnownMarketplaces, market)) {
        const entry = pinsEntry(plugins, market);
        s.extraKnownMarketplaces = renameKey(s.extraKnownMarketplaces, r.marketplace, market, entry);
        blocks.push(JSON.stringify({ marketplace: market, entry }));
      } else delete s.extraKnownMarketplaces[r.marketplace];
      continue;
    }
    rest.push(b);
  }
  return rest;
}

/** enabledPlugins keys and the one inline pins marketplace; the same replace-in-place and drop rules as the hook groups. */
function mergePlugins(s: any, plugins: PinnedPlugin[], market: string, recorded: string[], blocks: string[], dropped: string[], notes: string[]): void {
  const left = migratePins(s, plugins, market, recorded, blocks, dropped);
  const recs = left.map((b) => [b, parse(b)] as [string, any]);
  const want = new Set(plugins.map((p) => `${p.name}@${market}`));
  for (const [b, r] of recs) {
    if (!isObj(r) || typeof r.plugin !== 'string' || want.has(r.plugin)) continue;
    const v = s.enabledPlugins?.[r.plugin];
    if (v !== undefined && v !== true) { notes.push(`\`${SETTINGS}\`: \`${r.plugin}\` was changed; left as is.`); continue; } // the person's value stays and stays recorded
    if (v === true) delete s.enabledPlugins[r.plugin];
    dropped.push(b);
  }
  for (const p of plugins) {
    const key = `${p.name}@${market}`;
    if (isObj(s.enabledPlugins) && Object.hasOwn(s.enabledPlugins, key)) continue;
    if (s.enabledPlugins === undefined) { s.enabledPlugins = {}; blocks.push(created('enabledPlugins')); }
    s.enabledPlugins[key] = true;
    blocks.push(JSON.stringify({ plugin: key, item: p.item }));
  }
  // ponytail: a live check (Task 27) confirms that an inline `settings` marketplace honours `lspServers`.
  const entry = plugins.length ? pinsEntry(plugins, market) : null;
  const have = s.extraKnownMarketplaces?.[market];
  const rec = recs.find(([, r]) => isObj(r) && r.marketplace === market && have !== undefined && isDeepStrictEqual(r.entry, have));
  if (have === undefined) {
    for (const [b, r] of recs) if (isObj(r) && r.marketplace === market) dropped.push(b); // the person removed it; the new entry replaces the record
    if (entry) {
      if (s.extraKnownMarketplaces === undefined) { s.extraKnownMarketplaces = {}; blocks.push(created('extraKnownMarketplaces')); }
      s.extraKnownMarketplaces[market] = entry;
      blocks.push(JSON.stringify({ marketplace: market, entry }));
    }
  } else if (entry && isDeepStrictEqual(have, entry)) {
    // already current
  } else if (rec) {
    dropped.push(rec[0]);
    if (entry) {
      s.extraKnownMarketplaces[market] = entry;
      blocks.push(JSON.stringify({ marketplace: market, entry }));
    } else delete s.extraKnownMarketplaces[market];
  } else if (entry || recs.some(([, r]) => isObj(r) && r.marketplace === market)) {
    notes.push(`\`${SETTINGS}\`: the ${market} marketplace was edited; left as is. harness doctor checks it.`);
  }
  for (const k of ['enabledPlugins', 'extraKnownMarketplaces']) dropCreated(s, k, recorded, dropped);
}

const created = (k: string) => JSON.stringify({ created: k });
/** Deletes `s[k]` once empty, only when a recorded `created` block says harness made it; that block is then dropped. */
function dropCreated(s: any, k: string, recorded: string[], dropped: string[]): void {
  const b = created(k);
  if (isObj(s[k]) && !Object.keys(s[k]).length && recorded.includes(b)) { delete s[k]; dropped.push(b); }
}

/** `.mcp.json` servers: block `{"mcp":name,"item":id,"server":{...}}`. A same-named server the person wrote is kept and reported. */
export function mergeMcp(before: string | null, servers: { name: string; item: string; config: Record<string, unknown> }[], recorded: string[] = []): { after: string; blocks: string[]; dropped: string[]; notes: string[] } {
  let s: any;
  try { s = before === null ? {} : JSON.parse(before); } catch (e) { throw new MergeError(`${MCP}: is not valid JSON: ${(e as Error).message}`); }
  if (!isObj(s)) throw new MergeError(`${MCP}: must be a JSON object`);
  if (s.mcpServers !== undefined && !isObj(s.mcpServers)) throw new MergeError(`${MCP}: "mcpServers" must be an object`);
  const blocks: string[] = [], dropped: string[] = [], notes: string[] = [];
  const recs = recorded.map((b) => [b, parse(b)] as [string, any]).filter(([, r]) => isObj(r) && typeof r.mcp === 'string');
  const names = new Set(servers.map((x) => x.name));
  for (const [b, r] of recs) {
    if (names.has(r.mcp)) continue;
    const v = s.mcpServers?.[r.mcp];
    if (v !== undefined && !isDeepStrictEqual(v, r.server)) { notes.push(`\`${MCP}\`: \`${r.mcp}\` was changed; left as is.`); continue; }
    if (v !== undefined) delete s.mcpServers[r.mcp];
    dropped.push(b);
  }
  for (const v of servers) {
    const have = s.mcpServers?.[v.name];
    const block = JSON.stringify({ mcp: v.name, item: v.item, server: v.config });
    if (have === undefined) {
      if (s.mcpServers === undefined) { s.mcpServers = {}; blocks.push(created('mcpServers')); }
      s.mcpServers[v.name] = v.config;
      blocks.push(block);
      continue;
    }
    if (isDeepStrictEqual(have, v.config)) continue;
    const rec = recs.find(([, r]) => r.mcp === v.name && isDeepStrictEqual(r.server, have));
    if (!rec) { notes.push(recs.some(([, r]) => r.mcp === v.name) ? `\`${MCP}\`: server "${v.name}" was edited; left as is.` : `\`${MCP}\` already has a server named "${v.name}"; left as is.`); continue; }
    s.mcpServers[v.name] = v.config;
    dropped.push(rec[0]);
    blocks.push(block);
  }
  dropCreated(s, 'mcpServers', recorded, dropped);
  return { after: dump(s, before), blocks, dropped, notes };
}

/** The JSON object in `current`, and whether the file had `path` before init (init created it: nothing; else the backup; else unknown, counted as had). */
function openRemoval(current: string, f: Manifest['files'][number], original: string | null) {
  let s: any;
  try { s = JSON.parse(current); } catch { return null; }
  if (!isObj(s)) return null;
  let orig: any = f.kind === 'create' ? {} : null;
  if (orig === null && original !== null) { try { orig = JSON.parse(original); } catch {} }
  const had = (...path: string[]) => (orig === null ? true : path.reduce((v: any, k) => v?.[k], orig) !== undefined);
  const blocks = (f.blocks ?? []).map(parse) as any[];
  // A recorded `created` block proves harness made the key, whatever the backup (or its absence) says.
  const gone = (k: string) => blocks.some((b) => b?.created === k) || !had(k);
  const done = () => {
    const eol = eolOf(current);
    return { after: withEol(JSON.stringify(s, null, jsonIndentOf(current)), eol) + (/\n$/.test(current) ? eol : ''), empty: !Object.keys(s).length };
  };
  return { s, had, gone, blocks, done };
}

/** Drops the recorded `mcp` servers that still equal what harness wrote. Returns null when the file is not a JSON object. */
export function removeFromMcp(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null {
  const o = openRemoval(current, f, original);
  if (!o) return null;
  const { s, gone } = o;
  for (const blk of o.blocks) {
    if (typeof blk?.mcp !== 'string') continue;
    if (isObj(s.mcpServers) && isDeepStrictEqual(s.mcpServers[blk.mcp], blk.server)) delete s.mcpServers[blk.mcp];
    else notes.push(`\`${MCP}\`: server "${blk.mcp}" was not found or was changed; left as is.`);
  }
  if (isObj(s.mcpServers) && !Object.keys(s.mcpServers).length && gone('mcpServers')) delete s.mcpServers;
  return o.done();
}

/** Drops the recorded `compilerOptions` keys that still hold what harness set. Returns null when the file is not a JSON object. */
export function removeFromTsconfig(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null {
  const o = openRemoval(current, f, original);
  if (!o) return null;
  for (const k of removeSets(o.s, f.blocks ?? []).changed) notes.push(`\`${TSCONFIG}\`: \`${k}\` was changed; left as is.`);
  return o.done();
}

/** Drops the recorded hook groups, deny rules, set keys, plugins and marketplace. Returns null when the file is not a JSON object. */
export function removeFromSettings(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null {
  const o = openRemoval(current, f, original);
  if (!o) return null;
  const { s, had, gone } = o;
  for (const blk of o.blocks) {
    if (typeof blk?.event === 'string') {
      const list = s.hooks?.[blk.event];
      const kept = Array.isArray(list) ? list.filter((g: unknown) => !isDeepStrictEqual(g, blk.group)) : [];
      if (!Array.isArray(list) || kept.length === list.length) notes.push(`\`${SETTINGS}\`: the harness ${blk.event} hook was not found; left as is.`);
      else s.hooks[blk.event] = kept;
    } else if (typeof blk?.deny === 'string') {
      const list = s.permissions?.deny;
      if (!Array.isArray(list) || !list.includes(blk.deny)) notes.push(`\`${SETTINGS}\`: deny rule \`${blk.deny}\` was not found; left as is.`);
      else s.permissions.deny = list.filter((d: unknown) => d !== blk.deny);
    } else if (typeof blk?.denyWrite === 'string') {
      const list = s.sandbox?.filesystem?.denyWrite;
      if (!Array.isArray(list) || !list.includes(blk.denyWrite)) notes.push(`\`${SETTINGS}\`: sandbox denyWrite path \`${blk.denyWrite}\` was not found; left as is.`);
      else s.sandbox.filesystem.denyWrite = list.filter((d: unknown) => d !== blk.denyWrite);
    } else if (typeof blk?.plugin === 'string') {
      const v = s.enabledPlugins?.[blk.plugin];
      if (v === true) delete s.enabledPlugins[blk.plugin];
      else notes.push(v === undefined ? `\`${SETTINGS}\`: plugin \`${blk.plugin}\` was not found; left as is.` : `\`${SETTINGS}\`: \`${blk.plugin}\` was changed; left as is.`);
    } else if (typeof blk?.marketplace === 'string') {
      if (isObj(s.extraKnownMarketplaces) && isDeepStrictEqual(s.extraKnownMarketplaces[blk.marketplace], blk.entry)) delete s.extraKnownMarketplaces[blk.marketplace];
      else notes.push(`\`${SETTINGS}\`: the ${blk.marketplace} marketplace was not found or was changed; left as is.`);
    }
  }
  for (const k of removeSets(s, f.blocks ?? []).changed) notes.push(`\`${SETTINGS}\`: \`${k}\` was changed; left as is.`);
  // Drop keys that harness's removal left empty and that did not exist before init.
  if (isObj(s.hooks)) {
    for (const [ev, v] of Object.entries(s.hooks)) if (Array.isArray(v) && !v.length && !had('hooks', ev)) delete s.hooks[ev];
    if (!Object.keys(s.hooks).length && !had('hooks')) delete s.hooks;
  }
  if (isObj(s.permissions)) {
    if (Array.isArray(s.permissions.deny) && !s.permissions.deny.length && !had('permissions', 'deny')) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length && !had('permissions')) delete s.permissions;
  }
  const fs = isObj(s.sandbox) && isObj(s.sandbox.filesystem) ? s.sandbox.filesystem : null;
  if (fs) {
    if (Array.isArray(fs.denyWrite) && !fs.denyWrite.length && !had('sandbox', 'filesystem', 'denyWrite')) delete fs.denyWrite;
    if (!Object.keys(fs).length && !had('sandbox', 'filesystem')) delete s.sandbox.filesystem;
  }
  if (isObj(s.sandbox) && !Object.keys(s.sandbox).length && !had('sandbox')) delete s.sandbox;
  for (const k of ['enabledPlugins', 'extraKnownMarketplaces']) if (isObj(s[k]) && !Object.keys(s[k]).length && gone(k)) delete s[k];
  return o.done();
}

/** Separator to put before an appended block: nothing for an empty file, else finish the last line and add a blank one. */
const sep = (before: string, eol: string) => (before === '' ? '' : (before.endsWith('\n') ? '' : eol) + eol);

const START = '<!-- harness:start -->';
const END = '<!-- harness:end -->';
export const PRESET_START = '<!-- harness:preset:start -->';
export const PRESET_END = '<!-- harness:preset:end -->';
export const mergeAgents = (before: string | null) => mergeMarked(before, template('agents-block.md'), START, END, 'harness');
/** `core` is the inner text only; the preset markers are added here. */
export function mergeAgentsPreset(before: string | null, core: string): { after: string; blocks: string[] } {
  if (core.includes(PRESET_START) || core.includes(PRESET_END)) throw new MergeError('the preset core text must not contain the preset markers; they are added when it is written');
  return mergeMarked(before, `${PRESET_START}\n\n${core.trim()}\n\n${PRESET_END}`, PRESET_START, PRESET_END, 'preset');
}
function mergeMarked(before: string | null, text: string, start: string, end: string, who: string): { after: string; blocks: string[] } {
  const eol = before === null ? '\n' : eolOf(before);
  const block = withEol(text.trimEnd(), eol);
  if (before === null) return { after: block + eol, blocks: [block + eol] };
  const count = (m: string) => before.split(m).length - 1;
  if (count(start) > 1 || count(end) > 1) throw new MergeError(`AGENTS.md has a repeated ${who} marker; fix it by hand`);
  const s = before.indexOf(start), e = before.indexOf(end);
  if (s === -1 && e === -1) {
    const added = sep(before, eol) + block + eol; // separator is part of the block so removal is exact
    return { after: before + added, blocks: [added] };
  }
  if (s === -1 || e === -1 || e < s) throw new MergeError(`AGENTS.md has a missing or misordered ${who} marker; fix it by hand`);
  // Marker replace: removing the block gives back the text outside the markers only; the user's
  // original text between the markers was overwritten and cannot be restored.
  return { after: before.slice(0, s) + block + before.slice(e + end.length), blocks: [block] };
}

/** Returns null when there is nothing to import (AGENTS.md absent, or the import is already there). */
export function mergeClaudeMd(before: string | null, agentsExists: boolean): { after: string; blocks: string[] } | null {
  if (!agentsExists) return null;
  if (before === null) return { after: '@AGENTS.md\n', blocks: ['@AGENTS.md\n'] };
  if (/(^|\s)@AGENTS\.md(\s|$)/.test(before)) return null;
  const eol = eolOf(before);
  const block = (before === '' ? '' : (before.endsWith('\n') ? '' : eol) + eol) + `@AGENTS.md${eol}`;
  return { after: before + block, blocks: [block] };
}

function appendLines(before: string | null, lines: string[]): { after: string; blocks: string[] } {
  const text = before ?? '';
  const eol = eolOf(text);
  const have = new Set(text.split(/\r?\n/));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return { after: text, blocks: [] };
  const block = (text === '' || text.endsWith('\n') ? '' : eol) + add.map((l) => l + eol).join('');
  return { after: text + block, blocks: [block] };
}

export const mergeGitignore = (before: string | null) => appendLines(before, HARNESS_LOCAL);
export const mergeIgnoreFile = (before: string | null, entry: '.harness/') => appendLines(before, [entry]);

/** The module body and the exported flat-config array (`[...]`, `defineConfig([...])` or a named const), or null. */
function flatArray(lf: string): { body: any[]; root: any } | null {
  const body: any[] = (parseModule(lf).$ast as any).body;
  const def = body.find((n) => n.type === 'ExportDefaultDeclaration');
  if (!def) return null;
  let root = def.declaration;
  // defineConfig([...]) or tseslint.config([...]): wrappers that take the flat-config array as is. Any other call may read it differently.
  const wrapper = (c: any) => c?.type === 'Identifier' ? c.name === 'defineConfig' : c?.type === 'MemberExpression' && !c.computed && c.property?.name === 'config';
  if (root.type === 'CallExpression') root = root.arguments.length === 1 && wrapper(root.callee) ? root.arguments[0] : null;
  if (root?.type === 'Identifier') {
    for (const n of body) {
      const decl = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
      const v = decl?.type === 'VariableDeclaration' && decl.declarations.find((d: any) => d.id.name === root.name);
      if (v) { root = v.init; break; }
    }
  }
  return root?.type === 'ArrayExpression' ? { body, root } : null;
}

/** Inserts each [LF offset, LF text] into `before` in its own line endings; null unless removeBlocks gives `before` back and it still parses. */
function insertBlocks(before: string, lf: string, at: [number, string][]): { after: string; blocks: string[] } | null {
  const eol = eolOf(before);
  let after = before;
  const blocks: string[] = [];
  for (const [i, text] of [...at].sort((a, b) => b[0] - a[0])) {
    const crlfAt = eol === '\r\n' ? i + lf.slice(0, i).split('\n').length - 1 : i;
    const block = withEol(text, eol);
    after = after.slice(0, crlfAt) + block + after.slice(crlfAt);
    blocks.unshift(block);
  }
  if (removeBlocks(after, blocks) !== before) return null;
  parseModule(after.replace(/\r\n/g, '\n'));
  return { after, blocks };
}

export const HARNESS_RULES_MARK = '// harness:rules';
const SPREAD_BLOCK = /\n[ \t]*\/\/ harness:rules\n[ \t]*\.\.\.harnessRules,?\n[ \t]*\/\/ harness:rules(\n|$)/;
export const HARNESS_RULES_IMPORT = "import harnessRules from './.harness/eslint/harness.config.mjs';";

/**
 * Adds the harness rules import (after the last import) and `...harnessRules` (at the end of the exported array), each
 * between `// harness:rules` lines. Null when the config is not a flat-config array (or the edit would not round-trip).
 */
export function mergeEslintHarnessRules(before: string): { after: string; blocks: string[] } | null {
  try {
    const lf = before.replace(/\r\n/g, '\n');
    if (lf.includes(HARNESS_RULES_MARK)) {
      // Already applied only when both marked blocks are whole; a stray or half-removed marker is a manual step.
      const imp = [`'`, '"'].some((q) => lf.includes(`${HARNESS_RULES_MARK}\n${requote(HARNESS_RULES_IMPORT, q as "'" | '"')}\n${HARNESS_RULES_MARK}\n`));
      return imp && SPREAD_BLOCK.test(lf) ? { after: before, blocks: [] } : null;
    }
    const found = flatArray(lf);
    if (!found) return null;
    const { body, root } = found;
    const imp = body.filter((n) => n.type === 'ImportDeclaration').at(-1);
    const impAt = imp ? (lf.indexOf('\n', imp.end) + 1 || lf.length) : 0;
    const line = `${HARNESS_RULES_MARK}\n${requote(HARNESS_RULES_IMPORT, quoteOf(lf))}\n${HARNESS_RULES_MARK}\n`;
    const last = root.elements[root.elements.length - 1];
    let at = last ? last.end : root.start + 1;
    const comma = last && /^\s*,/.exec(lf.slice(at));
    if (comma) at += comma[0].length;
    const note = /^[ \t]*\/\/[^\n]*/.exec(lf.slice(at)); // a trailing `// comment` stays on the element's line
    if (note && last && !comma) return null; // ponytail: the comma would go before the comment, a second insert; left as a manual step
    if (note) at += note[0].length;
    const ind = last ? /^[ \t]*/.exec(lf.slice(lf.lastIndexOf('\n', last.start) + 1))![0] : '';
    const multiline = lf.slice(at, root.end - 1).includes('\n');
    const spread = `${last && !comma ? ',' : ''}\n${ind}${HARNESS_RULES_MARK}\n${ind}...harnessRules,\n${ind}${HARNESS_RULES_MARK}${multiline ? '' : '\n'}`;
    return insertBlocks(before, lf, [[impAt, line], [at, spread]]);
  } catch {
    return null;
  }
}

/**
 * Adds '.harness/' to the flat config's global ignores: an object whose only key is `ignores`, or `globalIgnores([...])`. With none, a new
 * `{ ignores: ['.harness/'] }` entry is appended to the exported array. Null when the config is not a plain array
 * (or the edit would not round-trip). Inserted text uses the file's quote style and layout, so formatters stay clean.
 */
export function mergeEslintFlatIgnores(before: string): { after: string; blocks: string[] } | null {
  try {
    const lf = before.replace(/\r\n/g, '\n'); // the parser's offsets are in LF text
    const found = flatArray(lf);
    if (!found) return null;
    const { root } = found;
    const q = quoteOf(lf);
    const entry = requote("'.harness/'", q);
    const keyName = (p: any) => (p.type === 'ObjectProperty' && !p.computed ? (p.key?.name ?? p.key?.value) : null);
    // A global-ignores entry: { ignores: [...] } alone, or ESLint's globalIgnores([...]) helper.
    const isHelper = (e: any) => e?.type === 'CallExpression' && e.callee?.name === 'globalIgnores';
    const global = root.elements.find((e: any) => (e?.type === 'ObjectExpression' && e.properties.length === 1 && keyName(e.properties[0]) === 'ignores') || isHelper(e));
    let at: number;
    let text: string;
    if (global) {
      const arr = isHelper(global) ? global.arguments[0] : global.properties[0].value;
      if (arr?.type !== 'ArrayExpression') return null;
      if (arr.elements.some((el: any) => el?.type === 'StringLiteral' && /^\.harness\/?$/.test(el.value))) return { after: before, blocks: [] };
      const last = arr.elements[arr.elements.length - 1];
      [at, text] = last ? [last.end, `, ${entry}`] : [arr.start + 1, entry];
    } else {
      const obj = `{ ignores: [${entry}] }`;
      const last = root.elements[root.elements.length - 1];
      if (!last) [at, text] = [root.start + 1, obj];
      else if (!lf.slice(root.start, last.start).includes('\n')) [at, text] = [last.end, `, ${obj}`];
      else {
        const lineStart = lf.lastIndexOf('\n', last.start) + 1;
        [at, text] = [last.end, `,\n${/^[ \t]*/.exec(lf.slice(lineStart))![0]}${obj}`];
      }
    }
    return insertBlocks(before, lf, [[at, text]]);
  } catch {
    return null;
  }
}
