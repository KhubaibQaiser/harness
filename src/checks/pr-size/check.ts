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

const refExists = (git: Git, name: string) => git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], REF_TIMEOUT_MS).status === 0;

/** What to measure for one target. A push counts only for a recorded branch, measured from its recorded base. */
function jobs(t: PrTarget, records: Record<string, PrRecord>, git: Git): Job[] {
  if (t.kind === 'create') return [{ want: { ...(t.base !== undefined ? { base: t.base } : {}), ...(t.head !== undefined ? { head: t.head } : {}) } }];
  let pushed: { branch: string; head?: string }[];
  if (t.all) pushed = Object.keys(records).filter((b) => refExists(git, b)).map((b) => ({ branch: b, head: b }));
  else if (!t.refs.length) {
    const b = currentBranch(git);
    pushed = b ? [{ branch: b, head: b }] : [];
  } else pushed = t.refs.map((r) => ({ branch: r.dst, ...(r.src === 'HEAD' ? {} : { head: r.src }) }));
  return pushed
    .filter((p) => Object.hasOwn(records, p.branch))
    .map((p) => ({ want: { base: records[p.branch]!.base, ...(p.head !== undefined ? { head: p.head } : {}) }, push: { branch: p.branch, rec: records[p.branch]! } }));
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
  const what = p
    ? `this push grows the pull request for \`${esc(p.branch)}\` to ${s.lines} changed lines in ${s.files} files (it was ${p.rec.lines} in ${p.rec.files})`
    : `this pull request is ${s.lines} changed lines in ${s.files} files against \`${esc(s.base)}\``;
  if (ctx.unattended) {
    const reason = `Blocked by pr-size: ${what}, over the limit of ${ml} lines or ${mf} files, and no person is here to approve it. Split it with the pr-ship skill into stacked PRs of about ${t} lines each, opening each with \`--base\` set to the branch before it. If a piece can't go under the limit, stop and report it.`;
    return { kind: 'deny', reason, check: 'pr-size' };
  }
  const first = p ? `Confirm: ${what}.` : `Confirm: ${what}, over the limit of ${ml} lines or ${mf} files (aim for ${t}).`;
  const last = p ? 'Approve to push it as it is, or say no and run the pr-ship skill to split it.' : 'Approve to open it as it is, or say no and run the pr-ship skill to split it into stacked PRs.';
  return { kind: 'ask', reason: `${first} ${lists(s)} ${last}`, check: 'pr-size' };
}

function decidePre(ctx: Ctx, git: Git, targets: PrTarget[]): Decision {
  const records = readRecords(ctx.root);
  const notes: string[] = [];
  const { max_lines: ml, max_files: mf } = ctx.config.pr_size;
  for (const t of targets) {
    for (const job of jobs(t, records, git)) {
      const s = measure(ctx.root, job.want, ctx.config, { git });
      if ('error' in s) {
        const base = [s.base, job.want.base].find((b) => b !== undefined && plainBranch(b));
        notes.push(`Note from pr-size: harness couldn't measure this pull request (${s.error}), so its size against the limit of ${ml} lines or ${mf} files wasn't checked. To check it yourself, run \`node .harness/hooks/dispatch.mjs --pr-size --base ${base ? esc(base) : '<base>'}\`.`);
        logUnmeasured(ctx, s.error);
        continue;
      }
      const grows = !job.push || s.lines > job.push.rec.lines || s.files > job.push.rec.files;
      if (isOver(s, ctx.config.pr_size) && grows) return verdict(ctx, s, job);
    }
  }
  return notes.length ? { kind: 'context', check: 'pr-size', text: notes.join('\n') } : { kind: 'allow' };
}

function logUnmeasured(ctx: Ctx, reason: string): void {
  try {
    appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-unmeasured', reason });
  } catch (e) {
    process.stderr.write(`harness: pr-size event log failed: ${String((e as Error)?.message ?? e)}\n`);
  }
}

/** The values the shell really passes to `--base`/`-B`, so a base read only inside a quoted value is never recorded. */
function realBases(command: string): Set<string> {
  const toks = words(command).map(unquote);
  const out = new Set<string>();
  toks.forEach((tok, i) => {
    const m = /^(?:--base=|-B(?=.))(.*)$/s.exec(tok);
    if (m) out.add(m[1]!);
    else if ((tok === '--base' || tok === '-B') && toks[i + 1] !== undefined) out.add(toks[i + 1]!);
  });
  return out;
}

// ponytail: a create inside `bash -c "…"` has its base only inside a quoted value, so it is not recorded; widen realBases if that matters.
function recordPost(ctx: Ctx, git: Git, targets: PrTarget[], command: string): void {
  const records = readRecords(ctx.root);
  const real = realBases(command);
  const ts = new Date().toISOString();
  for (const t of targets) {
    if (t.kind === 'create' && t.base !== undefined && !real.has(t.base)) continue;
    for (const job of jobs(t, records, git)) {
      const branch = job.push?.branch ?? job.want.head ?? currentBranch(git);
      if (!branch || !plainBranch(branch)) continue; // a detached HEAD records nothing
      const s = measure(ctx.root, job.want, ctx.config, { git });
      if ('error' in s) {
        if (job.push || Object.hasOwn(records, branch)) continue;
        // ponytail: with no base found, stop.base_ref (measure's last fallback) stands in.
        records[branch] = { base: job.want.base ?? s.base ?? ctx.config.stop.base_ref, lines: 0, files: 0, ts };
      } else records[branch] = { base: job.push?.rec.base ?? job.want.base ?? s.base, lines: s.lines, files: s.files, ts };
      writeRecord(ctx.root, branch, records[branch]!);
    }
  }
}

export function decidePrSize(ctx: Ctx, git: Git = realGit(ctx.root)): Decision {
  const { tool_name, tool_input = {} } = ctx.input;
  if (!ctx.config?.checks.prSize || !isShell(tool_name)) return { kind: 'allow' };
  const command = String(tool_input.command ?? '');
  const targets = prTargets(command, { root: ctx.root, env: ctx.env });
  if (!targets.length) return { kind: 'allow' };
  if (ctx.input.hook_event_name === 'PreToolUse') return decidePre(ctx, git, targets);
  if (tool_name === 'Monitor') return { kind: 'allow' }; // a Monitor command is checked, not recorded
  try {
    recordPost(ctx, git, targets, command);
  } catch (e) {
    process.stderr.write(`harness: pr-size record failed: ${String((e as Error)?.message ?? e)}\n`);
  }
  return { kind: 'allow' };
}

export const prSize: Check = { name: 'pr-size', events: ['PreToolUse', 'PostToolUse'], failClosed: true, pure: true, run: (ctx) => decidePrSize(ctx) };
