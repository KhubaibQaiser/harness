// Team decisions and their generated rules change only through `harness remember` (spec §6.2). No deny rule (C9).
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import picomatch from 'picomatch';
import { DECISIONS_DIR, isDecisionText, MAX_DECISION_BYTES } from '../core/decision-file.js';
import { RULE_GLOB } from '../core/decision-rule.js';
import type { HarnessConfig } from '../core/config.js';
import { toRepoPath } from '../core/paths.js';
import type { Decision } from '../hooks/types.js';

export const DECISIONS_REASON = 'Team decisions change only through harness remember, which asks the person first. Edit a decision by hand yourself, then run harness remember sync.';
export const DECISION_CONCRETE = ['docs', 'docs/decisions', '.claude/rules'];
const RULES_DIR = '.claude/rules';
const DIR = DECISIONS_DIR.toLowerCase() + '/';
const GLOB = /[*?[{]/;
const DECISION_NAME = /^\d{4}-\d{2}-\d{2}-[^/]*\.md$/; // the id shape (§3.1), loosely: a name `remember add` could pick

// A valid decision is at most MAX_DECISION_BYTES (parseDecision), so its whole frontmatter is inside this read.
function head(abs: string): string {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(MAX_DECISION_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, MAX_DECISION_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

// A rule file, a new file in docs/decisions/, or an existing one that is a decision. Read only under docs/decisions/.
function isDecisionPath(root: string, p: string): boolean {
  const rel = toRepoPath(root, p)?.toLowerCase(); // macOS is case-insensitive
  if (!rel) return false;
  if (RULE_GLOB.test(rel)) return true;
  if (!rel.startsWith(DIR)) return false;
  const abs = resolve(root, p);
  const st = statSync(abs, { throwIfNoEntry: false });
  return !st || (st.isFile() && isDecisionText(head(abs)));
}

// The path is a decision folder or an ancestor of one inside the repo. The root and above are the guard's (rm -rf .),
// so text that only mentions rm -rf / (a heredoc body) stays allowed here.
function holdsDecisions(root: string, p: string): boolean {
  const rel = toRepoPath(root, p)?.toLowerCase();
  return !!rel && DECISION_CONCRETE.some((c) => c === rel || c.startsWith(rel + '/'));
}

/** A glob, read as protect reads `.harness` globs, that matches one of `names` (repo paths, lower case). */
export const globHits = (root: string, t: string, names: string[]): boolean => {
  const rel = toRepoPath(root, t.replace(/^:\//, ''))?.toLowerCase().replace(/\[!/g, '[^'); // picomatch mishandles [!x]
  return !!rel && names.some((c) => picomatch(rel, { dot: true })(c));
};

const listed = (root: string, dir: string): string[] => {
  try {
    return readdirSync(resolve(root, dir)).map((n) => `${dir}/${n}`);
  } catch {
    return [];
  }
};

/**
 * A glob may not match a decision folder, or a decision or generated rule that exists. A folder is listed, and its
 * decisions read, only for a glob whose folder part can reach it, so `rm -rf dist/*` reads nothing. A file whose name
 * holds a glob character can't be a decision (its id would not match), so it is read as a glob.
 */
function globDeny(root: string, globs: string[]): boolean {
  if (globs.some((g) => globHits(root, g, DECISION_CONCRETE))) return true;
  const folders: [string, (p: string) => boolean][] = [[DECISIONS_DIR, (p) => isDecisionPath(root, p)], [RULES_DIR, (p) => RULE_GLOB.test(p)]];
  for (const [dir, keep] of folders) {
    const near = globs.filter((g) => globHits(root, dirname(g), [dir]));
    if (!near.length) continue;
    const names = listed(root, dir).filter(keep).map((p) => p.toLowerCase());
    if (near.some((g) => globHits(root, g, names))) return true;
  }
  return false;
}

/** The words of inline code (node -e, python -c) that could name a decision path: protect cannot tell its reads from writes. */
export const codeNames = (code: string[]): string[] =>
  code.flatMap((c) => c.split(/[\s'"`(),;=]+/)).filter((w) => /decisions|harness-decision|\.claude[\\/]rules/i.test(w));

const base = (t: string) => t.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
// The repo root or above holds docs/: a directory route into it may write decisions (unlike a bare rm, the guard's).
const asDir = (root: string, p: string): string => {
  const up = relative(resolve(root, p), resolve(root));
  return !up.startsWith('..') && !isAbsolute(up) ? 'docs' : p;
};
const isDir = (root: string, p: string): boolean => p.endsWith('/') || !!statSync(resolve(root, p), { throwIfNoEntry: false })?.isDirectory();
const owned = (root: string, p: string): boolean => {
  const rel = toRepoPath(root, p)?.toLowerCase() ?? '';
  return RULE_GLOB.test(rel) || (rel.startsWith(DIR) && DECISION_NAME.test(rel.slice(DIR.length)));
};

type Routes = { writes: string[]; removed: string[] };
/**
 * The words after cp, mv or install, split into the `-t DIR` / `--target-directory[=]DIR` folder and the rest. `-t` may
 * end a short cluster (`-rt DIR`) or carry its value (`-tDIR`, `-rtDIR`). rsync has no such flag (its -t is --times).
 */
function operands(ws: string[], targets: boolean): { target?: string; args: string[] } {
  const o: { target?: string; args: string[] } = { args: [] };
  for (let j = 0; j < ws.length; j++) {
    const t = ws[j]!;
    const k = targets && /^-[a-zA-Z]/.test(t) ? t.indexOf('t') : -1;
    if (targets && t === '--target-directory') o.target = ws[++j];
    else if (targets && t.startsWith('--target-directory=')) o.target = t.slice('--target-directory='.length);
    else if (k > 0) o.target = k < t.length - 1 ? t.slice(k + 1) : ws[++j];
    else if (!t.startsWith('-')) o.args.push(t);
  }
  return o;
}

// cp, mv, install and rsync into a directory: the files they leave there. Copying a folder's contents (`src/`, `src/.`)
// counts as a write to the directory itself. ponytail: option values (install -m 644) count as sources (harmless);
// a short flag that takes a value before t in a cluster (install -mt) is read as -t.
function copyRoutes(root: string, toks: string[], r: Routes): void {
  const i = toks.findIndex((t) => ['cp', 'mv', 'install', 'rsync'].includes(base(t)));
  if (i < 0) return;
  const { target, args } = operands(toks.slice(i + 1), base(toks[i]) !== 'rsync');
  if (target === undefined && args.length < 2) return;
  const dest = target ?? args.pop()!;
  if (base(toks[i]) === 'mv') r.removed.push(...args);
  if (target === undefined && !isDir(root, dest)) {
    if (base(toks[i]) === 'mv') r.removed.push(dest);
    return;
  }
  for (const src of args) {
    const res = /\/\.?$/.test(src) ? asDir(root, dest) : posix.join(dest, src.split(/[\\/]/).pop()!);
    r.removed.push(res);
    if (owned(root, res)) r.writes.push(res);
  }
}

// tar extracting into -C/--directory, unzip -d, and find's start paths when it deletes: removals of that directory.
function treeRoutes(root: string, toks: string[], r: Routes): void {
  const i = toks.findIndex((t) => ['tar', 'unzip', 'find'].includes(base(t)));
  if (i < 0) return;
  const args = toks.slice(i + 1);
  const valueOf = (short: string, long: string): string[] =>
    args.flatMap((t, j) => (t === short || t === long ? [args[j + 1] ?? ''] : long && t.startsWith(long + '=') ? [t.slice(long.length + 1)] : []));
  const name = base(toks[i]);
  let dirs: string[] = [];
  if (name === 'tar') {
    const key = /^-?[a-zA-Z]+$/.test(args[0] ?? '') ? args[0]!.replace(/^-/, '') : '';
    if (key.includes('x') || args.some((t) => ['-x', '--extract', '--get'].includes(t))) dirs = valueOf('-C', '--directory');
  } else if (name === 'unzip') dirs = valueOf('-d', '');
  else if (args.includes('-delete') || args.some((t, j) => /^-(exec|execdir|ok|okdir)$/.test(t) && ['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv'].includes(base(args[j + 1] ?? '')))) {
    const starts = args.slice(0, Math.max(0, args.findIndex((t) => /^[-(!]/.test(t)))).filter(Boolean);
    dirs = starts.length ? starts : ['.'];
  }
  r.removed.push(...dirs.filter(Boolean).map((d) => asDir(root, d)));
}

/** What the shell's directory routes write and remove, from each segment's words. */
export function decisionRoutes(root: string, segs: string[][]): Routes {
  const r: Routes = { writes: [], removed: [] };
  for (const toks of segs) {
    copyRoutes(root, toks, r);
    treeRoutes(root, toks, r);
  }
  return r;
}

export function decisionsDeny(root: string, config: HarnessConfig, writes: string[], removed: string[]): Decision | null {
  if (config?.checks.decisions === false) return null;
  const globs = [...writes, ...removed].filter((p) => p && GLOB.test(p));
  const plain = (ps: string[]) => ps.filter((p) => p && !GLOB.test(p));
  const hit = plain(writes).some((p) => isDecisionPath(root, p)) || plain(removed).some((p) => holdsDecisions(root, p)) || (globs.length > 0 && globDeny(root, globs));
  return hit ? { kind: 'deny', reason: DECISIONS_REASON, check: 'protect' } : null;
}
