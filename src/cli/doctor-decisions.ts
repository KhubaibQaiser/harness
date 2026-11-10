// Team decision lines for `doctor` and `status` (spec §9). Offline apart from read-only local git; never blocks except on real errors.
import type { HarnessConfig } from '../core/config.js';
import { readDecisions, outOfSync, planSync } from '../core/decisions.js';
import { isStale, staleness, type Git } from '../core/decisions-stale.js';

type P = { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void };
interface Opts { today?: string; git?: Git }

// ponytail: a plain string: usage.test.ts flags this command name until the remember command exists.
const CMD = 'harness remember';
const SHOWN_FILES = 3;
const sha7 = (s: string): string => s.slice(0, 7);
const utcToday = (): string => new Date().toISOString().slice(0, 10);

function report(root: string, config: HarnessConfig, o: Opts) {
  const today = o.today ?? utcToday();
  const set = readDecisions(root, today);
  const plan = planSync(root, set, config.decisions, today);
  const active = set.decisions.filter((d) => d.status === 'active');
  const { states, note } = staleness(root, active, { today, expiryDays: config.decisions.expiry_days, cap: config.decisions.max_lines, ...(o.git ? { git: o.git } : {}) });
  return { set, plan, active, states, note };
}

export function decisionChecks(root: string, config: HarnessConfig, p: P, o: Opts = {}): void {
  const { set, plan, active, states, note } = report(root, config, o);
  const { expiry_days, max_lines } = config.decisions;
  for (const e of set.errors) p.fix(e, `correct it by hand, then run ${CMD} sync`);
  if (outOfSync(plan)) p.fix('decision rules are out of sync with docs/decisions/', `run ${CMD} sync`);
  for (const f of plan.foreign) p.fix(`${f} is named like a harness decision rule but isn't harness's`, 'rename it');
  if (!set.errors.length && !outOfSync(plan) && !plan.foreign.length)
    p.ok(set.decisions.length ? `decisions: ${active.length} active, rules in sync` : 'no team decisions yet');
  if (note) p.note(note);
  active.forEach((d, i) => {
    const s = states[i]!;
    for (const g of s.dead) p.note(`decision ${d.id} is stale: ${g} matches no tracked file`, `fix its paths by hand, or run ${CMD} retire ${d.id}`);
    if (s.changed.length) {
      const first = s.changed.slice(0, SHOWN_FILES).join(', ') + (s.changed.length > SHOWN_FILES ? '…' : '');
      p.note(`decision ${d.id} is stale: ${s.changed.length} linked file${s.changed.length === 1 ? '' : 's'} changed since ${sha7(s.ref)} (${first})`, `check it still holds, then run ${CMD} confirm ${d.id}`);
    }
    if (s.expired) p.note(`decision ${d.id} expired: last confirmed ${d.verified_on}, over ${expiry_days} days ago, so its rule no longer loads after the next sync`, `run ${CMD} confirm ${d.id} or ${CMD} retire ${d.id}`);
    if (s.oversized) p.note(`decision ${d.id} is oversized: its rule is ${s.oversized.lines} lines, cap ${max_lines}, so it is cut`, `shorten it by hand, then run ${CMD} sync`);
    if (s.fallback) p.note(`decision ${d.id}: verified_at ${sha7(d.verified_at)} is not in this clone; compared from the decision file's last commit`);
  });
}

export function decisionsStatusLine(root: string, config: HarnessConfig, o: Opts = {}): string {
  const { plan, active, states } = report(root, config, o);
  if (!active.length) return 'Decisions: none';
  return `Decisions: ${active.length} active (${states.filter(isStale).length} stale, ${states.filter((s) => s.expired).length} expired), rules ${outOfSync(plan) ? 'out of sync' : 'in sync'}`;
}
