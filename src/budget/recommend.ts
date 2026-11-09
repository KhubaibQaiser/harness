// The `harness context` recommendations (spec §5's table). Deterministic: the same set gives the same numbers. The CLI
// finds them; harness applies only name-only and remove, and the context-optimize skill words and diffs the rest.
import { harnessIgnore } from '../install/harnessignore.js';
import { realIO, type RepoIO } from './imports.js';
import { estimateTokens } from './measure.js';
import type { Owner } from './owners.js';
import { listed, newCtx, OVERSIZE, readIn } from './repo-read.js';
import type { SourceEntry } from './sources.js';
import type { ContextSet } from './summary.js';
import { splitFrontmatter } from './text.js';

export const NAME_ONLY_SHARE = 0.8;
export const LONG_FILE_LINES = 200;
export const MOVE_SHARE = 0.25;
export const DESCRIPTION_MAX = 1536;
export const SIDE_EFFECT = /\b(git push|gh pr create|npm publish|pnpm publish|yarn publish|deploy)\b/;

export type RecKind = 'name-only' | 'remove' | 'long-file' | 'scope-rule' | 'move-to-skill' | 'long-description' | 'user-only';
/** `line` is the worded text after the owner column; the JSON leaves it out. */
export interface Rec { n: number; kind: RecKind; owner: Owner; target: string; saves: number | null; apply: boolean; line: string }

const SKILL = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/;
const MEMORY = /(?:^|\/)(?:CLAUDE|AGENTS|CLAUDE\.local)\.md$/;
const IMPORTED = / \(imported by (.+)\)$/;
const DIFF = '/harness:context-optimize proposes the diff.';
const LOCAL = 'To turn it off for yourself only, disable it in .claude/settings.local.json.';
const k = (n: number): string => n.toLocaleString('en-US');
const lineCount = (t: string | undefined): number => (t ? t.replace(/\n$/, '').split('\n').length : 0);
const importer = (e: SourceEntry): string | null => IMPORTED.exec(e.label)?.[1] ?? null;
type Draft = Omit<Rec, 'n' | 'line'> & { line: (n: number) => string };

/** Skills any `.claude/agents/*.md` preloads through `skills:` (C10, made generic): never shown by name only. */
export function preloadedSkills(root: string, io: RepoIO = realIO): Set<string> {
  const c = newCtx(root, io, new Map(), harnessIgnore(root));
  const out = new Set<string>();
  for (const a of listed(c).filter((x) => x.kind === 'agent')) {
    const raw = readIn(c, a.rel, null);
    if (raw === null || raw === OVERSIZE) continue;
    const skills = splitFrontmatter(raw).data?.skills;
    for (const s of Array.isArray(skills) ? skills : []) out.add(String(s));
  }
  return out;
}

/** Harness-applied kinds: name-only (largest first, until the total is under the line) and plugin picks to remove. */
function harnessRecs(s: ContextSet, preloaded: Set<string>): Draft[] {
  const apply = (n: number) => `Apply: harness context apply ${n}`;
  const named = s.always.flatMap((e): Draft[] => {
    const name = SKILL.exec(e.path)?.[1];
    if (!name || e.owner === 'repo' || preloaded.has(name) || e.text === `name: ${name}`) return [];
    const saves = e.tokens - estimateTokens(`name: ${name}`);
    return saves > 0 ? [{ kind: 'name-only', owner: e.owner, target: name, saves, apply: true, line: (n) => `Show skill ${name} by name only (saves ~${k(saves)}). ${apply(n)}` }] : [];
  }).sort((a, b) => b.saves! - a.saves! || a.target.localeCompare(b.target));
  const limit = NAME_ONLY_SHARE * s.budget;
  let total = s.total;
  const nameOnly = named.filter((d) => (total > limit ? ((total -= d.saves!), true) : false));
  // A pick row is text-less and its path is `catalog:<id>`, not a file (plugin skills ignore skillOverrides, C8).
  const remove = s.always.filter((e) => e.path.startsWith('catalog:') && e.text === undefined).map((e): Draft => (
    { kind: 'remove', owner: e.owner, target: e.id, saves: e.tokens, apply: true, line: (n) => `Remove plugin ${e.id} (saves ~${k(e.tokens)}). ${apply(n)}. ${LOCAL}` }));
  return [...nameOnly, ...remove].sort((a, b) => b.saves! - a.saves! || a.target.localeCompare(b.target));
}

/** The person's own files, in the table's order; the skill proposes each change as a diff. */
function repoRecs(s: ContextSet): Draft[] {
  const rows = s.always.filter((e) => e.owner === 'repo');
  const draft = (kind: RecKind, target: string, saves: number | null, text: string): Draft => ({ kind, owner: 'repo', target, saves, apply: false, line: () => `${text} ${DIFF}` });
  const out: Draft[] = [];
  // long-file: a memory file with what it imports; one a counted memory file imports is in that file's count.
  const mem = rows.filter((e) => MEMORY.test(e.path) && !e.label.endsWith(' block'));
  const roots = [...new Set(mem.map((e) => e.path))].filter((p) => !mem.some((e) => e.path === p && mem.some((m) => m.path === importer(e))));
  for (const p of roots) {
    const seen = new Set([p]);
    let n = 0;
    for (let q = [p]; q.length;) {
      const cur = q.shift()!;
      for (const e of rows) {
        if (e.path === cur) n += lineCount(e.text);
        if (importer(e) === cur && !seen.has(e.path)) { seen.add(e.path); q.push(e.path); }
      }
    }
    if (n > LONG_FILE_LINES) out.push(draft('long-file', p, null, `${p} is ${k(n)} lines; move the parts that only matter for some folders into path-scoped rules.`));
  }
  for (const e of rows) if (e.path.startsWith('.claude/rules/') && e.label === e.path)
    out.push(draft('scope-rule', e.path, e.tokens, `${e.path} loads in every session; give it paths globs so it loads only for matching files.`));
  for (const e of rows) if (e.tokens > MOVE_SHARE * s.budget && !e.skill)
    out.push(draft('move-to-skill', e.path, null, `${e.path} is ~${k(e.tokens)} tokens, over a quarter of the budget; move its reference text into a skill or a path-scoped rule.`));
  const skills = rows.flatMap((e) => { const name = SKILL.exec(e.path)?.[1]; return name && e.skill ? [{ e, name, f: e.skill }] : []; });
  for (const { name, f } of skills) if (f.description > DESCRIPTION_MAX)
    out.push(draft('long-description', name, null, `Skill ${name}'s description is ${k(f.description)} characters; Claude Code cuts it at ${k(DESCRIPTION_MAX)}, so shorten it.`));
  for (const { e, name, f } of skills) {
    const cmd = e.tokens > 0 ? SIDE_EFFECT.exec(f.body)?.[1] : undefined; // 0 tokens: already disable-model-invocation
    if (cmd) out.push(draft('user-only', name, e.tokens, `Skill ${name} runs ${cmd}; set disable-model-invocation: true so only you start it.`));
  }
  return out;
}

export function recommend(s: ContextSet, preloaded: Set<string>): Rec[] {
  return [...harnessRecs(s, preloaded), ...repoRecs(s)].map((d, i) => ({ ...d, n: i + 1, line: d.line(i + 1) }));
}
