// In-progress size warnings (spec §14): after a counted edit, and once at Stop, measure the working tree and announce each threshold crossing once.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { esc, isObj } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import { matches, toRepoPath } from '../../core/paths.js';
import type { Ctx } from '../../hooks/dispatch.js';
import { editTarget } from '../../hooks/edit-target.js';
import type { Decision } from '../../hooks/types.js';
import { readRecords } from './check.js';
import { type Git, hookBudgetMs, measure, realGit, type Size } from './measure.js';

export const PROGRESS = '.harness/state/pr-progress.json';
type Mark = 'target' | 'max';
export interface Progress { base: string; fired: Mark[]; lines: number; files: number; ts: string; raise?: { lines: number; files: number; ts: string } }
type Lim = { target: number; maxLines: number; maxFiles: number };

const JSON_INDENT = 2;
const GIT_CALL_MS = 2000;
// §14.4's raise ranges (the section 7 maximums).
export const RAISE_MAX_LINES = 100000;
export const RAISE_MAX_FILES = 10000;
// One entry per branch, never pruned; a file past this reads as empty rather than slowing every counted edit.
const MAX_BYTES = 1_000_000;
const ALLOW: Decision = { kind: 'allow' };
const isInt = Number.isInteger;
const isMark = (m: unknown): m is Mark => m === 'target' || m === 'max';

function parse(v: unknown): Progress | null {
  if (!isObj(v) || typeof v.base !== 'string' || typeof v.ts !== 'string' || !isInt(v.lines) || !isInt(v.files)) return null;
  if (!Array.isArray(v.fired) || !v.fired.every(isMark)) return null;
  const r = v.raise;
  if (r !== undefined && !(isObj(r) && isInt(r.lines) && isInt(r.files) && typeof r.ts === 'string')) return null;
  const raise = r === undefined ? {} : { raise: { lines: r.lines as number, files: r.files as number, ts: r.ts as string } };
  return { base: v.base, fired: [...new Set(v.fired as Mark[])], lines: v.lines as number, files: v.files as number, ts: v.ts, ...raise };
}

/** Never throws; a bad file or entry reads as empty. Null prototype, so `constructor` is just a branch. */
export function readProgress(root: string): Record<string, Progress> {
  const out: Record<string, Progress> = Object.create(null);
  let raw: unknown;
  try {
    if (statSync(join(root, PROGRESS)).size > MAX_BYTES) return out;
    raw = JSON.parse(readFileSync(join(root, PROGRESS), 'utf8'));
  } catch {
    return out;
  }
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const p = parse(v);
    if (k && p) out[k] = p;
  }
  return out;
}

export function writeProgress(root: string, branch: string, p: Progress): void {
  const all = readProgress(root);
  all[branch] = p;
  mkdirSync(dirname(join(root, PROGRESS)), { recursive: true });
  writeAtomic(join(root, PROGRESS), JSON.stringify(all, null, JSON_INDENT) + '\n');
}

/** §14.5: after the resets and the additions, `fired` is exactly the thresholds now passed; the announcement is the highest one new since `prev`. */
export function step(prev: Progress | undefined, size: { lines: number; files: number }, lim: Lim): { fired: Mark[]; announce: Mark | null } {
  const over = size.lines > lim.maxLines || size.files > lim.maxFiles;
  const fired: Mark[] = over ? ['target', 'max'] : size.lines > lim.target ? ['target'] : [];
  const had = prev?.fired ?? [];
  const announce = [...fired].reverse().find((m) => !had.includes(m)) ?? null;
  return { fired, announce };
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const ASK = 'Before your next edit, stop and ask the person how to go on, with AskUserQuestion if you have it: split now (run the pr-ship skill and show its suggested breakdown), keep going, or raise the limit for this branch (run `node .harness/hooks/dispatch.mjs --pr-size-raise --lines <n> --files <n>`, which asks them to approve).';

const PERSON = 'harness pr-size:'; // a quoted string, so usage.test.ts doesn't read it as a `harness` command
type Copy = { branch: string; base: string; lines: number; files: number; lim: Lim };
function copy(c: Copy, mark: Mark): { agent: string; person: string; unattended: string } {
  const size = `${count(c.lines, 'changed line')} in ${count(c.files, 'file')}`;
  const limit = `${count(c.lim.maxLines, 'line')} or ${count(c.lim.maxFiles, 'file')}`;
  const T = c.lim.target;
  const now = `this branch's change is now ${size} against \`${esc(c.base)}\``;
  const agent = mark === 'target'
    ? `PR size: ${now} (committed and uncommitted), past the target of ${count(T, 'line')}. ${ASK} Harness says this once, and warns again above ${limit}.`
    : `PR size: ${now} (committed and uncommitted), past the limit of ${limit} (aim for ${T}). Opening it as one PR will ask for approval. ${ASK} Harness won't warn again on this branch unless it drops below the limit.`;
  return {
    agent,
    person: `${PERSON} \`${esc(c.branch)}\` is now ${size} (target ${T}, limit ${limit}). Claude should stop and ask you: split, keep going, or raise the limit.`,
    unattended: `Note from pr-size: ${now}, past the target of ${count(T, 'line')}. No person is here to ask, so keep going, then split the work with the pr-ship skill into stacked PRs of about ${count(T, 'line')} before you open any PR. A PR over ${limit} will be refused.`,
  };
}

/** An edit that can change the counted size: an edit tool, inside the repo, not excluded. Anything else spawns no git. */
function countedEdit(ctx: Ctx): boolean {
  const t = editTarget(ctx.input);
  const rel = t === null ? null : toRepoPath(ctx.root, t);
  return rel !== null && !matches(rel, [...ctx.config.pr_size.exclude, ...ctx.config.multi_file_gate.generated]);
}

const unmeasured = (why: string): null => (process.stderr.write(`harness: pr-size progress not measured: ${why}\n`), null); // §14.6: no note, no event
// `origin/main` as recorded (the shown name) is looked up as `main`, so findBase hits refs/remotes/origin/main first: 7 git spawns per edit on a recorded branch, not 9.
const asBaseName = (b: string) => b.replace(/^origin\//, '');

/** The branch and its working-tree size, or null to stay silent: no counted edit, a detached HEAD, or unmeasured (logged). */
function measureBranch(ctx: Ctx, git: Git, now: () => number): { branch: string; s: Size } | null {
  const event = ctx.input.hook_event_name;
  if (event !== 'Stop' && !(event === 'PostToolUse' && countedEdit(ctx))) return null;
  const deadline = now() + hookBudgetMs(ctx.startedAt, now);
  if (deadline <= now()) return unmeasured('git timed out');
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], Math.max(1, Math.min(GIT_CALL_MS, deadline - now())));
  if (r.error) return unmeasured(r.error.code === 'ETIMEDOUT' ? 'git timed out' : `git failed (${esc(r.error.code ?? 'error')})`);
  const branch = r.status === 0 ? r.stdout.trim() : '';
  if (!branch) return null; // a detached HEAD is never recorded or warned about
  const records = readRecords(ctx.root);
  const base = Object.hasOwn(records, branch) ? { base: asBaseName(records[branch]!.base) } : {};
  const budgetMs = deadline - now();
  const s = budgetMs > 0 ? measure(ctx.root, { worktree: true, ...base }, ctx.config, { git, now, budgetMs }) : { error: 'git timed out' };
  return 'error' in s ? unmeasured(s.error) : { branch, s };
}

/** A raise outside the §14.4 ranges (a hand-edited file, say) is ignored, so it can't make every size "over the max". */
export function limits(c: Ctx['config']['pr_size'], raise: Progress['raise']): Lim {
  const ok = raise && raise.lines > c.max_lines && raise.lines <= RAISE_MAX_LINES && raise.files >= c.max_files && raise.files <= RAISE_MAX_FILES;
  return { target: c.target_lines, maxLines: ok ? raise.lines : c.max_lines, maxFiles: ok ? raise.files : c.max_files };
}

function announce(ctx: Ctx, branch: string, s: Size): Decision {
  const all = readProgress(ctx.root);
  const prev = Object.hasOwn(all, branch) ? all[branch] : undefined;
  const lim = limits(ctx.config.pr_size, prev?.raise);
  const { fired, announce: mark } = step(prev, s, lim);
  if (!prev || prev.lines !== s.lines || prev.files !== s.files || prev.fired.join() !== fired.join()) {
    writeProgress(ctx.root, branch, { base: s.base, fired, lines: s.lines, files: s.files, ts: new Date().toISOString(), ...(prev?.raise ? { raise: prev.raise } : {}) });
  }
  if (!mark) return ALLOW;
  appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'pr-size', decision: 'pr-size-warned', reason: `${esc(branch)} ${mark} ${s.lines}/${s.files}` });
  const c = copy({ branch, base: s.base, lines: s.lines, files: s.files, lim }, mark);
  const stop = ctx.input.hook_event_name === 'Stop';
  if (ctx.unattended) return stop ? ALLOW : { kind: 'context', check: 'pr-size', text: c.unattended };
  return stop ? { kind: 'context', check: 'pr-size', text: c.person } : { kind: 'context', check: 'pr-size', text: c.agent, notice: c.person };
}

/** Never throws: a failure warns on stderr and allows. */
export function progressWarning(ctx: Ctx, git: Git = realGit(ctx.root), now: () => number = Date.now): Decision {
  try {
    const m = measureBranch(ctx, git, now);
    return m ? announce(ctx, m.branch, m.s) : ALLOW;
  } catch (e) {
    process.stderr.write(`harness: pr-size progress failed: ${String((e as Error)?.message ?? e)}\n`);
    return ALLOW;
  }
}
