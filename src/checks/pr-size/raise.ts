// Raising the limit for a branch (spec §14.4): the person approves `--pr-size-raise` in a dialog; PostToolUse then records it.
import { esc, type HarnessConfig } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import type { Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import type { PrTarget, RaiseArgs } from './detect.js';
import { plainBranch } from './measure.js';
import { RAISE_MAX_FILES, RAISE_MAX_LINES, readProgress, writeProgress } from './progress.js';

export type Cur = { name: string | null; late: boolean };
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

function int(v: string, min: number, max: number): number | null {
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  return n >= min && n <= max ? n : null;
}

/** The §14.4 ranges: lines from max_lines + 1 to 100000, files (default max_files) from max_files to 10000. */
export function raiseLimits(t: RaiseArgs, c: HarnessConfig['pr_size']): { lines: number; files: number } | { error: string } {
  const lines = t.lines === undefined ? null : int(t.lines, c.max_lines + 1, RAISE_MAX_LINES);
  if (lines === null) return { error: `--lines must be an integer from ${c.max_lines + 1} to ${RAISE_MAX_LINES}` };
  const files = t.files === undefined ? c.max_files : int(t.files, c.max_files, RAISE_MAX_FILES);
  if (files === null) return { error: `--files must be an integer from ${c.max_files} to ${RAISE_MAX_FILES}` };
  return { lines, files };
}

/** The first raise with valid values: the one shown at PreToolUse is the one recorded at PostToolUse. */
export function validRaise(ctx: Ctx, targets: PrTarget[]): { lines: number; files: number } | null {
  for (const t of targets) {
    const r = t.kind === 'raise' ? raiseLimits(t, ctx.config.pr_size) : null;
    if (r && !('error' in r)) return r;
  }
  return null;
}

/** Ask (attended) or deny (unattended). A detached HEAD or an odd name allows, since the entry then fails by itself; a
 *  branch lookup that failed still asks, so a slow git never lets a raise through unasked. */
export function raiseDecision(ctx: Ctx, r: { lines: number; files: number }, cur: Cur): Decision | null {
  if (!cur.late && (cur.name === null || !plainBranch(cur.name))) return null;
  if (ctx.unattended) return { kind: 'deny', check: 'pr-size', reason: 'Blocked by pr-size: only a person can raise the size limit, and no person is here to approve it.' };
  const branch = cur.name === null ? 'the current branch' : `\`${esc(cur.name)}\``;
  return { kind: 'ask', check: 'pr-size', reason: `Confirm: raise the pull request size limit for ${branch} to ${count(r.lines, 'line')} and ${count(r.files, 'file')}. Harness then warns again only above that.` };
}

/** PostToolUse, after the approved command ran: keep the raise on the branch's progress entry and log `pr-size-raised`. */
export function recordRaise(ctx: Ctx, r: { lines: number; files: number }, cur: Cur): void {
  const branch = cur.name;
  if (cur.late || branch === null || !plainBranch(branch)) return;
  const all = readProgress(ctx.root);
  const ts = new Date().toISOString();
  const prev = Object.hasOwn(all, branch) ? all[branch]! : { base: ctx.config.stop.base_ref, fired: [], lines: 0, files: 0, ts };
  writeProgress(ctx.root, branch, { ...prev, raise: { lines: r.lines, files: r.files, ts } });
  appendEvent(ctx.root, { ts, session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-raised', reason: `${esc(branch)} ${count(r.lines, 'line')} ${count(r.files, 'file')}` });
}
