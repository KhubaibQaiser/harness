// Team decisions and their generated rules change only through `harness remember` (spec §6.2). No deny rule (C9).
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import picomatch from 'picomatch';
import { DECISIONS_DIR, isDecisionText } from '../core/decision-file.js';
import { RULE_GLOB } from '../core/decision-rule.js';
import type { HarnessConfig } from '../core/config.js';
import { toRepoPath } from '../core/paths.js';
import type { Decision } from '../hooks/types.js';

export const DECISIONS_REASON = 'Team decisions change only through harness remember, which asks the person first. Edit a decision by hand yourself, then run harness remember sync.';
export const DECISION_CONCRETE = ['docs', 'docs/decisions', '.claude/rules'];
const HEAD_BYTES = 4096; // enough for the frontmatter: MAX_PATHS globs of MAX_GLOB_CHARS plus the other keys
const DIR = DECISIONS_DIR.toLowerCase() + '/';
const GLOB = /[*?[{]/;

function head(abs: string): string {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
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
// What a glob may not match: the folders, the decision files and the generated rules that exist. Read only for a glob.
// A file whose name holds a glob character can't be a decision (its id would not match), so it is read as a glob.
const decisionNames = (root: string): string[] =>
  [...DECISION_CONCRETE, ...listed(root, DECISIONS_DIR).filter((p) => isDecisionPath(root, p)), ...listed(root, '.claude/rules').filter((p) => RULE_GLOB.test(p))].map((p) => p.toLowerCase());

/** The words of inline code (node -e, python -c) that could name a decision path: protect cannot tell its reads from writes. */
export const codeNames = (code: string[]): string[] =>
  code.flatMap((c) => c.split(/[\s'"`(),;=]+/)).filter((w) => /decisions|harness-decision/i.test(w));

export function decisionsDeny(root: string, config: HarnessConfig, writes: string[], removed: string[]): Decision | null {
  if (config?.checks.decisions === false) return null;
  const globs = [...writes, ...removed].filter((p) => p && GLOB.test(p));
  const plain = (ps: string[]) => ps.filter((p) => p && !GLOB.test(p));
  const hit = plain(writes).some((p) => isDecisionPath(root, p)) || plain(removed).some((p) => holdsDecisions(root, p)) ||
    (globs.length > 0 && ((names) => globs.some((g) => globHits(root, g, names)))(decisionNames(root)));
  return hit ? { kind: 'deny', reason: DECISIONS_REASON, check: 'protect' } : null;
}
