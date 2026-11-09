// Reading helpers shared by sources.ts (always loaded) and on-demand.ts. Every repo read goes through here: real path
// inside the repo, the ignore skip, size before read. Repo text is untrusted.
import * as nodePath from 'node:path';
import { inside, loadRaw, relPosix, type RepoIO } from './imports.js';
import { estimateTokens, type ContextEntry } from './measure.js';
import type { Owner } from './owners.js';
import { CUT_CHARS } from './text.js';

type PlatformPath = typeof nodePath;

export interface SourceEntry extends ContextEntry {
  tokens: number; path: string; label: string; owner: Owner; load: 'always' | 'on-demand'; chars: number; note?: string; paths?: string[];
  /** A `.claude/skills/` row: its full description length (before the cut), body and any skillOverrides value, for the recommendations. Never in the JSON. */
  skill?: { description: number; body: string; override?: string };
  /** A catalog pick row's item kind (plugin, external-skill), so only plugin picks get `remove` (C8). Never in the JSON. */
  pick?: string;
}
export interface RepoMeasure { always: SourceEntry[]; onDemand: SourceEntry[]; unmeasured: string[]; notes: string[] }
/** Folder depth searched under .claude/rules; also bounds a symlink loop that stays inside the repo. */
const MAX_RULE_DEPTH = 8;
const CUT_NOTE = 'over 40,000 characters: Claude Code cuts it there';
const OUTSIDE = 'outside the repo';
export const OVERSIZE = Symbol('oversize');

/** A repo-relative POSIX path under `root`, joined with the platform's separator. `p` is injectable so win32 is testable anywhere. */
export const absIn = (p: Pick<PlatformPath, 'join'>, root: string, rel: string): string => p.join(root, ...rel.split('/'));

export interface Ctx {
  root: string; realRoot: string; io: RepoIO; skip: (rel: string) => boolean; owners: Map<string, Owner>;
  out: RepoMeasure; preset: { id: string | null; recorded: boolean };
  /** Real paths already counted as full text (memory files, imports, rules); a skill listing is a separate load. */
  seenText: Set<string>;
  /** Parsed JSON files by path (null when absent or bad), so each is read and reported once. */
  json: Map<string, Record<string, unknown> | null>;
}
export interface Where { rel: string; label: string; owner: Owner }

export function entryOf({ rel, label, owner }: Where, text: string, note?: string): SourceEntry {
  const n = note ?? (text.length > CUT_CHARS ? CUT_NOTE : undefined);
  return { id: label, path: rel, label, owner, load: 'always', chars: text.length, tokens: estimateTokens(text), text, ...(n ? { note: n } : {}) };
}

export const miss = (c: Ctx, rel: string, why: string): null => { c.out.unmeasured.push(`${rel}: ${why}`); return null; };

/** The skip by name and by real path, so a link with an innocent name to a skipped file is skipped too. */
const skipped = (c: Ctx, rel: string, real: string): boolean => c.skip(rel) || c.skip(relPosix(nodePath, c.realRoot, real));

/** What is at `rel`, checking the real path before any stat, so a link out of the repo is never even sized. */
export function kindOf(c: Ctx, rel: string): 'missing' | 'outside' | 'file' | 'other' {
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
  if (skipped(c, rel, real)) return miss(c, rel, 'ignored');
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
  if (skipped(c, rel, real)) { miss(c, rel, 'ignored'); return []; }
  return [...(c.io.list(abs) ?? [])].sort();
}
/** Real paths of the folders under `abs` reached without a symlink: the folders a link can only repeat. */
function linkFree(c: Ctx, abs: string, real: string, depth: number, out = new Set<string>()): Set<string> {
  out.add(real);
  if (depth >= MAX_RULE_DEPTH) return out;
  for (const name of c.io.list(abs) ?? []) {
    const a = nodePath.join(abs, name);
    // Real path first: a link out of the repo is never stat'ed.
    if (c.io.real(a) === nodePath.join(real, name) && c.io.size(a) === null) linkFree(c, a, nodePath.join(real, name), depth + 1, out);
  }
  return out;
}

/**
 * `walked`: real paths of folders already searched, so a link back to one (a loop) is skipped, not fanned out. A link to a
 * folder the walk also reaches without links is skipped whatever the sort order, so files keep their real path.
 */
export function ruleFiles(c: Ctx, dir: string, depth: number, walked = new Set<string>(), plain?: Set<string>): string[] {
  if (depth > MAX_RULE_DEPTH) return [];
  const abs = absIn(nodePath, c.root, dir);
  const real = c.io.real(abs);
  const tree = plain ?? (real !== null ? linkFree(c, abs, real, depth) : new Set<string>());
  const link = real !== null && depth > 0 && real !== nodePath.join(c.io.real(nodePath.dirname(abs)) ?? '', nodePath.basename(abs));
  if (real !== null && (walked.has(real) || (link && tree.has(real)))) return miss(c, dir, 'already searched (symlink)') ?? [];
  if (real !== null) walked.add(real);
  return listIn(c, dir).flatMap((name) => {
    const rel = `${dir}/${name}`;
    const kind = kindOf(c, rel);
    if (kind === 'file' || (kind === 'outside' && name.endsWith('.md'))) return name.endsWith('.md') ? [rel] : []; // readIn reports an outside one
    return kind === 'missing' ? [] : ruleFiles(c, rel, depth + 1, walked, tree);
  });
}

export interface Listed { rel: string; name: string; label: string; kind: 'skill' | 'agent' }

export function listed(c: Ctx): Listed[] {
  const md = (dir: string, kind: Listed['kind'], word: string): Listed[] => listIn(c, dir).filter((n) => n.endsWith('.md'))
    .map((n) => ({ rel: `${dir}/${n}`, name: n.slice(0, -'.md'.length), label: `${word} ${n.slice(0, -'.md'.length)}`, kind }));
  const skills = listIn(c, '.claude/skills').map((n): Listed => ({ rel: `.claude/skills/${n}/SKILL.md`, name: n, label: `skill ${n}`, kind: 'skill' }));
  return [...skills, ...md('.claude/commands', 'skill', 'command'), ...md('.claude/agents', 'agent', 'agent')];
}

/** Any name starting with `.env`, in any folder (spec §3's `.env*`: never read). */
const DOTENV = /(?:^|\/)\.env[^/]*$/i;

/** Every reader passes `c.skip`, so the dotenv rule here covers imports, rules, skills and the JSON files alike. */
export function newCtx(root: string, io: RepoIO, owners: Map<string, Owner>, skip: (rel: string) => boolean, preset: Ctx['preset'] = { id: null, recorded: false }): Ctx {
  return { root, realRoot: io.real(root) ?? root, io, skip: (rel) => DOTENV.test(rel) || skip(rel), owners, out: { always: [], onDemand: [], unmeasured: [], notes: [] }, preset, seenText: new Set(), json: new Map() };
}

/** The JSON object at `rel`, read once: null when absent, over size, not an object or not valid (one note; never throws). */
export function jsonObject(c: Ctx, rel: string): Record<string, unknown> | null {
  if (c.json.has(rel)) return c.json.get(rel) ?? null;
  const raw = readIn(c, rel, null);
  let v: Record<string, unknown> | null = null;
  if (raw === OVERSIZE) miss(c, rel, 'oversize');
  else if (raw !== null) {
    let why = 'not valid JSON';
    try {
      const x: unknown = JSON.parse(raw);
      if (x && typeof x === 'object' && !Array.isArray(x)) v = x as Record<string, unknown>;
      else why = 'not a JSON object';
    } catch { /* falls through to the note */ }
    if (v === null) c.out.notes.push(`${rel}: ${why}, not read`);
  }
  c.json.set(rel, v);
  return v;
}

/** `skillOverrides` from project then local settings, local winning. */
export function skillOverrides(c: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of ['.claude/settings.json', '.claude/settings.local.json']) {
    const so = jsonObject(c, rel)?.skillOverrides;
    if (so && typeof so === 'object') for (const [k, v] of Object.entries(so)) out.set(k, String(v));
  }
  return out;
}

/** The override mode for a listed item: `.claude/skills/` only; commands and agents are never overridden. */
export const modeOf = (over: Map<string, string>, s: Listed): string | undefined => (s.rel.startsWith('.claude/skills/') ? over.get(s.name) : undefined);
