import { GATES } from '../core/gates.js';
import { isPaused } from '../core/pause.js';
import type { Check, Ctx } from '../hooks/check.js';
import { capMessage, shown } from '../hooks/io.js';

export const CARD_LINE_MAX = 300;
export const CARD_MAX = 1200;
export const NOTICE_MAX = 160;
const RED_SHOWN = 3;
const LOCKED_SHOWN = 5;
const SENTENCE_END = '. ';

/** Card paths come from harness state, so they are untrusted: escaped, and never able to start a new line. */
const safe = (s: string): string => shown(s).replace(/[\n\t]/g, ' ');

/** Up to `limit` paths, then `, +<k> more`. */
const list = (paths: string[], limit: number): string => {
  const more = paths.length - limit;
  return paths.slice(0, limit).map(safe).join(', ') + (more > 0 ? `, +${more} more` : '');
};

function tddLine(ctx: Ctx): string {
  if (!ctx.config.checks.tdd) return 'TDD: off';
  if (isPaused(ctx.root, ctx.input.session_id)) return 'TDD: paused for this session';
  const red = ctx.state.redTests;
  return `TDD: on; test files written this session: ${red.length}` + (red.length ? ` (${list(red, RED_SHOWN)})` : '');
}

function changedFiles(noticed: string | undefined): string[] {
  try {
    const v: unknown = noticed ? JSON.parse(noticed) : [];
    return Array.isArray(v) ? v.flatMap((e) => (Array.isArray(e) && typeof e[0] === 'string' ? [e[0]] : [])) : [];
  } catch {
    return [];
  }
}

function pendingLine(ctx: Ctx): string {
  const files = changedFiles(ctx.state.harnessNoticed);
  const items = files.length ? [`harness files changed (${files.map(safe).join(', ')}): tell the person; the next Stop blocks once until they review it`] : [];
  for (const n of (ctx.state.pendingNotice ?? '').split('\n')) {
    const first = n.includes(SENTENCE_END) ? n.slice(0, n.indexOf(SENTENCE_END) + 1) : n;
    if (first.trim()) items.push(capMessage(safe(first.trim()), NOTICE_MAX));
  }
  return `Pending: ${items.join('; ') || 'none'}`;
}

/** The 5-line state card re-added after compaction (spec 9). */
export function stateCard(ctx: Ctx): string {
  const gates = ctx.configErrors?.length
    ? 'Gates: config invalid, so edits and Stop are blocked until a person fixes .harness/config.yaml'
    : `Gates: ${GATES.map(([label, key]) => `${label} ${ctx.config.checks[key] ? 'on' : 'off'}`).join(', ')}`;
  const locked = ctx.state.lockedTests;
  return capMessage([
    'Harness state (re-added after compaction; hooks still enforce every gate):',
    gates,
    tddLine(ctx),
    `Locked tests (failed this session, not yet passing; fix the code, not the test): ${locked.length ? list(locked, LOCKED_SHOWN) : 'none'}`,
    pendingLine(ctx),
  ].map((l) => capMessage(l, CARD_LINE_MAX)).join('\n'), CARD_MAX);
}

export const stateCardCheck: Check = {
  name: 'state-card',
  events: ['SessionStart'],
  pure: true,
  run: (ctx) => (ctx.input.source === 'compact' ? { kind: 'context', text: stateCard(ctx), check: 'state-card' } : { kind: 'allow' }),
};
