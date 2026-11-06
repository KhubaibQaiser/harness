// pr-size (spec §6, §10): asks before `gh pr create`, or a push to a PR branch harness recorded, goes over the limit.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { esc, isObj } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import { unquote, words } from '../../core/shell-words.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import { isShell } from '../../hooks/edit-target.js';
import type { Decision } from '../../hooks/types.js';
import { type PrTarget, prTargets } from './detect.js';
import { currentBranch, type Git, isOver, measure, plainBranch, realGit, type Size } from './measure.js';

export const RECORD = '.harness/state/pr-branches.json';
export interface PrRecord { base: string; lines: number; files: number; ts: string }

const LARGEST = 3;
const NOT_COUNTED = 5;
const REF_TIMEOUT_MS = 2000;
const JSON_INDENT = 2;
// One budget for every target in a command, inside the 10 s hook timeout (measure's own default is the same 6 s).
const BUDGET_MS = 6000;
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

type Job = { want: { base?: string; head?: string }; push?: { branch: string; rec: PrRecord } };
type Clock = { now: () => number; deadline: number };
const left = (c: Clock) => c.deadline - c.now();
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const limit = (ml: number, mf: number) => `${count(ml, 'line')} or ${count(mf, 'file')}`;

// A failed lookup counts as present, so the branch is measured (or noted), never skipped in silence.
const refExists = (git: Git, name: string, c: Clock) => git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], Math.min(REF_TIMEOUT_MS, Math.max(1, left(c)))).status !== 1;
const isHead = (r: string) => r === 'HEAD' || r === '@';

/** What to measure for one target. A push counts only for a recorded branch, measured from its recorded base. */
function jobs(t: PrTarget, records: Record<string, PrRecord>, git: Git, c: Clock): Job[] {
  if (t.kind === 'create') return [{ want: { ...(t.base !== undefined ? { base: t.base } : {}), ...(t.head !== undefined ? { head: t.head } : {}) } }];
  let pushed: { branch: string | null; head?: string }[];
  if (t.all) pushed = Object.keys(records).filter((b) => refExists(git, b, c)).map((b) => ({ branch: b, head: b }));
  else if (!t.refs.length) {
    const b = currentBranch(git);
    pushed = [{ branch: b, ...(b ? { head: b } : {}) }];
  } else pushed = t.refs.map((r) => ({ branch: isHead(r.dst) ? currentBranch(git) : r.dst, ...(isHead(r.src) ? {} : { head: r.src }) }));
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

function verdict(ctx: Ctx, s: Size, job: Job): Decision {
  const { max_lines: ml, max_files: mf, target_lines: t } = ctx.config.pr_size;
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

function decidePre(ctx: Ctx, git: Git, targets: PrTarget[], c: Clock): Decision {
  const records = readRecords(ctx.root);
  const notes: string[] = [];
  for (const t of targets) {
    if (left(c) <= 0) {
      notes.push(unmeasured(ctx, OUT_OF_TIME, [t.kind === 'create' ? t.base : undefined]));
      continue;
    }
    for (const job of jobs(t, records, git, c)) {
      const s = left(c) > 0 ? measure(ctx.root, job.want, ctx.config, { git, now: c.now, budgetMs: left(c) }) : { error: OUT_OF_TIME };
      if ('error' in s) {
        notes.push(unmeasured(ctx, s.error, [s.base, job.want.base]));
        continue;
      }
      const grows = !job.push || s.lines > job.push.rec.lines || s.files > job.push.rec.files;
      if (isOver(s, ctx.config.pr_size) && grows) return verdict(ctx, s, job);
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
function toRecord(ctx: Ctx, targets: PrTarget[], command: string): PrTarget[] {
  const pushes = targets.filter((t) => t.kind === 'push');
  if (!PR_URL.test(JSON.stringify(ctx.input.tool_response ?? ''))) return pushes;
  const real = realBases(command);
  const creates = targets.filter((t) => t.kind === 'create');
  const kept = creates.filter((t) => t.base === undefined || real.has(t.base));
  const widened = creates.map(({ head }) => ({ kind: 'create' as const, ...(head !== undefined ? { head } : {}) }));
  return [...(kept.length ? kept : widened), ...pushes];
}

function recordPost(ctx: Ctx, git: Git, targets: PrTarget[], c: Clock): void {
  const records = readRecords(ctx.root);
  const ts = new Date().toISOString();
  for (const t of targets) {
    for (const job of jobs(t, records, git, c)) {
      const branch = job.push?.branch ?? job.want.head ?? currentBranch(git);
      // A detached HEAD records nothing; nor does a create against its own branch, which would reset the record.
      if (!branch || !plainBranch(branch) || (!job.push && job.want.base === branch) || left(c) <= 0) continue;
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

export function decidePrSize(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  const { tool_name, tool_input = {} } = ctx.input;
  if (!ctx.config?.checks.prSize || !isShell(tool_name)) return { kind: 'allow' };
  const command = String(tool_input.command ?? '');
  const targets = prTargets(command, { root: ctx.root, env: ctx.env });
  if (!targets.length) return { kind: 'allow' };
  const clock = { now, deadline: now() + BUDGET_MS };
  if (ctx.input.hook_event_name === 'PreToolUse') return decidePre(ctx, git, targets, clock);
  if (tool_name === 'Monitor') return { kind: 'allow' }; // a Monitor command is checked, not recorded
  try {
    recordPost(ctx, git, toRecord(ctx, targets, command), clock);
  } catch (e) {
    process.stderr.write(`harness: pr-size record failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return { kind: 'allow' };
}

export const prSize: Check = { name: 'pr-size', events: ['PreToolUse', 'PostToolUse'], failClosed: true, pure: true, run: (ctx) => decidePrSize(ctx) };
