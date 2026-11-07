// The repo's always-loaded sources (spec §3.1), each with its owner. Reads only under the root, through `io`, after the
// containment and .harnessignore checks. Nothing is counted twice: a file is measured once, and harness's blocks in a
// memory file are cut out of the repo's row.
import * as nodePath from 'node:path';
import { harnessIgnore } from '../install/harnessignore.js';
import { PRESET_END, PRESET_START } from '../install/merge.js';
import { expandImports, inside, loadRaw, realIO, type RepoIO } from './imports.js';
import { alwaysLoadedText, estimateTokens, type ContextEntry } from './measure.js';
import type { Owner } from './owners.js';
import { onDemandFor, unmeasuredFor } from './on-demand.js';
import { CUT_CHARS, pathsOf, splitFrontmatter, stripComments } from './text.js';

type PlatformPath = typeof nodePath;

export interface SourceEntry extends ContextEntry {
  tokens: number; path: string; label: string; owner: Owner; load: 'always' | 'on-demand'; chars: number; note?: string; paths?: string[];
}
export interface RepoMeasure { always: SourceEntry[]; onDemand: SourceEntry[]; unmeasured: string[]; notes: string[] }

const ROOT_MEMORY = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const AGENTS_FILES = new Set(['AGENTS.md', '.claude/AGENTS.md']);
const HARNESS_MARKERS: [string, string] = ['<!-- harness:start -->', '<!-- harness:end -->'];
const PRESET_MARKERS: [string, string] = [PRESET_START, PRESET_END];
const AGENTS_LINE = /^@AGENTS\.md[ \t]*(?:\n|$)/m;
const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];
const DROPPED = new Set(['off', 'user-invocable-only']);
/** Folder depth searched under .claude/rules; also bounds a symlink loop that stays inside the repo. */
const MAX_RULE_DEPTH = 8;
const OVERSIZE_NOTE = 'over 4 MiB: Claude Code skips it';
const CUT_NOTE = 'over 40,000 characters: Claude Code cuts it there';
const BAD_FRONT_NOTE = 'frontmatter does not parse; counted whole';
const NO_PRESET_ID_NOTE = 'preset id not recorded';
const OUTSIDE = 'outside the repo';
export const OVERSIZE = Symbol('oversize');

/** A repo-relative POSIX path under `root`, joined with the platform's separator. `p` is injectable so win32 is testable anywhere. */
export const absIn = (p: Pick<PlatformPath, 'join'>, root: string, rel: string): string => p.join(root, ...rel.split('/'));

export interface Ctx {
  root: string; realRoot: string; io: RepoIO; skip: (rel: string) => boolean; owners: Map<string, Owner>;
  out: RepoMeasure; preset: { id: string | null; recorded: boolean };
  /** Real paths already counted as full text (memory files, imports, rules); a skill listing is a separate load. */
  seenText: Set<string>;
}
interface Where { rel: string; label: string; owner: Owner }

export function entryOf({ rel, label, owner }: Where, text: string, note?: string): SourceEntry {
  const n = note ?? (text.length > CUT_CHARS ? CUT_NOTE : undefined);
  return { id: label, path: rel, label, owner, load: 'always', chars: text.length, tokens: estimateTokens(text), ...(n ? { note: n } : {}) };
}

export const miss = (c: Ctx, rel: string, why: string): null => { c.out.unmeasured.push(`${rel}: ${why}`); return null; };

/** What is at `rel`, checking the real path before any stat, so a link out of the repo is never even sized. */
function kindOf(c: Ctx, rel: string): 'missing' | 'outside' | 'file' | 'other' {
  const abs = absIn(nodePath, c.root, rel);
  const real = c.io.real(abs);
  if (real === null) return 'missing';
  if (!inside(c.realRoot, real)) return 'outside';
  return c.io.size(abs) === null ? 'other' : 'file';
}

/** The file's LF text, OVERSIZE (sized, never read), or null when it is missing or listed as not measured. `seen` dedupes by real path. */
export function readIn(c: Ctx, rel: string, seen: Set<string> | null): string | typeof OVERSIZE | null {
  const abs = absIn(nodePath, c.root, rel);
  if (!inside(c.root, abs)) return null;
  const real = c.io.real(abs);
  if (real === null) return null; // missing, or a broken link: Claude Code loads nothing either
  if (!inside(c.realRoot, real)) return miss(c, rel, OUTSIDE);
  if (c.skip(rel)) return miss(c, rel, 'ignored');
  if (seen?.has(real)) return null; // the same file reached twice (a symlink): counted once
  seen?.add(real);
  const got = loadRaw(abs, c.io);
  if ('text' in got) return got.text;
  if (got.reason === 'oversize') return OVERSIZE;
  return got.reason === 'missing' ? null : miss(c, rel, got.reason);
}

/** Sorted entry names of a folder inside the repo; [] when it is missing or not a folder, and listed as not measured when ignored or outside. */
function listIn(c: Ctx, rel: string): string[] {
  const abs = absIn(nodePath, c.root, rel);
  const real = c.io.real(abs);
  if (real === null) return [];
  if (!inside(c.realRoot, real)) { miss(c, rel, OUTSIDE); return []; }
  if (c.skip(rel)) { miss(c, rel, 'ignored'); return []; }
  return [...(c.io.list(abs) ?? [])].sort();
}

function cut(text: string, [start, end]: [string, string]): { block: string | null; rest: string } {
  const s = text.indexOf(start);
  const e = s < 0 ? -1 : text.indexOf(end, s);
  if (e < 0) return { block: null, rest: text }; // no block, or a broken one: all of it stays in the row (over-counting is safe)
  return { block: text.slice(s, e + end.length), rest: text.slice(0, s) + text.slice(e + end.length) };
}

/** The preset block's owner and note; null leaves it in the repo row (the manifest has no AGENTS.md, so harness did not write it). */
function presetBlock(c: Ctx): { owner: Owner; note?: string } | null {
  if (!c.preset.recorded) return null;
  return c.preset.id ? { owner: `preset:${c.preset.id}` } : { owner: 'harness', note: NO_PRESET_ID_NOTE };
}

/** One memory file's rows: harness's recorded `@AGENTS.md` line and the marked blocks apart, the rest as `w.owner`'s. */
function memoryRows(c: Ctx, w: Where, raw: string): void {
  const { rel } = w;
  let rest = raw;
  const extra: SourceEntry[] = [];
  if (rel === 'CLAUDE.md' && c.owners.has(rel)) {
    const m = AGENTS_LINE.exec(rest); // the manifest records CLAUDE.md only for this line
    if (m) { rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length); extra.push(entryOf({ rel, label: 'CLAUDE.md line @AGENTS.md', owner: 'harness' }, m[0])); }
  }
  const preset = presetBlock(c);
  const blocks = [{ markers: HARNESS_MARKERS, name: 'harness', owner: 'harness' as Owner, note: undefined as string | undefined }, ...(preset ? [{ markers: PRESET_MARKERS, name: 'preset', ...preset }] : [])];
  // Every memory file, not only AGENTS.md: CLAUDE.md is often a link to it, and the markers are harness's wherever they are.
  for (const b of blocks) {
    const got = cut(rest, b.markers);
    rest = got.rest;
    if (got.block !== null) extra.push(entryOf({ rel, label: `${rel} ${b.name} block`, owner: b.owner }, stripComments(got.block), b.note));
  }
  c.out.always.push(entryOf(w, stripComments(rest)), ...extra);
}

interface Expansion { seen: Set<string>; ownerOf: Map<string, Owner> }

function expandFrom(c: Ctx, rel: string, raw: string, { seen, ownerOf }: Expansion): void {
  const got = expandImports(c.root, { path: rel, text: stripComments(raw) }, c.io, seen, c.skip);
  for (const f of got.files) {
    const owner = c.owners.get(f.path) ?? ownerOf.get(f.by) ?? 'repo';
    ownerOf.set(f.path, owner);
    const abs = absIn(nodePath, c.root, f.path);
    const real = c.io.real(abs);
    if (real !== null) c.seenText.add(real); // an imported rule is not counted again as a rule
    const w = { rel: f.path, label: `${f.path} (imported by ${f.by})`, owner };
    // Read again raw: the markers of a harness block are gone from the comment-stripped import text.
    const again = loadRaw(abs, c.io);
    if ('text' in again) memoryRows(c, w, again.text);
    else c.out.always.push(entryOf(w, f.text));
  }
  for (const s of got.skipped) c.out.unmeasured.push(`import ${s.path} (in ${s.by}): ${s.reason}`);
  for (const x of got.external) c.out.unmeasured.push(`external import: ${x}`);
}

/** Root memory files, or AGENTS.md read directly when none of them exists; their imports expanded once across all. */
function measureMemory(c: Ctx): void {
  const roots = ROOT_MEMORY.filter((rel) => { const k = kindOf(c, rel); return k === 'file' || k === 'outside'; }); // a directory of that name is no memory file
  const starts = roots.length ? roots : [...AGENTS_FILES];
  const seen = new Set(starts);
  const ownerOf = new Map<string, Owner>();
  for (const rel of starts) {
    const raw = readIn(c, rel, c.seenText);
    if (raw === null) continue;
    const owner = c.owners.get(rel) ?? 'repo';
    ownerOf.set(rel, owner);
    if (raw === OVERSIZE) { // the spec's 4 MiB skip is for the root memory files; anything else is not measured
      if (ROOT_MEMORY.includes(rel)) c.out.always.push(entryOf({ rel, label: rel, owner }, '', OVERSIZE_NOTE));
      else miss(c, rel, 'oversize');
      continue;
    }
    memoryRows(c, { rel, label: rel, owner }, raw);
    expandFrom(c, rel, raw, { seen, ownerOf });
  }
}

export function ruleFiles(c: Ctx, dir: string, depth: number): string[] {
  if (depth > MAX_RULE_DEPTH) return [];
  return listIn(c, dir).flatMap((name) => {
    const rel = `${dir}/${name}`;
    const kind = kindOf(c, rel);
    if (kind === 'file' || (kind === 'outside' && name.endsWith('.md'))) return name.endsWith('.md') ? [rel] : []; // readIn reports an outside one
    return kind === 'missing' ? [] : ruleFiles(c, rel, depth + 1);
  });
}

/** `.claude/rules/**\/*.md` with no `paths` key: the body without frontmatter; bad frontmatter counts the file whole. */
function measureRules(c: Ctx): void {
  for (const rel of ruleFiles(c, '.claude/rules', 0)) {
    const raw = readIn(c, rel, c.seenText);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, rel, 'oversize'); continue; }
    const w = { rel, label: rel, owner: c.owners.get(rel) ?? 'repo' };
    const f = splitFrontmatter(raw);
    if (f.bad) c.out.always.push(entryOf(w, raw, BAD_FRONT_NOTE));
    else if (pathsOf(f.data) === null) c.out.always.push(entryOf(w, f.body));
  }
}

/** `skillOverrides` from project then local settings, local winning. */
function skillOverrides(c: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of SETTINGS) {
    const raw = readIn(c, rel, null);
    if (typeof raw !== 'string') continue;
    try {
      const so = (JSON.parse(raw) as { skillOverrides?: unknown })?.skillOverrides;
      if (so && typeof so === 'object') for (const [k, v] of Object.entries(so)) out.set(k, String(v));
    } catch {
      c.out.notes.push(`${rel} does not parse: skillOverrides not applied`);
    }
  }
  return out;
}

export interface Listed { rel: string; name: string; label: string; kind: 'skill' | 'agent' }

export function listed(c: Ctx): Listed[] {
  const md = (dir: string, kind: Listed['kind'], word: string): Listed[] => listIn(c, dir).filter((n) => n.endsWith('.md'))
    .map((n) => ({ rel: `${dir}/${n}`, name: n.slice(0, -'.md'.length), label: `${word} ${n.slice(0, -'.md'.length)}`, kind }));
  const skills = listIn(c, '.claude/skills').map((n): Listed => ({ rel: `.claude/skills/${n}/SKILL.md`, name: n, label: `skill ${n}`, kind: 'skill' }));
  return [...skills, ...md('.claude/commands', 'skill', 'command'), ...md('.claude/agents', 'agent', 'agent')];
}

/** Skills and commands as their listing text, agents as their name and description. skillOverrides applies to skills only: unverified for commands, which stay counted. */
function measureSkills(c: Ctx): void {
  const over = skillOverrides(c);
  const seen = new Set<string>(); // the listing is its own load: a skill CLAUDE.md also imports keeps this row
  for (const s of listed(c)) {
    const mode = s.rel.startsWith('.claude/skills/') ? over.get(s.name) : undefined;
    if (mode !== undefined && DROPPED.has(mode)) continue;
    const raw = readIn(c, s.rel, seen);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, s.rel, 'oversize'); continue; }
    const w = { rel: s.rel, label: s.label, owner: c.owners.get(s.rel) ?? 'repo' };
    if (mode === 'name-only') { c.out.always.push(entryOf(w, `name: ${s.name}`)); continue; }
    try {
      c.out.always.push(entryOf(w, alwaysLoadedText(s.kind, raw)));
    } catch {
      c.out.unmeasured.push(`${s.rel}: frontmatter does not parse`);
    }
  }
}

/** `preset` is the config's preset id, or null when none is set (required, so no caller forgets it). */
export function measureRepo(root: string, o: { owners: Map<string, Owner>; preset: string | null }, io: RepoIO = realIO): RepoMeasure {
  const out: RepoMeasure = { always: [], onDemand: [], unmeasured: [], notes: [] };
  const preset = { id: o.preset, recorded: o.owners.has('AGENTS.md') };
  const c: Ctx = { root, realRoot: io.real(root) ?? root, io, skip: harnessIgnore(root), owners: o.owners, out, preset, seenText: new Set() };
  measureMemory(c);
  measureRules(c);
  measureSkills(c);
  const seen = new Set(out.unmeasured); // the on-demand pass re-reads rules and skills, so it reports the same misses again
  const od = onDemandFor(c);
  out.onDemand.push(...od.entries);
  out.notes.push(...od.notes);
  for (const u of od.unmeasured) if (!seen.has(u)) out.unmeasured.push(u);
  out.unmeasured.push(...unmeasuredFor(c));
  return out;
}
