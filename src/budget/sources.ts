// The repo's always-loaded sources (spec §3.1), each with its owner. Reads only under the root, through `io`, after the
// containment and .harnessignore checks. Nothing is counted twice: a file is measured once, and harness's blocks in a
// memory file are cut out of the repo's row.
import * as nodePath from 'node:path';
import { harnessIgnore } from '../install/harnessignore.js';
import { PRESET_END, PRESET_START } from '../install/merge.js';
import { expandImports, inside, loadRaw, realIO, type RepoIO } from './imports.js';
import { alwaysLoadedText, estimateTokens, type ContextEntry } from './measure.js';
import type { Owner } from './owners.js';
import { CUT_CHARS, pathsOf, splitFrontmatter, stripComments } from './text.js';

type PlatformPath = typeof nodePath;

export interface SourceEntry extends ContextEntry { tokens: number; path: string; label: string; owner: Owner; load: 'always' | 'on-demand'; chars: number; note?: string; paths?: string[] }
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
const OUTSIDE = 'outside the repo';
const OVERSIZE = Symbol('oversize');

/** A repo-relative POSIX path under `root`, joined with the platform's separator. `p` is injectable so win32 is testable anywhere. */
export const absIn = (p: Pick<PlatformPath, 'join'>, root: string, rel: string): string => p.join(root, ...rel.split('/'));

interface Ctx {
  root: string; realRoot: string; io: RepoIO; skip: (rel: string) => boolean; owners: Map<string, Owner>;
  out: RepoMeasure; presetOwner: Owner; seenReal: Set<string>;
}

function entry(rel: string, label: string, owner: Owner, text: string, note?: string): SourceEntry {
  const n = note ?? (text.length > CUT_CHARS ? CUT_NOTE : undefined);
  return { id: label, path: rel, label, owner, load: 'always', chars: text.length, tokens: estimateTokens(text), ...(n ? { note: n } : {}) };
}

const miss = (c: Ctx, rel: string, why: string): null => { c.out.unmeasured.push(`${rel}: ${why}`); return null; };
const exists = (c: Ctx, rel: string): boolean => c.io.size(absIn(nodePath, c.root, rel)) !== null;

/** The file's LF text, OVERSIZE (sized, never read), or null when it is missing or listed as not measured. */
function readIn(c: Ctx, rel: string): string | typeof OVERSIZE | null {
  const abs = absIn(nodePath, c.root, rel);
  if (!inside(c.root, abs)) return null;
  const real = c.io.real(abs);
  if (real === null) return null; // missing, or a broken link: Claude Code loads nothing either
  if (!inside(c.realRoot, real)) return miss(c, rel, OUTSIDE);
  if (c.skip(rel)) return miss(c, rel, 'ignored');
  if (c.seenReal.has(real)) return null; // the same file reached twice (a symlink): counted once
  c.seenReal.add(real);
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

/** One memory file's rows: harness's recorded `@AGENTS.md` line and the AGENTS.md blocks apart, the rest as `owner`'s. */
function memoryRows(c: Ctx, { rel, label, owner }: { rel: string; label: string; owner: Owner }, raw: string): void {
  let rest = raw;
  const extra: SourceEntry[] = [];
  if (rel === 'CLAUDE.md' && c.owners.has(rel)) {
    const m = AGENTS_LINE.exec(rest); // the manifest records CLAUDE.md only for this line
    if (m) { rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length); extra.push(entry(rel, 'CLAUDE.md line @AGENTS.md', 'harness', m[0])); }
  }
  if (AGENTS_FILES.has(rel)) {
    for (const [markers, name, who] of [[HARNESS_MARKERS, 'harness', 'harness'], [PRESET_MARKERS, 'preset', c.presetOwner]] as const) {
      const got = cut(rest, markers);
      rest = got.rest;
      if (got.block !== null) extra.push(entry(rel, `${rel} ${name} block`, who, stripComments(got.block)));
    }
  }
  c.out.always.push(entry(rel, label, owner, stripComments(rest)), ...extra);
}

interface Expansion { seen: Set<string>; ownerOf: Map<string, Owner> }

function expandFrom(c: Ctx, rel: string, raw: string, { seen, ownerOf }: Expansion): void {
  const got = expandImports(c.root, { path: rel, text: stripComments(raw) }, c.io, seen, c.skip);
  for (const f of got.files) {
    const owner = c.owners.get(f.path) ?? ownerOf.get(f.by) ?? 'repo';
    ownerOf.set(f.path, owner);
    const real = c.io.real(absIn(nodePath, c.root, f.path));
    if (real !== null) c.seenReal.add(real); // an imported rule is not counted again as a rule
    const label = `${f.path} (imported by ${f.by})`;
    // An imported AGENTS.md is read again raw: its markers are gone from the comment-stripped import text.
    const again = AGENTS_FILES.has(f.path) ? loadRaw(absIn(nodePath, c.root, f.path), c.io) : null;
    if (again && 'text' in again) memoryRows(c, { rel: f.path, label, owner }, again.text);
    else c.out.always.push(entry(f.path, label, owner, f.text));
  }
  for (const s of got.skipped) c.out.unmeasured.push(`import ${s.path} (in ${s.by}): ${s.reason}`);
  for (const x of got.external) c.out.unmeasured.push(`external import: ${x}`);
}

/** Root memory files, or AGENTS.md read directly when none of them exists; their imports expanded once across all. */
function measureMemory(c: Ctx): void {
  const roots = ROOT_MEMORY.filter((rel) => exists(c, rel));
  const starts = roots.length ? roots : [...AGENTS_FILES];
  const seen = new Set(starts);
  const ownerOf = new Map<string, Owner>();
  for (const rel of starts) {
    const raw = readIn(c, rel);
    if (raw === null) continue;
    const owner = c.owners.get(rel) ?? 'repo';
    ownerOf.set(rel, owner);
    if (raw === OVERSIZE) { c.out.always.push(entry(rel, rel, owner, '', OVERSIZE_NOTE)); continue; }
    memoryRows(c, { rel, label: rel, owner }, raw);
    expandFrom(c, rel, raw, { seen, ownerOf });
  }
}

function ruleFiles(c: Ctx, dir: string, depth: number): string[] {
  if (depth > MAX_RULE_DEPTH) return [];
  return listIn(c, dir).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (exists(c, rel)) return name.endsWith('.md') ? [rel] : []; // a file (size is null for a folder)
    return ruleFiles(c, rel, depth + 1);
  });
}

/** `.claude/rules/**\/*.md` with no `paths` key: the body without frontmatter; bad frontmatter counts the file whole. */
function measureRules(c: Ctx): void {
  for (const rel of ruleFiles(c, '.claude/rules', 0)) {
    const raw = readIn(c, rel);
    if (raw === null) continue;
    const owner = c.owners.get(rel) ?? 'repo';
    if (raw === OVERSIZE) { c.out.always.push(entry(rel, rel, owner, '', OVERSIZE_NOTE)); continue; }
    const f = splitFrontmatter(raw);
    if (f.bad) c.out.always.push(entry(rel, rel, owner, raw, BAD_FRONT_NOTE));
    else if (pathsOf(f.data) === null) c.out.always.push(entry(rel, rel, owner, f.body));
  }
}

/** `skillOverrides` from project then local settings, local winning. */
function skillOverrides(c: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of SETTINGS) {
    const raw = readIn(c, rel);
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

interface Listed { rel: string; name: string; label: string; kind: 'skill' | 'agent' }

function listed(c: Ctx): Listed[] {
  const md = (dir: string, kind: Listed['kind'], word: string): Listed[] => listIn(c, dir).filter((n) => n.endsWith('.md'))
    .map((n) => ({ rel: `${dir}/${n}`, name: n.slice(0, -'.md'.length), label: `${word} ${n.slice(0, -'.md'.length)}`, kind }));
  const skills = listIn(c, '.claude/skills').map((n): Listed => ({ rel: `.claude/skills/${n}/SKILL.md`, name: n, label: `skill ${n}`, kind: 'skill' }));
  return [...skills, ...md('.claude/commands', 'skill', 'command'), ...md('.claude/agents', 'agent', 'agent')];
}

/** Skills and commands as their listing text (skillOverrides applied), agents as their name and description. */
function measureSkills(c: Ctx, disabled: Set<string>): void {
  const over = skillOverrides(c);
  for (const s of listed(c)) {
    const mode = s.kind === 'skill' ? over.get(s.name) : undefined;
    if (mode !== undefined && DROPPED.has(mode)) continue;
    const raw = readIn(c, s.rel);
    if (raw === null) continue;
    const owner = c.owners.get(s.rel) ?? 'repo';
    if (raw === OVERSIZE) { c.out.always.push(entry(s.rel, s.label, owner, '', OVERSIZE_NOTE)); continue; }
    if (disabled.has(s.name)) { c.out.always.push(entry(s.rel, s.label, owner, '')); continue; }
    if (mode === 'name-only') { c.out.always.push(entry(s.rel, s.label, owner, `name: ${s.name}`)); continue; }
    try {
      c.out.always.push(entry(s.rel, s.label, owner, alwaysLoadedText(s.kind, raw)));
    } catch {
      c.out.unmeasured.push(`${s.rel}: frontmatter does not parse`);
    }
  }
}

/** `preset` is the config's preset id; without it the owner comes from a recorded preset file. */
export function measureRepo(root: string, o: { owners: Map<string, Owner>; skillsDisabled?: Set<string>; preset?: string }, io: RepoIO = realIO): RepoMeasure {
  const out: RepoMeasure = { always: [], onDemand: [], unmeasured: [], notes: [] };
  const recorded = [...o.owners.values()].find((v): v is `preset:${string}` => v.startsWith('preset:'));
  const presetOwner: Owner = o.preset ? `preset:${o.preset}` : recorded ?? 'preset:unknown';
  const c: Ctx = { root, realRoot: io.real(root) ?? root, io, skip: harnessIgnore(root), owners: o.owners, out, presetOwner, seenReal: new Set() };
  measureMemory(c);
  measureRules(c);
  measureSkills(c, o.skillsDisabled ?? new Set());
  return out;
}
