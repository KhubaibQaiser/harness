// Staleness of team decisions (spec §9): dead globs, linked files changed since the decision was confirmed, expiry, size.
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import { childEnv } from '../budget/count-api.js';
import { DECISIONS_DIR, type TeamDecision } from './decision-file.js';
import { renderRule } from './decision-rule.js';

export const GIT_TIMEOUT_MS = 2000;
const MAX_BUFFER = 64 * 1024 * 1024;
// A cloned repo's own config must not make these read-only calls run a program.
const SAFE = ['-c', 'core.fsmonitor=false'];
const DAY_MS = 86_400_000;

/** `ok` is exit 0. `reason` is set for a failure: `timeout`, `spawn: <msg>`, or git's stderr line for exit above 1. Exit 1 has none. */
export type Git = (args: string[], input?: string) => { ok: boolean; out: string; reason?: string };

export interface Staleness {
  id: string;
  dead: string[];
  changed: string[];
  ref: string;
  fallback: boolean;
  expired: boolean;
  oversized: { lines: number } | null;
}

export const isStale = (s: Staleness): boolean => s.dead.length > 0 || s.changed.length > 0;

export const gitIn = (root: string): Git => (args, input) => {
  const r = spawnSync('git', args, { cwd: root, ...(input === undefined ? {} : { input }), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: childEnv() });
  if (r.error) return { ok: false, out: '', reason: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : `spawn: ${r.error.message}` };
  if (r.status === 0) return { ok: true, out: r.stdout };
  const reason = r.status === 1 ? undefined : (r.stderr || '').trim().split('\n')[0] || `git exited ${r.status ?? 'on a signal'}`;
  return { ok: false, out: '', ...(reason ? { reason } : {}) };
};

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const names = (out: string): string[] => out.split('\0').filter(Boolean);

class GitFailure extends Error {}

/** Which of these commits exist here: one `cat-file --batch-check`. */
function presentShas(run: (args: string[], input?: string) => string, shas: string[]): Set<string> {
  if (!shas.length) return new Set();
  const lines = run(['cat-file', '--batch-check'], shas.map((x) => `${x}^{commit}\n`).join('')).split('\n');
  return new Set(shas.filter((_, i) => / commit \d+$/.test(lines[i] ?? '')));
}

/** The newest commit touching each file under docs/decisions/: one `git log` over all of them (newest first, so the first sighting wins). */
function lastCommits(run: (args: string[]) => string): Map<string, string> {
  const out = new Map<string, string>();
  let sha = '';
  let head = false;
  for (const t of run(['log', '-z', '--format=%x01%H', '--name-only', '--no-renames', '--', DECISIONS_DIR]).split('\0')) {
    if (t.startsWith('\x01')) { sha = t.slice(1); head = true; continue; }
    const name = head && t.startsWith('\n') ? t.slice(1) : t;
    head = false;
    if (name && !out.has(name)) out.set(name, sha);
  }
  return out;
}

/** The ref to diff from, and whether it is the C4 fallback. '' when the decision has no commit to compare from. */
function pickRef(isAncestor: (a: string, b: string) => boolean, here: Set<string>, fileSha: string, d: TeamDecision): { ref: string; fallback: boolean } {
  if (!here.has(d.verified_at)) return { ref: fileSha, fallback: fileSha !== '' };
  if (fileSha && isAncestor(d.verified_at, fileSha)) return { ref: fileSha, fallback: false };
  return { ref: d.verified_at, fallback: false };
}

export function staleness(
  root: string, ds: TeamDecision[], o: { today: string; expiryDays: number; cap: number; git?: Git },
): { states: Staleness[]; note: string | null } {
  const git = o.git ?? gitIn(root);
  const run = (args: string[], input?: string): string => {
    const r = git([...SAFE, ...args], input);
    if (!r.ok) throw new GitFailure(r.reason ?? 'git failed');
    return r.out;
  };
  // A yes/no question: exit 1 or 128 is "no", but a timeout or spawn error is a failure. One answer per distinct pair.
  const pairs = new Map<string, boolean>();
  const isAncestor = (x: string, y: string): boolean => {
    const k = `${x} ${y}`;
    if (!pairs.has(k)) {
      const r = git([...SAFE, 'merge-base', '--is-ancestor', x, y]);
      if (!r.ok && (r.reason === 'timeout' || r.reason?.startsWith('spawn:'))) throw new GitFailure(r.reason);
      pairs.set(k, r.ok);
    }
    return pairs.get(k)!;
  };
  const states: Staleness[] = ds.map((d) => {
    const rule = renderRule(d, o.cap);
    return {
      id: d.id, dead: [], changed: [], ref: '', fallback: false,
      expired: days(d.verified_on, o.today) > o.expiryDays,
      oversized: rule.oversized ? { lines: rule.lines } : null,
    };
  });
  try {
    if (ds.length === 0) return { states, note: null };
    const files = names(run(['ls-files', '-z']));
    const diffs = new Map<string, string[]>();
    const here = presentShas(run, [...new Set(ds.map((d) => d.verified_at))]);
    const last = lastCommits(run);
    ds.forEach((d, i) => {
      const s = states[i]!;
      const match = d.paths.map((p) => picomatch(p, { dot: true }));
      s.dead = d.paths.filter((_, j) => !files.some((f) => match[j]!(f)));
      const { ref, fallback } = pickRef(isAncestor, here, last.get(d.rel) ?? '', d);
      Object.assign(s, { ref, fallback });
      if (!ref) return;
      if (!diffs.has(ref)) diffs.set(ref, names(run(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', ref, 'HEAD'])));
      s.changed = diffs.get(ref)!.filter((f) => f !== d.rel && match.some((m) => m(f)));
    });
    return { states, note: null };
  } catch (e) {
    if (!(e instanceof GitFailure)) throw e;
    for (const s of states) Object.assign(s, { dead: [], changed: [], ref: '', fallback: false });
    return { states, note: `couldn't check decision staleness (${e.message})` };
  }
}
