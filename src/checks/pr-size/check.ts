// pr-size (spec §6, §10): asks before `gh pr create`, or a push to a PR branch harness recorded, goes over the limit.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { esc, type HarnessConfig, isObj } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import { unquote, words } from '../../core/shell-words.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import { isEdit, isShell } from '../../hooks/edit-target.js';
import type { Decision } from '../../hooks/types.js';
import { type PrTarget, prTargets } from './detect.js';
import { count, type Git, hookBudgetMs, isOver, measure, plainBranch, realGit, type Size } from './measure.js';
import { clearAllPending, limits, pauseAsk, type Progress, progressWarning, readProgress } from './progress.js';
import { handRun } from './hand-run.js';
import { postRaise, preRaise } from './raise.js';

export const RECORD = '.harness/state/pr-branches.json';
export interface PrRecord { base: string; lines: number; files: number; ts: string }

const LARGEST = 3;
const NOT_COUNTED = 5;
const REF_TIMEOUT_MS = 2000;
const JSON_INDENT = 2;
const OUT_OF_TIME = 'the time budget for this command ran out';
// gh pr create prints the new PR's URL; without one, the create failed (a failure hidden by `|| true` still reaches PostToolUse).
const PR_URL = /\/pull\/\d+/;

/** The recorded PR branches; anything unreadable or malformed is dropped. Null prototype, so `constructor` is never a branch. */
export function readRecords(root: string): Record<string, PrRecord> {
  const out: Record<string, PrRecord> = Object.create(null);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, RECORD), 'utf8'));
  } catch {
    return out;
  }
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!plainBranch(k) || !isObj(v) || typeof v.base !== 'string' || typeof v.ts !== 'string') continue;
    if (Number.isInteger(v.lines) && Number.isInteger(v.files)) out[k] = { base: v.base, lines: v.lines as number, files: v.files as number, ts: v.ts };
  }
  return out;
}

export function writeRecord(root: string, branch: string, r: PrRecord): void {
  const all = readRecords(root);
  all[branch] = r;
  mkdirSync(dirname(join(root, RECORD)), { recursive: true });
  writeAtomic(join(root, RECORD), JSON.stringify(all, null, JSON_INDENT) + '\n');
}

type PrJob = Exclude<PrTarget, { kind: 'raise' }>;
type Limit = HarnessConfig['pr_size'];
type Job = { want: { base?: string; head?: string }; push?: { branch: string; rec: PrRecord }; late?: true };
// `cur`: the current branch, resolved once per command (null: detached; late: git timed out or no time was left).
type Clock = { now: () => number; deadline: number; git: Git; cur?: { name: string | null; late: boolean } };
const left = (c: Clock) => c.deadline - c.now();
const limit = (ml: number, mf: number) => `${count(ml, 'line')} or ${count(mf, 'file')}`;

// A failed lookup counts as present, so the branch is measured (or noted), never skipped in silence.
const refExists = (git: Git, name: string, c: Clock) => git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], Math.min(REF_TIMEOUT_MS, Math.max(1, left(c)))).status !== 1;
const isHead = (r: string) => r === 'HEAD' || r === '@';

function current(c: Clock): { name: string | null; late: boolean } {
  if (!c.cur) {
    const ms = Math.min(REF_TIMEOUT_MS, left(c));
    const r = ms > 0 ? c.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], ms) : null;
    c.cur = !r || r.error ? { name: null, late: true } : { name: r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null, late: false };
  }
  return c.cur;
}

/** What to measure for one target. A push counts only for a recorded branch, measured from its recorded base. */
function jobs(t: PrJob, records: Record<string, PrRecord>, git: Git, c: Clock): Job[] {
  if (t.kind === 'create') return [{ want: { ...(t.base !== undefined ? { base: t.base } : {}), ...(t.head !== undefined ? { head: t.head } : {}) } }];
  if (!Object.keys(records).length) return []; // nothing recorded: no push can count, and no git is spawned
  let pushed: { branch: string | null; head?: string }[];
  const needsCurrent = !t.all && (!t.refs.length || t.refs.some((r) => isHead(r.dst)));
  if (needsCurrent && current(c).late) return [{ want: {}, late: true }]; // noted at PreToolUse, never skipped in silence
  if (t.all) pushed = Object.keys(records).filter((b) => refExists(git, b, c)).map((b) => ({ branch: b, head: b }));
  else if (!t.refs.length) {
    const b = current(c).name;
    pushed = [{ branch: b, ...(b ? { head: b } : {}) }];
  } else pushed = t.refs.map((r) => ({ branch: isHead(r.dst) ? current(c).name : r.dst, ...(isHead(r.src) ? {} : { head: r.src }) }));
  return pushed.flatMap((p) => {
    const rec = p.branch !== null && Object.hasOwn(records, p.branch) ? records[p.branch]! : null;
    return rec ? [{ want: { base: rec.base, ...(p.head !== undefined ? { head: p.head } : {}) }, push: { branch: p.branch!, rec } }] : [];
  });
}

function lists(s: Size): string {
  const top = `Largest: ${s.top.slice(0, LARGEST).map((f) => `\`${esc(f.path)}\` ${f.lines}`).join(', ')}.`;
  if (!s.excluded.length) return top;
  const more = s.excluded.length > NOT_COUNTED ? `, and ${s.excluded.length - NOT_COUNTED} more` : '';
  return `${top} Not counted: ${s.excluded.slice(0, NOT_COUNTED).map((p) => `\`${esc(p)}\``).join(', ')}${more}.`;
}

function verdict(ctx: Ctx, s: Size, job: Job, lim: Limit): Decision {
  const { max_lines: ml, max_files: mf, target_lines: t } = lim;
  const p = job.push;
  const size = `${count(s.lines, 'changed line')} in ${count(s.files, 'file')}`;
  const what = p
    ? `this push grows the pull request for \`${esc(p.branch)}\` to ${size} (it was ${p.rec.lines} in ${p.rec.files})`
    : `this pull request is ${size} against \`${esc(s.base)}\``;
  if (ctx.unattended) {
    const reason = `Blocked by pr-size: ${what}, over the limit of ${limit(ml, mf)}, and no person is here to approve it. Split it with the pr-ship skill into stacked PRs of about ${count(t, 'line')} each, opening each with \`--base\` set to the branch before it. If a piece can't go under the limit, stop and report it.`;
    return { kind: 'deny', reason, check: 'pr-size' };
  }
  const first = p ? `Confirm: ${what}.` : `Confirm: ${what}, over the limit of ${limit(ml, mf)} (aim for ${t}).`;
  const last = p ? 'Approve to push it as it is, or say no and run the pr-ship skill to split it.' : 'Approve to open it as it is, or say no and run the pr-ship skill to split it into stacked PRs.';
  return { kind: 'ask', reason: `${first} ${lists(s)} ${last}`, check: 'pr-size' };
}

function unmeasured(ctx: Ctx, why: string, bases: (string | undefined)[]): string {
  const { max_lines: ml, max_files: mf } = ctx.config.pr_size;
  const base = bases.find((b) => b !== undefined && plainBranch(b));
  try {
    appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-unmeasured', reason: why });
  } catch (e) {
    process.stderr.write(`harness: pr-size event log failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return `Note from pr-size: harness couldn't measure this pull request (${why}), so its size against the limit of ${limit(ml, mf)} wasn't checked. To check it yourself, run \`node .harness/hooks/dispatch.mjs --pr-size --base ${base ? esc(base) : '<base>'}\`.`;
}

/** N5: a branch's recorded raise (in the §14.4 ranges) is its PR-time max too. Without any raise, no branch lookup is spawned. */
function limitFor(ctx: Ctx, progress: Record<string, Progress>, job: Job, c: Clock): Limit {
  if (!Object.values(progress).some((p) => p.raise)) return ctx.config.pr_size;
  const branch = job.push?.branch ?? job.want.head ?? current(c).name;
  const l = limits(ctx.config.pr_size, branch !== null && Object.hasOwn(progress, branch) ? progress[branch]!.raise : undefined);
  return { ...ctx.config.pr_size, max_lines: l.maxLines, max_files: l.maxFiles };
}

function decidePre(ctx: Ctx, git: Git, targets: PrJob[], c: Clock): Decision {
  const records = readRecords(ctx.root);
  const progress = readProgress(ctx.root);
  const notes: string[] = [];
  for (const t of targets) {
    if (left(c) <= 0) {
      notes.push(unmeasured(ctx, OUT_OF_TIME, [t.kind === 'create' ? t.base : undefined]));
      continue;
    }
    for (const job of jobs(t, records, git, c)) {
      const s = job.late ? { error: 'git timed out' } : left(c) > 0 ? measure(ctx.root, job.want, ctx.config, { git, now: c.now, budgetMs: left(c) }) : { error: OUT_OF_TIME };
      if ('error' in s) {
        notes.push(unmeasured(ctx, s.error, [s.base, job.want.base]));
        continue;
      }
      const grows = !job.push || s.lines > job.push.rec.lines || s.files > job.push.rec.files;
      const lim = limitFor(ctx, progress, job, c);
      if (isOver(s, lim) && grows) return verdict(ctx, s, job, lim);
    }
  }
  return notes.length ? { kind: 'context', check: 'pr-size', text: notes.join('\n') } : { kind: 'allow' };
}

/** The values the shell really passes to `--base`/`-B`, also inside a `-c` payload, so a base read only inside another quoted value is never recorded. */
function realBases(command: string, out = new Set<string>()): Set<string> {
  const toks = words(command).map(unquote);
  toks.forEach((tok, i) => {
    const m = /^(?:--base=|-B(?=.))(.*)$/s.exec(tok);
    if (m) out.add(m[1]!);
    else if ((tok === '--base' || tok === '-B') && toks[i + 1] !== undefined) out.add(toks[i + 1]!);
    else if (tok === '-c' && toks[i + 1] !== undefined && toks[i + 1] !== command) realBases(toks[i + 1]!, out);
  });
  return out;
}

/** The targets to record. A create with a base that no real flag gave is dropped; when that leaves none (a base set in a
 * package script, say), the creates are recorded against the default base, which is the widest and only over-asks. */
function toRecord(ctx: Ctx, targets: PrJob[], command: string): PrJob[] {
  const pushes = targets.filter((t) => t.kind === 'push');
  if (!PR_URL.test(JSON.stringify(ctx.input.tool_response ?? ''))) return pushes;
  const real = realBases(command);
  const creates = targets.filter((t) => t.kind === 'create');
  const kept = creates.filter((t) => t.base === undefined || real.has(t.base));
  const widened = creates.map(({ head }) => ({ kind: 'create' as const, ...(head !== undefined ? { head } : {}) }));
  return [...(kept.length ? kept : widened), ...pushes];
}

function recordPost(ctx: Ctx, git: Git, targets: PrJob[], c: Clock): void {
  const records = readRecords(ctx.root);
  const ts = new Date().toISOString();
  for (const t of targets) {
    for (const job of jobs(t, records, git, c)) {
      if (job.late || left(c) <= 0) continue;
      const branch = job.push?.branch ?? job.want.head ?? current(c).name;
      // A detached HEAD records nothing; nor does a create against its own branch, which would reset the record.
      if (!branch || !plainBranch(branch) || (!job.push && job.want.base === branch)) continue;
      const s = measure(ctx.root, job.want, ctx.config, { git, now: c.now, budgetMs: left(c) });
      if ('error' in s) {
        if (job.push || Object.hasOwn(records, branch)) continue;
        // ponytail: with no base found, stop.base_ref (measure's last fallback) stands in.
        records[branch] = { base: job.want.base ?? s.base ?? ctx.config.stop.base_ref, lines: 0, files: 0, ts };
      } else records[branch] = { base: job.push?.rec.base ?? job.want.base ?? s.base, lines: s.lines, files: s.files, ts };
      writeRecord(ctx.root, branch, records[branch]!);
    }
  }
}

/** A raise's ask or deny comes first; a PR create or push in the same command that also asks, or its note, joins the dialog. */
function withRaise(raise: Decision | null, pr: Decision): Decision {
  if (!raise || raise.kind !== 'ask') return raise ?? pr;
  if (pr.kind === 'ask') return { ...raise, reason: `${raise.reason} Also, ${pr.reason.replace(/^Confirm: /, '')}` };
  return pr.kind === 'context' ? { ...raise, reason: `${raise.reason} ${pr.text}` } : raise;
}

export function decidePrSize(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  const { tool_name, tool_input = {} } = ctx.input;
  if (!ctx.config?.checks.prSize) return { kind: 'allow' };
  const event = ctx.input.hook_event_name;
  if (event === 'Stop' || (event === 'PostToolUse' && !isShell(tool_name))) return progressWarning(ctx, git, now);
  if (event === 'UserPromptSubmit') return clearAllPending(ctx.root);
  if (!isShell(tool_name)) return event === 'PreToolUse' && isEdit(tool_name) ? pauseAsk(ctx, git) : { kind: 'allow' };
  const command = String(tool_input.command ?? '');
  const hand = event === 'PreToolUse' ? handRun(command, { root: ctx.root, env: ctx.env }) : null;
  if (hand) return { kind: 'deny', check: 'pr-size', reason: hand };
  const all = prTargets(command, { root: ctx.root, env: ctx.env });
  const targets = all.filter((t): t is PrJob => t.kind !== 'raise');
  if (!all.length) return { kind: 'allow' };
  const clock: Clock = { now, git, deadline: now() + hookBudgetMs(ctx.startedAt, now) };
  const cur = () => current(clock);
  if (event === 'PreToolUse') return withRaise(preRaise(ctx, command, all, cur), targets.length ? decidePre(ctx, git, targets, clock) : { kind: 'allow' });
  if (tool_name === 'Monitor') return { kind: 'allow' }; // a Monitor command is checked, not recorded
  try {
    postRaise(ctx, command, all, cur);
    recordPost(ctx, git, toRecord(ctx, targets, command), clock);
  } catch (e) {
    process.stderr.write(`harness: pr-size record failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return { kind: 'allow' };
}

export const prSize: Check = { name: 'pr-size', events: ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'], failClosed: true, pure: false, run: (ctx) => decidePrSize(ctx) };
