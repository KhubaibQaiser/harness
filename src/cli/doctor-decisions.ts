// Team decision lines for `doctor` and `status` (spec §9). The rows and their copy live in `decisionLines`, which
// `harness remember check` shares; this file only prints them. Offline apart from read-only local git.
import type { HarnessConfig } from '../core/config.js';
import type { Git } from '../core/decisions-stale.js';
import { decisionLines } from './remember-read.js';

type P = { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void };
interface Opts { today?: string; git?: Git }

const report = (root: string, config: HarnessConfig, o: Opts) => decisionLines(root, config, o.today ?? new Date().toISOString().slice(0, 10), o.git);

export function decisionChecks(root: string, config: HarnessConfig, p: P, o: Opts = {}): void {
  for (const l of report(root, config, o).lines) {
    if (l.level === 'ok') p.ok(l.what);
    else if (l.level === 'fix') p.fix(l.what, l.next ?? '');
    else p.note(l.what, l.next);
  }
}

export function decisionsStatusLine(root: string, config: HarnessConfig, o: Opts = {}): string {
  const s = report(root, config, o).summary;
  if (s.unreadable) return `Decisions: unreadable (${s.unreadable})`;
  const counts = s.unchecked ? `${s.expired} expired, staleness unchecked` : `${s.stale} stale, ${s.expired} expired`;
  const head = s.active ? `${s.active} active (${counts}), rules ${s.inSync ? 'in sync' : 'out of sync'}` : 'none';
  return `Decisions: ${head}${s.invalid ? `, ${s.invalid} invalid` : ''}`;
}
