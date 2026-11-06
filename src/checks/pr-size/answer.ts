// The agent's own AskUserQuestion is the one ask after a warning (spec §14.3, "One ask"). Only the person's answer counts:
// an answer the agent put in the call is denied, and a PostToolUse clears the pause only with the token its clean PreToolUse saved.
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
// What Claude Code records when the person typed a message instead of answering.
const UNANSWERED = '[User did not answer';
const answered = (a: unknown): boolean => (typeof a === 'string' ? a.trim() !== '' && !a.startsWith(UNANSWERED) : Array.isArray(a) && a.length > 0);

/** The texts of the "PR size" questions in this call. */
function ours(input: Ctx['input']['tool_input']): string[] {
  const qs = input?.questions;
  return Array.isArray(qs) ? qs.flatMap((q) => (isObj(q) && q.header === ASK_HEADER && typeof q.question === 'string' ? [q.question] : [])) : [];
}
const key = (ctx: Ctx) => `${ctx.input.session_id}:${createHash('sha256').update(JSON.stringify(ctx.input.tool_input?.questions ?? null)).digest('hex')}`;

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
  writeJson(ctx.root, ASKED, { ...tokens(ctx.root), [key(ctx)]: Date.now() });
  return ALLOW;
}

/** PostToolUse: with its token (used once) and no `answers` in the call, any answer to a "PR size" question clears the current
 *  branch's pause. `tool_response.answers` maps each question's text to the chosen label (an array for multi-select). Never throws. */
export function clearOnAnswer(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  try {
    const qs = ours(ctx.input.tool_input);
    if (!qs.length) return ALLOW;
    const all = tokens(ctx.root);
    const k = key(ctx);
    if (!Object.hasOwn(all, k)) return ALLOW;
    delete all[k];
    writeJson(ctx.root, ASKED, all);
    const res = ctx.input.tool_response;
    const answers = isObj(res) && isObj(res.answers) ? res.answers : null;
    if (ctx.input.tool_input?.answers === undefined && answers && qs.some((q) => Object.hasOwn(answers, q) && answered(answers[q]))) clearPending(ctx, git, now);
  } catch (e) {
    process.stderr.write(`harness: pr-size pause clear failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return ALLOW;
}
