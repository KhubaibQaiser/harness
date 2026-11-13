import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { esc } from '../core/config.js';
import type { ExecBytes } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';

// Trusted text comes from the base commit's blobs. Constants, never paths from the PR.
export const BASE_PATHS = ['.harness/config.yaml', '.harnessignore', 'AGENTS.md', '.harness/context/product.md', '.claude/agents/staff-reviewer.md', '.claude/agents/review-judge.md', '.claude/skills/review-rubric/SKILL.md', '.claude/settings.json'];
const DRIFT_FILES = ['.claude/agents/staff-reviewer.md', '.claude/agents/review-judge.md', '.claude/skills/review-rubric/SKILL.md'];
const BIG = 256 * 1024 * 1024;

const failed = (what: string, r: { stderr?: string; tooBig?: true }) => new Error(`review: git ${what} failed${r.tooBig ? ' (output too large)' : `: ${esc((r.stderr ?? '').split('\n')[0]!.trim())}`}`);

/** `git cat-file --batch` over stdin lines (object names, never a shell); a missing or non-blob object is null. Throws on a git failure. */
export function catFile(exec: ExecBytes, root: string, specs: string[], maxBytes = BIG): (Buffer | null)[] {
  if (!specs.length) return [];
  const r = exec('git', [...SAFE_GIT, '-C', root, 'cat-file', '--batch'], maxBytes, specs.join('\n') + '\n');
  if (r.status !== 0 || r.tooBig || r.missing) throw failed('cat-file', r);
  const out: (Buffer | null)[] = [];
  let at = 0;
  for (const spec of specs) {
    const nl = r.stdout.indexOf(10, at);
    const head = nl < 0 ? '' : r.stdout.subarray(at, nl).toString('utf8');
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(head);
    if (!m) {
      if (!head.endsWith(' missing') && !head.endsWith(' ambiguous')) throw new Error(`review: git cat-file gave an unexpected reply for ${esc(spec)}`);
      out.push(null);
      at = nl + 1;
      continue;
    }
    const size = Number(m[2]);
    out.push(m[1] === 'blob' ? r.stdout.subarray(nl + 1, nl + 1 + size) : null);
    at = nl + 1 + size + 1; // the frame ends with a newline after the bytes
  }
  return out;
}

export interface TreeEntry { mode: string; type: string; sha: string; size: number; path: string }
/** `git ls-tree -r -z -l`: exact paths, with blob sizes (so big files are never read). */
export function lsTree(exec: ExecBytes, root: string, sha: string, paths: string[] = []): TreeEntry[] {
  const r = exec('git', [...SAFE_GIT, '-C', root, 'ls-tree', '-r', '-z', '-l', sha, ...(paths.length ? ['--', ...paths] : [])], BIG);
  if (r.status !== 0 || r.tooBig || r.missing) throw failed('ls-tree', r);
  return r.stdout.toString('utf8').split('\0').filter(Boolean).map((l) => {
    const tab = l.indexOf('\t');
    const [mode = '', type = '', s = '', size = ''] = l.slice(0, tab).split(/ +/);
    return { mode, type, sha: s, size: size === '-' ? 0 : Number(size), path: l.slice(tab + 1) };
  });
}

export function baseBlobs(exec: ExecBytes, root: string, baseSha: string): Record<string, string | null> {
  const got = catFile(exec, root, BASE_PATHS.map((p) => `${baseSha}:${p}`));
  return Object.fromEntries(BASE_PATHS.map((p, i) => [p, got[i]?.toString('utf8') ?? null]));
}

const readOrNull = (root: string, rel: string): Buffer | null => {
  try {
    return readFileSync(join(root, ...rel.split('/')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};
const hooksOf = (t: string | null) => {
  if (t === null) return null;
  try { return { v: (JSON.parse(t) as { hooks?: unknown })?.hooks ?? null }; } catch { return { unparsable: t }; }
};
const same = (a: Buffer | null, b: Buffer | null) => (a === null || b === null ? a === b : a.equals(b));

export interface BaseCommit { sha: string; blobs: Record<string, string | null> }

/** Claude Code loads agents, settings hooks and hook files from the working tree: each must equal its blob at one of `commits`
 *  (the PR's base commit, then the base branch tip), or the PR could steer its own review. The trusted text of each checked
 *  path comes from the commit it matched; every other path from the first commit. */
export function driftCheck(root: string, exec: ExecBytes, base: string, commits: BaseCommit[]): { blobs: Record<string, string | null> } | { error: string } {
  const shas = [...new Set(commits.map((c) => c.sha.slice(0, 7)))].join(' and ');
  const differs = (rel: string) => ({ error: `review: ${rel} differs from ${base} (${shas}); run the review from ${base} or a clean worktree of it` });
  const buf = (t: string | null | undefined) => (t == null ? null : Buffer.from(t, 'utf8'));
  const blobs = { ...commits[0]!.blobs };
  for (const f of DRIFT_FILES) {
    const w = readOrNull(root, f), c = commits.find((x) => same(w, buf(x.blobs[f])));
    if (!c) return differs(f);
    blobs[f] = c.blobs[f] ?? null;
  }
  const s = '.claude/settings.json', w = hooksOf(readOrNull(root, s)?.toString('utf8') ?? null);
  const cs = commits.find((x) => isDeepStrictEqual(w, hooksOf(x.blobs[s] ?? null)));
  if (!cs) return differs(s);
  blobs[s] = cs.blobs[s] ?? null;
  const trees = commits.map((c) => new Map(lsTree(exec, root, c.sha, ['.harness/hooks/']).map((e) => [e.path, e.sha])));
  let work: string[] = [];
  try {
    work = readdirSync(join(root, '.harness', 'hooks'), { recursive: true, withFileTypes: true }).filter((d) => !d.isDirectory())
      .map((d) => `${join(d.parentPath, d.name).slice(root.length + 1).split(/[\\/]/).join('/')}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const ids = [...new Set(trees.flatMap((t) => [...t.values()]))];
  const got = new Map(catFile(exec, root, ids).map((b, k) => [ids[k]!, b]));
  const bad = [...new Set([...trees.flatMap((t) => [...t.keys()]), ...work])].sort()
    .find((p) => { const wb = readOrNull(root, p); return !trees.some((t) => same(wb, t.has(p) ? got.get(t.get(p)!) ?? null : null)); });
  return bad === undefined ? { blobs } : differs(bad);
}
