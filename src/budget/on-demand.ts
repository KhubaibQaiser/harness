// What loads only when used (spec §3.2) and what is listed but not measured (§3.1). Reads go through sources.ts's
// safety checks (real path inside the repo, size before read, the ignore skip); nothing here opens a file itself.
import * as nodePath from 'node:path';
import { harnessIgnore } from '../install/harnessignore.js';
import type { RepoIO } from './imports.js';
import { estimateTokens } from './measure.js';
import type { Owner } from './owners.js';
import { absIn, entryOf, jsonObject, listed, miss, modeOf, newCtx, OVERSIZE, readIn, ruleFiles, skillOverrides, type Ctx, type SourceEntry } from './repo-read.js';
import { CUT_CHARS, pathsOf, splitFrontmatter, stripComments } from './text.js';

const NO_GIT_NOTE = 'not a git repository or git not found: nested CLAUDE.md files not listed';
const NESTED = /(?:^|\/)(?:CLAUDE|AGENTS)\.md$/;
const ROOT_MEMORY_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/AGENTS.md']);
const DECISION = /(?:^|\/)harness-decision-[^/]*$/;

interface Part { text: string; owner: Owner }

/** One row for many files: summed tokens and chars, the common owner (repo when they differ). */
function group(label: string, parts: Part[], path: string): SourceEntry {
  const owners = new Set(parts.map((p) => p.owner));
  const text = parts.map((p) => p.text);
  return {
    id: label, path, label, load: 'on-demand', owner: owners.size === 1 ? parts[0].owner : 'repo',
    chars: text.reduce((n, t) => n + t.length, 0), tokens: text.reduce((n, t) => n + estimateTokens(t), 0), text: text.join('\n'),
    ...(text.some((t) => t.length > CUT_CHARS) ? { note: 'a file is over 40,000 characters: Claude Code cuts it there' } : {}),
  };
}

const alreadyAlways = (c: Ctx, rel: string): boolean => { const r = c.io.real(absIn(nodePath, c.root, rel)); return r !== null && c.seenText.has(r); };

function ruleRows(c: Ctx): SourceEntry[] {
  const rows: SourceEntry[] = [];
  const decisions: Part[] = [];
  const seen = new Set<string>(); // two links to one rule: counted once
  for (const rel of ruleFiles(c, '.claude/rules', 0)) {
    if (alreadyAlways(c, rel)) continue; // imported by a memory file: its always row stands
    const raw = readIn(c, rel, seen);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, rel, 'oversize'); continue; }
    const f = splitFrontmatter(raw);
    const globs = f.bad ? null : pathsOf(f.data);
    if (globs === null) continue; // always loaded, measured by measureRules
    const owner = c.owners.get(rel) ?? 'repo';
    if (DECISION.test(rel)) { decisions.push({ text: f.body, owner }); continue; }
    rows.push({ ...entryOf({ rel, label: `${rel} (paths: ${globs.join(', ')})`, owner }, f.body), load: 'on-demand', paths: globs });
  }
  // Harness owns the group only when it owns every member; a repo-owned decision file is its own group.
  for (const owner of ['harness', 'other'] as const) {
    const part = decisions.filter((d) => (d.owner === 'harness') === (owner === 'harness'));
    if (part.length) rows.push(group(`team decisions: ${part.length} rules`, part, '.claude/rules'));
  }
  return rows;
}

function nestedRow(c: Ctx, notes: string[]): SourceEntry[] {
  const files = c.io.lsFiles(c.root);
  if (files === null) { notes.push(NO_GIT_NOTE); return []; }
  const parts: Part[] = [];
  const rels = files.filter((rel) => NESTED.test(rel) && !ROOT_MEMORY_FILES.has(rel)).sort();
  for (const rel of rels) {
    const raw = readIn(c, rel, null);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, rel, 'oversize'); continue; }
    parts.push({ text: stripComments(raw), owner: c.owners.get(rel) ?? 'repo' });
  }
  return parts.length ? [group(`nested CLAUDE.md: ${parts.length}`, parts, rels[0])] : [];
}

function bodyRow(c: Ctx): SourceEntry[] {
  const parts: Part[] = [];
  const over = skillOverrides(c);
  for (const s of listed(c)) {
    if (modeOf(over, s) === 'off') continue; // never loaded; user-invocable-only still loads its body when the user runs it
    const raw = readIn(c, s.rel, null);
    if (raw === null) continue;
    if (raw === OVERSIZE) { miss(c, s.rel, 'oversize'); continue; }
    parts.push({ text: splitFrontmatter(raw).body, owner: c.owners.get(s.rel) ?? 'repo' });
  }
  return parts.length ? [group(`skill and agent bodies: ${parts.length}`, parts, '.claude')] : [];
}

export function onDemandFor(shared: Ctx): { entries: SourceEntry[]; notes: string[]; unmeasured: string[] } {
  const c: Ctx = { ...shared, out: { always: [], onDemand: [], unmeasured: [], notes: [] } }; // own misses, so the caller can drop repeats
  const notes: string[] = [];
  const entries = [...ruleRows(c), ...nestedRow(c, notes), ...bodyRow(c)];
  return { entries, notes, unmeasured: c.out.unmeasured };
}

export function onDemand(root: string, io: RepoIO, owners: Map<string, Owner>, skip: (rel: string) => boolean): { entries: SourceEntry[]; notes: string[]; unmeasured: string[] } {
  return onDemandFor(newCtx(root, io, owners, skip));
}

const objectKeys = (v: unknown): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);

export function unmeasuredFor(c: Ctx): string[] {
  const settings = jsonObject(c, '.claude/settings.json');
  const plugins = settings?.enabledPlugins;
  const on = objectKeys(plugins).filter((id) => (plugins as Record<string, unknown>)[id] === true && !/^harness-pins(-[0-9a-f]+)?$/.test(id.slice(id.lastIndexOf('@') + 1))); // harness's own pins, measured as items
  const mcp = objectKeys(jsonObject(c, '.mcp.json')?.mcpServers);
  return [...on.map((id) => `plugin: ${id}`), ...mcp.map((n) => `mcp: ${n}`)].sort();
}

export function unmeasuredSources(root: string, io: RepoIO): string[] {
  return unmeasuredFor(newCtx(root, io, new Map(), harnessIgnore(root)));
}
