// Staleness of team decisions (spec §9): dead globs, linked files changed since the decision was confirmed, expiry, size.
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import { childEnv } from '../budget/count-api.js';
import type { TeamDecision } from './decision-file.js';
import { renderRule } from './decision-rule.js';

export const GIT_TIMEOUT_MS = 2000;
const MAX_BUFFER = 64 * 1024 * 1024;
// A cloned repo's own config must not make these read-only calls run a program.
const SAFE = ['-c', 'core.fsmonitor=false'];
const DAY_MS = 86_400_000;

/** `ok` is exit 0. `reason` is set for a failure: `timeout`, `spawn: <msg>`, or git's stderr line for exit above 1. Exit 1 has none. */
export type Git = (args: string[]) => { ok: boolean; out: string; reason?: string };

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

export const gitIn = (root: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: childEnv() });
  if (r.error) return { ok: false, out: '', reason: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : `spawn: ${r.error.message}` };
  if (r.status === 0) return { ok: true, out: r.stdout };
  const reason = r.status === 1 ? undefined : (r.stderr || '').trim().split('\n')[0] || `git exited ${r.status ?? 'on a signal'}`;
  return { ok: false, out: '', ...(reason ? { reason } : {}) };
};

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const names = (out: string): string[] => out.split('\0').filter(Boolean);

class GitFailure extends Error {}

/** The ref to diff from, and whether it is the C4 fallback. '' when the decision has no commit to compare from. */
function pickRef(ask: (args: string[]) => boolean, run: (args: string[]) => string, d: TeamDecision): { ref: string; fallback: boolean } {
  const fileSha = run(['log', '-1', '--format=%H', '--', d.rel]).trim();
  if (!ask(['cat-file', '-e', `${d.verified_at}^{commit}`])) return { ref: fileSha, fallback: fileSha !== '' };
  if (fileSha && ask(['merge-base', '--is-ancestor', d.verified_at, fileSha])) return { ref: fileSha, fallback: false };
  return { ref: d.verified_at, fallback: false };
}

export function staleness(
  root: string, ds: TeamDecision[], o: { today: string; expiryDays: number; cap: number; git?: Git },
): { states: Staleness[]; note: string | null } {
  const git = o.git ?? gitIn(root);
  const run = (args: string[]): string => {
    const r = git([...SAFE, ...args]);
    if (!r.ok) throw new GitFailure(r.reason ?? 'git failed');
    return r.out;
  };
  // A yes/no question: exit 1 or 128 is "no", but a timeout or spawn error is a failure.
  const ask = (args: string[]): boolean => {
    const r = git([...SAFE, ...args]);
    if (!r.ok && (r.reason === 'timeout' || r.reason?.startsWith('spawn:'))) throw new GitFailure(r.reason);
    return r.ok;
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
    ds.forEach((d, i) => {
      const s = states[i]!;
      const match = d.paths.map((p) => picomatch(p, { dot: true }));
      s.dead = d.paths.filter((_, j) => !files.some((f) => match[j]!(f)));
      const { ref, fallback } = pickRef(ask, run, d);
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
