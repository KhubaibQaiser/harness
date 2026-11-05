import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { isAnyTestFile } from '../../core/paths.js';
import { bucketOf, type Acc, type Bucket, type SessionCtx } from '../acc.js';

export interface SkillSpec { name: string; relevant: ((paths: string[]) => boolean) | null; label: 'paths' | 'proxy' | 'stack' | 'none'; stackUnknown?: true }
/** Texts the page shows beside the splits. */
export const SKILL_NOTES = {
  compact: 'Proxy: relevance is judged over the whole session, so a session counts as relevant before and after its first compaction alike.',
  bucket: "Buckets use the session's total turns, not when in the session the skill was or was not used.",
  relevance: 'Relevance is a proxy (files edited). `undercounted`: edits by subagents, or past the 1000-file cap, are not seen. `stackUnknown`: no package facts matched, so "no relevant sessions" may mean not applicable.',
};
/** `unknown`: relevant sessions with an unreadable tool use and no other invocation; they are neither fired nor missed (show it beside the rate).
 *  `sessionsWithListing`: sessions with a main-thread listing record; `listedIn` is out of these. */
export interface SkillRow {
  name: string; label: SkillSpec['label']; listedIn: number; sessionsWithListing: number; relevantIn: number; invokedRelevant: number; invokedOther: number; typedOrCarried: number; sessions: number; dropped: boolean; unknown: number; undercounted: boolean; stackUnknown?: true;
  byBucket: Record<Bucket, { r: number; i: number }>; byCompact: { pre: { r: number; i: number }; post: { r: number; i: number } };
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EDIT_CAP = 1000; // turns.ts caps the edited list here
const MAX_SKILLS = 500, MAX_SKILL_MD = 64 * 1024;
const JS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Each `.claude/skills/<dir>/SKILL.md` frontmatter: `name` (else the folder) and `paths` (a list or a comma string). */
export function installedSkills(root: string): { name: string; paths?: string[] }[] {
  let dirs: string[];
  try { dirs = readdirSync(join(root, '.claude/skills')).slice(0, MAX_SKILLS); } catch { return []; }
  const out: { name: string; paths?: string[] }[] = [];
  for (const d of dirs) {
    let text: string;
    try { text = readFileSync(join(root, '.claude/skills', d, 'SKILL.md'), 'utf8').slice(0, MAX_SKILL_MD); } catch { continue; }
    let fm: Record<string, unknown> = {};
    try {
      const y = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text) ? parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1]!) : null;
      if (y !== null && typeof y === 'object' && !Array.isArray(y)) fm = y as Record<string, unknown>;
    } catch { /* bad frontmatter: keep the folder name, no paths */ }
    const p = fm.paths, list = typeof p === 'string' ? p.split(',') : Array.isArray(p) ? p : [];
    const paths = list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    out.push({ name: typeof fm.name === 'string' && fm.name !== '' ? fm.name : d, ...(paths.length > 0 ? { paths } : {}) });
  }
  return out;
}

export function skillSpecs(root: string, installed: { name: string; paths?: string[] }[], packages: { dir: string; frameworks: string[] }[], selected: { id: string; frameworks: string[] }[]): SkillSpec[] {
  // edited paths come absolute; one outside the repo is never relevant
  const rel = (p: string) => (isAbsolute(p) ? relative(root, p) : p).replace(/\\/g, '/');
  const inRepo = (ps: string[]) => ps.map(rel).filter((p) => !p.startsWith('../') && p !== '..');
  const any = (f: (p: string) => boolean) => (ps: string[]) => inRepo(ps).some(f);
  const inPkg = (fws: string[], sub: RegExp) => any((p) => packages.some((k) => {
    const d = k.dir === '.' ? '' : k.dir;
    return k.frameworks.some((f) => fws.includes(f)) && (d === '' || p.startsWith(`${d}/`)) && sub.test(d === '' ? p : p.slice(d.length + 1));
  }));
  const proxies: Record<string, (paths: string[]) => boolean> = {
    'engineering-principles': any((p) => JS.test(p) && !isAnyTestFile(p)),
    'frontend-react': any((p) => /\.(tsx|jsx)$/.test(p)),
    'frontend-nextjs': inPkg(['next'], /^(src\/)?(app|pages)\//),
    'frontend-react-native': inPkg(['react-native', 'expo'], /./),
  };
  return installed.map(({ name, paths }): SkillSpec => {
    if (paths !== undefined && paths.length > 0) {
      const m = picomatch(paths, { dot: true });
      return { name, label: 'paths', relevant: any((p) => m(p)) };
    }
    const unk = (fws: string[]): { stackUnknown?: true } => (packages.some((k) => k.frameworks.some((f) => fws.includes(f))) ? {} : { stackUnknown: true });
    if (name === 'frontend-nextjs') return { name, label: 'proxy', relevant: proxies[name]!, ...unk(['next']) };
    if (name === 'frontend-react-native') return { name, label: 'proxy', relevant: proxies[name]!, ...unk(['react-native', 'expo']) };
    if (proxies[name]) return { name, label: 'proxy', relevant: proxies[name]! };
    const plugin = name.includes(':') ? selected.find((s) => s.id === name.split(':')[0] && s.frameworks.length > 0) : undefined;
    if (plugin) return { name, label: 'stack', relevant: inPkg(plugin.frameworks, /./), ...unk(plugin.frameworks) };
    return { name, label: 'none', relevant: null };
  });
}

const rc = () => ({ r: 0, i: 0 });
const row = (s: SkillSpec): SkillRow => ({
  name: s.name, label: s.label, ...(s.stackUnknown ? { stackUnknown: true as const } : {}), listedIn: 0, sessionsWithListing: 0, undercounted: false, relevantIn: 0, invokedRelevant: 0, invokedOther: 0, typedOrCarried: 0, sessions: 0, dropped: false, unknown: 0,
  byBucket: { '1-10': rc(), '11-30': rc(), '31-100': rc(), '100+': rc() }, byCompact: { pre: rc(), post: rc() },
});

export function skillsAcc(specs: SkillSpec[]): Acc<SkillRow[]> {
  const rows = specs.map(row);
  // per session: listing names, Skill tool uses split by compaction, attachment names, any unreadable tool use
  let listed: Set<string> | undefined, tool = new Map<string, { pre: boolean; post: boolean }>(), carried = new Set<string>(), bad = false, compacted = false, compactTs = NaN, subEdit = false;
  const reset = () => { listed = undefined; tool = new Map(); carried = new Set(); bad = false; compacted = false; compactTs = NaN; subEdit = false; };
  return {
    rec(_s: SessionCtx, r) {
      if (r.k === 'compact') {
        if (!r.side && !compacted) { compacted = true; compactTs = r.ts; }
      } else if (r.k === 'listing') {
        if (!r.side) { listed ??= new Set(); r.names.forEach((n) => listed!.add(n)); } // a subagent's listing may be restricted
      } else if (r.k === 'invoked') r.names.forEach((n) => carried.add(n));
      else if (r.k === 'assistant') {
        for (const t of r.tools) {
          if (t.malformed) bad = true;
          else if (r.side && t.filePath !== undefined && EDITS.has(t.name)) subEdit = true;
          if (!t.malformed && t.skill !== undefined) {
            const e = tool.get(t.skill) ?? { pre: false, post: false };
            // a subagent record is placed by its own time against the main thread's first compact; no usable time is unplaced
            const where = !r.side ? (compacted ? 'post' : 'pre') : !compacted ? 'pre' : Number.isNaN(r.ts) || Number.isNaN(compactTs) ? undefined : r.ts < compactTs ? 'pre' : 'post';
            if (where) e[where] = true;
            tool.set(t.skill, e);
          }
        }
      }
    },
    endSession(s) {
      const b = bucketOf(s.turns);
      specs.forEach((sp, k) => {
        const o = rows[k]!, t = tool.get(sp.name), rel = sp.relevant?.(s.edited) === true;
        o.sessions++;
        if (listed !== undefined) o.sessionsWithListing++;
        if (listed?.has(sp.name)) o.listedIn++;
        else if (listed !== undefined) o.dropped = true;
        if (sp.relevant !== null && (subEdit || s.edited.length >= EDIT_CAP)) o.undercounted = true;
        if (t === undefined && carried.has(sp.name)) o.typedOrCarried++;
        if (!rel) return void (t && o.invokedOther++);
        o.relevantIn++; o.byBucket[b].r++; o.byCompact.pre.r++;
        if (s.compactions > 0) o.byCompact.post.r++;
        if (t === undefined) return void (bad && o.unknown++);
        o.invokedRelevant++; o.byBucket[b].i++;
        if (t.pre) o.byCompact.pre.i++;
        if (t.post) o.byCompact.post.i++;
      });
      reset();
    },
    result: () => rows,
  };
}
