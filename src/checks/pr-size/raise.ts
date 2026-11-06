// Raising the limit for a branch (spec §14.4): the person approves `--pr-size-raise` in a dialog; PostToolUse then records it,
// only on the branch that dialog named.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { esc, type HarnessConfig, isObj } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import type { Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import type { PrTarget, RaiseArgs } from './detect.js';
import { count, plainBranch } from './measure.js';
import { RAISE_MAX_FILES, RAISE_MAX_LINES, readProgress, writeProgress } from './progress.js';

export type Cur = { name: string | null; late: boolean };
type Limits = { lines: number; files: number };
export const ASKED = '.harness/state/pr-raise-asked.json';
// An ask answered later than this records nothing (the agent runs the raise again).
const ASK_TTL_MS = 3_600_000;
const MAX_BYTES = 100_000;
const DENY_UNATTENDED = 'Blocked by pr-size: only a person can raise the size limit, and no person is here to approve it.';
const DENY_DETACHED = 'Blocked by pr-size: a raise needs a checked-out branch with a plain name. Check out the branch to raise, then run the raise on its own.';

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

// A branch, directory or repo change in the same command could make PostToolUse record a branch the person wasn't asked
// about. Matched on the whole text, so a false match only denies, and the agent runs the raise on its own.
const MOVES = /(^|[\s;&|(`])(cd|pushd|popd)(\s|$)|\bgit\b.*\s(checkout|switch|-C)(\s|$)|\bworktree\s+add\b|--git-dir\b|\bGIT_(DIR|WORK_TREE)=/;
export const ALONE = 'Blocked by pr-size: run one `--pr-size-raise` on its own, with no second raise and no branch, directory or repo change in the same command.';

/** True when a raise isn't alone: more than one raise, or a raise beside a branch, directory or repo change. */
export function raiseCombined(command: string, targets: PrTarget[]): boolean {
  const raises = targets.filter((t) => t.kind === 'raise').length;
  return raises > 1 || (raises === 1 && MOVES.test(command));
}

/** PreToolUse. An unattended raise is denied before anything else; then a raise that isn't alone, or on a detached or odd
 *  HEAD, is denied. Invalid values allow (the entry then fails by itself). A branch lookup that failed still asks, and
 *  records nothing, since no branch was saved. Null: no raise in the command. */
export function preRaise(ctx: Ctx, command: string, targets: PrTarget[], cur: () => Cur): Decision | null {
  const raises = targets.filter((t) => t.kind === 'raise');
  if (!raises.length) return null;
  if (ctx.unattended) return { kind: 'deny', check: 'pr-size', reason: DENY_UNATTENDED };
  if (raiseCombined(command, targets)) return { kind: 'deny', check: 'pr-size', reason: ALONE };
  const r = raiseLimits(raises[0]!, ctx.config.pr_size);
  if ('error' in r) return null;
  const c = cur();
  if (!c.late && (c.name === null || !plainBranch(c.name))) return { kind: 'deny', check: 'pr-size', reason: DENY_DETACHED };
  if (c.name !== null) saveAsked(ctx, command, { branch: c.name, lines: r.lines, files: r.files, ts: Date.now() });
  const branch = c.name === null ? 'the current branch' : `\`${esc(c.name)}\``;
  return { kind: 'ask', check: 'pr-size', reason: `Confirm: raise the pull request size limit for ${branch} to ${count(r.lines, 'line')} and ${count(r.files, 'file')}. Harness then warns again only above that.` };
}

const askKey = (ctx: Ctx, command: string) => `${ctx.input.session_id ?? ''}:${createHash('sha256').update(command).digest('hex')}`;

type Asked = { branch: string; lines: number; files: number; ts: number };
function readAsked(root: string): Record<string, Asked> {
  const out: Record<string, Asked> = Object.create(null);
  let raw: unknown;
  try {
    if (statSync(join(root, ASKED)).size > MAX_BYTES) return out;
    raw = JSON.parse(readFileSync(join(root, ASKED), 'utf8'));
  } catch {
    return out;
  }
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (isObj(v) && typeof v.branch === 'string' && typeof v.ts === 'number' && Number.isInteger(v.lines) && Number.isInteger(v.files)) out[k] = { branch: v.branch, lines: v.lines as number, files: v.files as number, ts: v.ts };
  }
  return out;
}

/** Writes the asked entries, dropping expired ones; `set` adds one, null removes `key`. */
function writeAsked(root: string, key: string, set: Asked | null): void {
  const now = Date.now();
  const all = Object.fromEntries(Object.entries(readAsked(root)).filter(([k, v]) => k !== key && now - v.ts < ASK_TTL_MS));
  if (set) all[key] = set;
  mkdirSync(dirname(join(root, ASKED)), { recursive: true });
  writeAtomic(join(root, ASKED), JSON.stringify(all) + '\n');
}

function saveAsked(ctx: Ctx, command: string, a: Asked): void {
  writeAsked(ctx.root, askKey(ctx, command), a);
}

/** Why PostToolUse records nothing, or null to record. `asked`: the branch and values the dialog named for this exact command. */
function skipReason(ctx: Ctx, r: Limits, c: Cur, asked: Asked | undefined): string | null {
  if (!asked || Date.now() - asked.ts >= ASK_TTL_MS) return 'no matching ask for this command';
  if (c.late || c.name !== asked.branch) return `HEAD is no longer \`${esc(asked.branch)}\``;
  if (r.lines !== asked.lines || r.files !== asked.files) return `the values changed since the dialog (${asked.lines}/${asked.files})`;
  const line = JSON.stringify({ branch: asked.branch, lines: r.lines, files: r.files });
  if (!JSON.stringify(ctx.input.tool_response ?? '').includes(JSON.stringify(line).slice(1, -1))) return 'the raise command did not succeed';
  return null;
}

/** PostToolUse, after the approved command ran: record the raise only on the branch the dialog named, if HEAD is still
 *  on it and the entry printed it; otherwise record nothing and log `pr-size-raise-skipped`. */
export function postRaise(ctx: Ctx, command: string, targets: PrTarget[], cur: () => Cur): void {
  const raise = targets.find((t) => t.kind === 'raise');
  const r = raise && !raiseCombined(command, targets) ? raiseLimits(raise, ctx.config.pr_size) : null;
  if (!r || 'error' in r) return;
  const key = askKey(ctx, command);
  const asked = readAsked(ctx.root)[key];
  if (asked) writeAsked(ctx.root, key, null);
  const why = skipReason(ctx, r, cur(), asked);
  const ts = new Date().toISOString();
  if (why) return appendEvent(ctx.root, { ts, session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-raise-skipped', reason: why });
  recordRaise(ctx, r, asked!.branch, ts);
}

function recordRaise(ctx: Ctx, r: Limits, branch: string, ts: string): void {
  // A raise also answers this branch's pause, so `pending` is dropped (spec §14.5).
  const all = readProgress(ctx.root);
  const { pending: _, ...prev } = Object.hasOwn(all, branch) ? all[branch]! : { base: ctx.config.stop.base_ref, fired: [], lines: 0, files: 0, ts };
  writeProgress(ctx.root, branch, { ...prev, raise: { lines: r.lines, files: r.files, ts } });
  appendEvent(ctx.root, { ts, session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-raised', reason: `${esc(branch)} ${count(r.lines, 'line')} ${count(r.files, 'file')}` });
}
