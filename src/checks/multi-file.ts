// Asks once before an agent edits a second source unit in one turn; approval covers the rest of the turn.
// ponytail: Bash writes are not counted in M1 (spec 9b).
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { appendEvent } from '../core/events.js';
import { isAnyTestFile, matches, pairKey, toRepoPath } from '../core/paths.js';
import { clearTurn, readState, withSessionLock, writeState } from '../core/state.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { editTarget } from '../hooks/edit-target.js';

const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

// Repo-relative path of a counted edit, or null for other tools, outside-root, tests, snapshots, lockfiles and generated files.
// Tests never count: writing the test, then the code, is one change.
function target(ctx: Ctx): string | null {
  const p = editTarget(ctx.input);
  if (p === null) return null;
  const rel = toRepoPath(ctx.root, p);
  if (rel === null || isAnyTestFile(rel) || /(^|\/)__snapshots__\//.test(rel) || rel.endsWith('.snap') || LOCKS.includes(basename(rel)) || matches(rel, ctx.config.multi_file_gate.generated)) return null;
  return rel;
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const NAME_CHAR = /[A-Za-z0-9_.-]/;
// True when `name` occurs in `line` with no name character directly before or after it (so a.ts does not match data.ts).
function hasName(line: string, name: string): boolean {
  for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
    if (!NAME_CHAR.test(line[i - 1] ?? ' ') && !NAME_CHAR.test(line[i + name.length] ?? ' ')) return true;
  }
  return false;
}

type Rec = { at: number; prompt: boolean; texts: string[] };

export const TRANSCRIPT_TAIL = 8 * 1024 * 1024; // team-decisions plan: read at most the last 8 MiB of a transcript

/** The last `max` bytes of a file as UTF-8. A line cut at the start is dropped by the JSON-line parsers. */
export function readTail(path: string, max: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    return buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, size - buf.length));
  } finally {
    closeSync(fd);
  }
}

// The transcript's user prompts and assistant text, or undefined when unreadable.
// ponytail: the transcript JSONL format is not a documented stable API; unknown shapes are skipped and an unreadable file fails open.
export function readTranscript(path: unknown, max = Infinity): Rec[] | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  let raw: string;
  try {
    raw = readTail(path, max);
  } catch {
    return undefined;
  }
  const recs: Rec[] = [];
  for (const line of raw.split('\n')) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = obj(o);
    const c = obj(rec.message).content;
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (rec.type === 'user') {
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => obj(b).type !== 'tool_result'))) recs.push({ at, prompt: true, texts: [] });
    } else if (rec.type === 'assistant' && Array.isArray(c)) {
      const texts = c.map(obj).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
      if (texts.length) recs.push({ at, prompt: false, texts });
    }
  }
  return recs;
}

// Reason line for `rel` in assistant text after the last real user prompt; null = none found.
// With `before` (epoch ms), only records stamped at or before it count, ordered by their timestamps: Claude Code appends
// an assistant message (text and tool_use) only after PreToolUse returns, so file order is not the order they happened in.
function reasonIn(all: Rec[], rel: string, before?: number): string | null {
  const recs = before === undefined ? all : all.filter((r) => r.at <= before).sort((a, b) => a.at - b.at); // stable sort
  let texts: string[] = [];
  for (const r of recs) texts = r.prompt ? [] : [...texts, ...r.texts];
  const name = basename(rel).toLowerCase();
  for (const t of texts) for (const l of t.split('\n')) if (hasName(l.toLowerCase(), name) && /\bbecause\b/i.test(l)) return l.trim().slice(0, 300);
  return null;
}

const NO_REASON = 'no reason given';
const ALLOW = { kind: 'allow' } as const;

// The reason is often written in the same message as the edit, which is on disk only after PreToolUse. At the next
// Stop or prompt the transcript is flushed: look once for each "no reason given" this session recorded, and log the result.
async function reasonsFoundLate(ctx: Ctx, locked: boolean): Promise<void> {
  const { root, input } = ctx;
  const pending = ctx.state.lateReasons ?? [];
  if (!pending.length) return;
  const recs = readTranscript(input.transcript_path);
  for (const p of pending) {
    const line = recs && reasonIn(recs, p.rel, Date.parse(p.ts));
    appendEvent(root, {
      ts: new Date().toISOString(), session: input.session_id, check: 'multi-file', files: [p.rel], of: p.ts,
      ...(line ? { decision: 'reason-found-late', reason: `${p.rel}: ${line}` } : { decision: 'reason-not-found', reason: `${p.rel}: ${recs ? NO_REASON : 'transcript unreadable'}` }),
    });
  }
  // Remove only the entries handled here, from the state on disk: Stop runs unlocked, and its snapshot may predate a
  // hook that ran since (a subagent's edit). UserPromptSubmit already holds the lock; Stop takes it for this one write.
  const handled = new Set(pending.map((p) => p.ts));
  const clear = () => {
    const cur = readState(root, input.session_id);
    const next = { ...cur, lateReasons: (cur.lateReasons ?? []).filter((p) => !handled.has(p.ts)) };
    writeState(root, input.session_id, next);
    ctx.state = next;
  };
  if (locked) clear();
  else await withSessionLock(root, input.session_id, clear);
}

export const multiFile: Check = {
  name: 'multiFile',
  events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'],
  // Record at Pre so a parallel second Pre sees this file; an ask or deny records nothing.
  afterAllow(ctx) {
    if (!ctx.config.checks.multiFile) return;
    const rel = target(ctx);
    if (rel !== null && !ctx.state.files.includes(rel)) ctx.save({ ...ctx.state, files: [...ctx.state.files, rel] });
  },
  run(ctx) {
    const { hook_event_name: event, session_id: session } = ctx.input;
    // The audit trail is best effort; it never changes a decision.
    if (event === 'Stop') return reasonsFoundLate(ctx, false).then(() => ALLOW, () => ALLOW);
    if (event === 'UserPromptSubmit') {
      return reasonsFoundLate(ctx, true).catch(() => {}).then(() => {
        clearTurn(ctx.root, session); // also resets stopAttempts, so it runs with the gate off too
        return ALLOW;
      });
    }
    if (!ctx.config.checks.multiFile) return { kind: 'allow' };
    const rel = target(ctx);
    if (rel === null) return { kind: 'allow' };
    const { files, approved } = ctx.state;
    const units = new Set(files.map(pairKey));
    if (event === 'PostToolUse') {
      units.add(pairKey(rel));
      const next = files.includes(rel) ? files : [...files, rel];
      ctx.save({ ...ctx.state, files: next, approved: approved || units.size >= 2 });
      // Attended, a second unit only gets here after the user approved the ask; unattended runs log allow-log instead.
      if (!approved && units.size >= 2 && !ctx.unattended) appendEvent(ctx.root, { ts: new Date().toISOString(), session, check: 'multi-file', decision: 'approved', files: next });
      return { kind: 'allow' };
    }
    // PreToolUse only decides; afterAllow records once the whole call is allowed, PostToolUse otherwise.
    if (units.size === 0 || units.has(pairKey(rel))) return { kind: 'allow' };
    const list = files.join(', ');
    if (ctx.unattended) {
      const mode = ctx.config.unattended.multi_file_gate;
      if (mode === 'block') return { kind: 'deny', reason: `Unattended multi-file change blocked. Wanted: ${[...files, rel].join(', ')}.`, check: 'multi-file' };
      if (mode === 'allow-log') {
        let why: string | undefined;
        if (ctx.config.unattended.require_reason) {
          const recs = readTranscript(ctx.input.transcript_path);
          const found = recs === undefined ? undefined : reasonIn(recs, rel);
          const denied = ctx.state.reasonDenied ?? [];
          if (found === undefined) why = 'transcript unreadable';
          else if (found !== null) why = found;
          else if (denied.includes(rel)) why = NO_REASON;
          else {
            ctx.save({ ...ctx.state, reasonDenied: [...denied, rel] });
            appendEvent(ctx.root, { ts: new Date().toISOString(), session, check: 'multi-file', decision: 'reason-required', files: [...files, rel] });
            return { kind: 'deny', reason: 'State why each extra file is necessary, then retry. Write one line per file: "<file> because <reason>".', check: 'multi-file' };
          }
        }
        const ts = new Date().toISOString();
        if (why === NO_REASON) ctx.save({ ...ctx.state, lateReasons: [...(ctx.state.lateReasons ?? []), { ts, rel }] });
        appendEvent(ctx.root, { ts, session, check: 'multi-file', decision: 'allow-log', files: [...files, rel], ...(why ? { reason: `${rel}: ${why}` } : {}) });
      }
      return { kind: 'allow' };
    }
    if (approved) return { kind: 'allow' };
    return { kind: 'ask', reason: `This change now spans more than one file. Touched: ${list}. Next: ${rel}. Approve to continue this turn.`, check: 'multi-file' };
  },
};
