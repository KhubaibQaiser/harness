// The agent's own AskUserQuestion is the one ask after a warning (spec §14.3, "One ask"). Only the person's answer counts:
// an answer the agent put in the call is denied, and a PostToolUse clears the pause only with the token its clean PreToolUse saved.
// The docs name only `questions` and `answers` (the selected option label). `response`, `afkTimeoutMs` and `followUp` are on no
// docs page (read from the 2.1.285 binary), so they may only make the result stricter: `response` alone never clears the pause.
import { createHash } from 'node:crypto';
import { isObj } from '../../core/config.js';
import { appendEvent, readEvents } from '../../core/events.js';
import type { Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { type Git, realGit } from './measure.js';
import { ASK_HEADER, clearPending } from './progress.js';
import { readJson, writeJson } from './records.js';

const ASKED = '.harness/state/pr-size-question.json';
// A question left open longer than this records nothing; the pause dialog then asks.
const TTL_MS = 86_400_000;
const MAX_BYTES = 100_000;
const ALLOW: Decision = { kind: 'allow' };
export const FORGED = 'Blocked by pr-size: the person must answer the PR size question themselves. Ask it again without `answers` or `response`.';
// Claude Code's own "no answer" value (2.1.285), and the placeholder older transcripts record.
const NOTES_ONLY = '(notes only)';
const UNANSWERED = '[User did not answer';
const real = (a: unknown) => typeof a === 'string' && a.trim() !== '' && a.trim() !== NOTES_ONLY && !a.startsWith(UNANSWERED);
const answered = (a: unknown): boolean => (Array.isArray(a) ? a.some(real) : real(a));

const KNOWN = new Set(['questions', 'answers', 'annotations', 'response', 'afkTimeoutMs', 'followUp']);
/** A top-level key we don't know in the call or its result means Claude Code changed the shape: log it once per session. */
const noted = new Set<string>(); // sessions already logged by this process, so later calls skip the events read
function noteShape(ctx: Ctx): void {
  const sid = ctx.input.session_id, id = `${ctx.root}:${sid}`;
  if (noted.has(id)) return;
  const res = ctx.input.tool_response;
  const odd = [...Object.keys(ctx.input.tool_input ?? {}), ...(isObj(res) ? Object.keys(res) : [])].filter((k) => !KNOWN.has(k));
  if (!odd.length) return;
  noted.add(id);
  if (!readEvents(ctx.root).some((e) => e.session === sid && e.decision === 'ask-shape-unknown')) {
    appendEvent(ctx.root, { ts: new Date().toISOString(), session: sid, check: 'pr-size', decision: 'ask-shape-unknown', reason: odd.slice(0, 5).join(', ').slice(0, 100) });
  }
}

/** The texts of the "PR size" questions in this call. */
function ours(input: Ctx['input']['tool_input']): string[] {
  const qs = input?.questions;
  return Array.isArray(qs) ? qs.flatMap((q) => (isObj(q) && q.header === ASK_HEADER && typeof q.question === 'string' ? [q.question] : [])) : [];
}
// Keyed on our questions' header and text only, so a field Claude Code adds to a question (`kind`) keeps the same key.
const key = (ctx: Ctx, qs: string[]) => `${ctx.input.session_id}:${createHash('sha256').update(JSON.stringify([ASK_HEADER, qs])).digest('hex')}`;

function tokens(root: string): Record<string, number> {
  const raw = readJson(root, ASKED, MAX_BYTES);
  const now = Date.now();
  return Object.fromEntries(isObj(raw) ? Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number' && now - e[1] < TTL_MS) : []);
}

/** PreToolUse: a "PR size" question that carries its own answer is denied; a clean one saves a one-time token. */
export function preAnswer(ctx: Ctx): Decision {
  const qs = ours(ctx.input.tool_input);
  if (!qs.length) return ALLOW;
  const { answers: given, response } = ctx.input.tool_input ?? {};
  const prefilled = response !== undefined || (given !== undefined && (!isObj(given) || qs.some((q) => Object.hasOwn(given, q))));
  if (prefilled) return { kind: 'deny', check: 'pr-size', reason: FORGED };
  writeJson(ctx.root, ASKED, { ...tokens(ctx.root), [key(ctx, qs)]: Date.now() });
  return ALLOW;
}

/** PostToolUse: with its token (used once), a real answer in `answers` to a "PR size" question clears the current branch's pause.
 *  The token proves the agent didn't pre-fill it (that call was denied and never ran). `response` alone is no answer, and an
 *  auto-continue timeout (`afkTimeoutMs`) or a request for more questions (`followUp`) cancels one. Never throws. */
export function clearOnAnswer(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  try {
    const qs = ours(ctx.input.tool_input);
    if (!qs.length) return ALLOW;
    noteShape(ctx);
    const all = tokens(ctx.root);
    const k = key(ctx, qs);
    if (!Object.hasOwn(all, k)) return ALLOW;
    delete all[k];
    writeJson(ctx.root, ASKED, all);
    const input = ctx.input.tool_input ?? {};
    const res = ctx.input.tool_response;
    const answers = isObj(input.answers) ? input.answers : isObj(res) && isObj(res.answers) ? res.answers : null;
    const field = (name: string): unknown => input[name] ?? (isObj(res) ? res[name] : undefined);
    const hit = answers !== null && qs.some((q) => Object.hasOwn(answers, q) && answered(answers[q]));
    if (hit && field('afkTimeoutMs') === undefined && field('followUp') !== true) clearPending(ctx, git, now);
  } catch (e) {
    process.stderr.write(`harness: pr-size pause clear failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return ALLOW;
}
