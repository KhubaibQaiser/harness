// The agent's own AskUserQuestion is the one ask after a warning (spec §14.3, "One ask"). Only the person's answer counts:
// an answer the agent put in the call is denied, and a PostToolUse clears the pause only with the token its clean PreToolUse saved.
// Claude Code 2.1.285 (read statically, to be confirmed live): the person's choice comes back as the permission prompt's
// updatedInput, `{ ...input, answers, annotations, afkTimeoutMs? }`, so PostToolUse sees it in `tool_input.answers`.
import { createHash } from 'node:crypto';
import { isObj } from '../../core/config.js';
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
export const FORGED = 'Blocked by pr-size: the person must answer the PR size question themselves. Ask it again without `answers`.';
// Claude Code's own "no answer" value (2.1.285), and the placeholder older transcripts record.
const NOTES_ONLY = '(notes only)';
const UNANSWERED = '[User did not answer';
const real = (a: unknown) => typeof a === 'string' && a.trim() !== '' && a.trim() !== NOTES_ONLY && !a.startsWith(UNANSWERED);
const answered = (a: unknown): boolean => (Array.isArray(a) ? a.some(real) : real(a));

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
  const given = ctx.input.tool_input?.answers;
  if (given !== undefined && (!isObj(given) || qs.some((q) => Object.hasOwn(given, q)))) return { kind: 'deny', check: 'pr-size', reason: FORGED };
  writeJson(ctx.root, ASKED, { ...tokens(ctx.root), [key(ctx, qs)]: Date.now() });
  return ALLOW;
}

/** PostToolUse: with its token (used once), any real answer to a "PR size" question clears the current branch's pause. The token
 *  proves the agent didn't pre-fill `answers` (that call was denied and never ran). An auto-continue timeout (`afkTimeoutMs`)
 *  counts as no answer. `answers` maps each question's text to the label or typed text. Never throws. */
export function clearOnAnswer(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  try {
    const qs = ours(ctx.input.tool_input);
    if (!qs.length) return ALLOW;
    const all = tokens(ctx.root);
    const k = key(ctx, qs);
    if (!Object.hasOwn(all, k)) return ALLOW;
    delete all[k];
    writeJson(ctx.root, ASKED, all);
    const input = ctx.input.tool_input ?? {};
    const res = ctx.input.tool_response;
    const answers = isObj(input.answers) ? input.answers : isObj(res) && isObj(res.answers) ? res.answers : null;
    const timedOut = 'afkTimeoutMs' in input || (isObj(res) && 'afkTimeoutMs' in res);
    if (!timedOut && answers && qs.some((q) => Object.hasOwn(answers, q) && answered(answers[q]))) clearPending(ctx, git, now);
  } catch (e) {
    process.stderr.write(`harness: pr-size pause clear failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return ALLOW;
}
