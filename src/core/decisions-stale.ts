// Staleness of team decisions (spec §9): dead globs, linked files changed since the decision was confirmed, expiry, size.
import { spawnSync } from 'node:child_process';
import picomatch from 'picomatch';
import { childEnv } from '../budget/count-api.js';
import type { TeamDecision } from './decision-file.js';
import { renderRule } from './decision-rule.js';

export const GIT_TIMEOUT_MS = 2000;
const DAY_MS = 86_400_000;

/** `ok` is exit 0. `reason` is set only for a real failure (timeout, spawn error, exit above 1); exit 1 is a plain "no". */
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

const gitIn = (root: string): Git => (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: childEnv() });
  if (r.error) return { ok: false, out: '', reason: (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : r.error.message };
  if (r.status === 0) return { ok: true, out: r.stdout };
  const reason = r.status === 1 ? undefined : (r.stderr || '').trim().split('\n')[0] || `git exited ${r.status ?? 'on a signal'}`;
  return { ok: false, out: '', ...(reason ? { reason } : {}) };
};

const days = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const names = (out: string): string[] => out.split('\0').filter(Boolean);

class GitFailure extends Error {}

/** The ref to diff from, and whether it is the C4 fallback. '' when the decision has no commit to compare from. */
function pickRef(git: Git, run: (args: string[]) => string, d: TeamDecision): { ref: string; fallback: boolean } {
  const fileSha = run(['log', '-1', '--format=%H', '--', d.rel]).trim();
  if (!git(['cat-file', '-e', `${d.verified_at}^{commit}`]).ok) return { ref: fileSha, fallback: true };
  if (fileSha && git(['merge-base', '--is-ancestor', d.verified_at, fileSha]).ok) return { ref: fileSha, fallback: false };
  return { ref: d.verified_at, fallback: false };
}

export function staleness(
  root: string, ds: TeamDecision[], o: { today: string; expiryDays: number; cap: number; git?: Git },
): { states: Staleness[]; note: string | null } {
  const git = o.git ?? gitIn(root);
  const run = (args: string[]): string => {
    const r = git(args);
    if (!r.ok) throw new GitFailure(r.reason ?? 'git failed');
    return r.out;
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
      const { ref, fallback } = pickRef(git, run, d);
      Object.assign(s, { ref, fallback });
      if (!ref) return;
      if (!diffs.has(ref)) diffs.set(ref, names(run(['diff', '--name-only', '-z', ref, 'HEAD'])));
      s.changed = diffs.get(ref)!.filter((f) => f !== d.rel && match.some((m) => m(f)));
    });
    return { states, note: null };
  } catch (e) {
    if (!(e instanceof GitFailure)) throw e;
    for (const s of states) Object.assign(s, { dead: [], changed: [] });
    return { states, note: `couldn't check decision staleness (${e.message})` };
  }
}
