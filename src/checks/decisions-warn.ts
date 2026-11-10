// Stop warning for code covered by a team decision (spec §8.2, D7): a note, never a block, no model call. Fail-open.
import { shown } from '../core/decision-file.js';
import { outOfSync, planSync, readDecisions } from '../core/decisions.js';
import { gitIn, staleness, type Git } from '../core/decisions-stale.js';
import { matches } from '../core/paths.js';
import type { Ctx } from '../hooks/check.js';

// Staleness costs git calls per decision: a Stop names at most this many; the rest wait for the next Stop.
const MAX_PER_STOP = 10;
const OUT_OF_SYNC = 'Rules are out of sync: run harness remember sync.';

/** One §8.2 line per active decision whose paths match a changed file and that wasn't warned about yet this session. */
export function decisionWarnings(ctx: Ctx, changed: string[], git?: Git): string[] {
  try {
    const { root, config, state } = ctx;
    const today = new Date().toISOString().slice(0, 10);
    const warned = state.decisionsWarned ?? [];
    const set = readDecisions(root, today);
    const hit = set.decisions.filter((d) => d.status === 'active' && !warned.includes(d.id) && changed.some((f) => matches(f, d.paths))).slice(0, MAX_PER_STOP);
    if (!hit.length) return [];
    const { states, note } = staleness(root, hit, { today, expiryDays: config.decisions.expiry_days, cap: config.decisions.max_lines, git: git ?? gitIn(root) });
    const lines = hit.map((d, i) => {
      const s = states[i]!;
      const extra = [
        s.expired ? `It is expired (last confirmed ${d.verified_on}).` : '',
        s.dead[0] ? `Its path ${shown(s.dead[0])} no longer matches any file.` : '',
      ].filter(Boolean);
      return [`Harness: you changed code covered by team decision \`${d.id}\` ("${shown(d.title)}"). If it still holds, ask the person to run \`harness remember confirm ${d.id}\`; if not, \`harness remember retire ${d.id}\`.`, ...extra].join(' ');
    });
    if (note) lines.push(`Harness: ${note}.`);
    try {
      if (outOfSync(planSync(root, set, config.decisions, today))) lines.push(OUT_OF_SYNC);
    } catch {
      // an unreadable rules folder is doctor's to report; the warning still stands
    }
    ctx.save({ ...ctx.state, decisionsWarned: [...warned, ...hit.map((d) => d.id)] });
    return lines;
  } catch {
    return [];
  }
}
