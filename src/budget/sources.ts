// The repo's always-loaded sources (spec §3.1), each with its owner. Reads only under the root, through `io`, after the
// containment and .harnessignore checks. Nothing is counted twice: a file is measured once, and harness's blocks in a
// memory file are cut out of the repo's row.
import * as nodePath from 'node:path';
import { harnessIgnore } from '../install/harnessignore.js';
import { PRESET_END, PRESET_START } from '../install/merge.js';
import { expandImports, loadRaw, realIO, type RepoIO } from './imports.js';
import { alwaysLoadedText } from './measure.js';
import type { Owner } from './owners.js';
import { onDemandFor, unmeasuredFor } from './on-demand.js';
import { absIn, entryOf, kindOf, listed, miss, modeOf, newCtx, OVERSIZE, readIn, ruleFiles, skillOverrides, type Ctx, type RepoMeasure, type SourceEntry, type Where } from './repo-read.js';
import { pathsOf, splitFrontmatter, stripComments } from './text.js';

export { absIn } from './repo-read.js';
export type { RepoMeasure, SourceEntry } from './repo-read.js';

const ROOT_MEMORY = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const AGENTS_FILES = new Set(['AGENTS.md', '.claude/AGENTS.md']);
const HARNESS_MARKERS: [string, string] = ['<!-- harness:start -->', '<!-- harness:end -->'];
const PRESET_MARKERS: [string, string] = [PRESET_START, PRESET_END];
const AGENTS_LINE = /^@AGENTS\.md[ \t]*(?:\n|$)/m;
const DROPPED = new Set(['off', 'user-invocable-only']);
const OVERSIZE_NOTE = 'over 4 MiB: Claude Code skips it';
const BAD_FRONT_NOTE = 'frontmatter does not parse; counted whole';
const NO_PRESET_ID_NOTE = 'preset id not recorded';
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

/** `.claude/rules/**\/*.md` with no `paths` key: the body without frontmatter; bad frontmatter counts the file whole. */
function measureRules(c: Ctx): void {
  for (const rel of ruleFiles(c, '.claude/rules', 0)) {
    const real = c.io.real(absIn(nodePath, c.root, rel));
    const imported = real !== null && c.seenText.has(real);
    const raw = readIn(c, rel, c.seenText);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, rel, 'oversize'); continue; }
    const w = { rel, label: rel, owner: c.owners.get(rel) ?? 'repo' };
    const f = splitFrontmatter(raw);
    if (f.bad) c.out.always.push(entryOf(w, raw, BAD_FRONT_NOTE));
    else if (pathsOf(f.data) === null) c.out.always.push(entryOf(w, f.body));
    else if (real !== null && !imported) c.seenText.delete(real); // on demand, not counted here: the on-demand pass owns it
  }
}

/** The description's full length (with when_to_use, joined as alwaysLoadedText does, before the cut) and the body. */
function skillFacts(raw: string): NonNullable<SourceEntry['skill']> {
  const f = splitFrontmatter(raw);
  const str = (k: string): string | null => (f.data?.[k] != null ? String(f.data[k]).trim() : null);
  return { description: [str('description'), str('when_to_use')].filter((v) => v !== null).join(' ').length, body: f.body };
}

/** Skills and commands as their listing text, agents as their name and description. skillOverrides applies to skills only: unverified for commands, which stay counted. */
function measureSkills(c: Ctx): void {
  const over = skillOverrides(c);
  const seen = new Set<string>(); // the listing is its own load: a skill CLAUDE.md also imports keeps this row
  for (const s of listed(c)) {
    const mode = modeOf(over, s);
    if (mode !== undefined && DROPPED.has(mode)) continue;
    const raw = readIn(c, s.rel, seen);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, s.rel, 'oversize'); continue; }
    const w = { rel: s.rel, label: s.label, owner: c.owners.get(s.rel) ?? 'repo' };
    if (mode === 'name-only') { c.out.always.push(entryOf(w, `name: ${s.name}`)); continue; }
    try {
      c.out.always.push({ ...entryOf(w, alwaysLoadedText(s.kind, raw)), ...(s.rel.startsWith('.claude/skills/') ? { skill: skillFacts(raw) } : {}) });
    } catch {
      c.out.unmeasured.push(`${s.rel}: frontmatter does not parse`);
    }
  }
}

/** `preset` is the config's preset id, or null when none is set (required, so no caller forgets it). */
export function measureRepo(root: string, o: { owners: Map<string, Owner>; preset: string | null }, io: RepoIO = realIO): RepoMeasure {
  const c = newCtx(root, io, o.owners, harnessIgnore(root), { id: o.preset, recorded: o.owners.has('AGENTS.md') });
  const out = c.out;
  measureMemory(c);
  measureRules(c);
  measureSkills(c);
  const seen = new Set(out.unmeasured); // the on-demand pass re-reads rules and skills, so it reports the same misses again
  const od = onDemandFor(c);
  out.onDemand.push(...od.entries);
  out.notes.push(...od.notes);
  for (const u of [...od.unmeasured, ...unmeasuredFor(c)]) if (!seen.has(u)) { seen.add(u); out.unmeasured.push(u); }
  return out;
}
