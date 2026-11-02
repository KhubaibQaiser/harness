// Asks once before an agent edits a second source unit in one turn; approval covers the rest of the turn.
// ponytail: Bash writes are not counted in M1 (spec 9b).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { appendEvent, readEvents } from '../core/events.js';
import { isAnyTestFile, matches, pairKey, toRepoPath } from '../core/paths.js';
import { clearTurn } from '../core/state.js';
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

// Reason line for `rel` from assistant text after the last real user prompt; null = none found, undefined = transcript unreadable.
// With `before` (epoch ms), only records stamped at or before it count, ordered by their timestamps: Claude Code appends
// an assistant message (text and tool_use) only after PreToolUse returns, so file order is not the order they happened in.
// ponytail: the transcript JSONL format is not a documented stable API; unknown shapes are skipped and an unreadable file fails open.
function findReason(path: unknown, rel: string, before?: number): string | null | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const recs: { at: number; prompt: boolean; texts: string[] }[] = [];
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
    if (before !== undefined && !(at <= before)) continue;
    if (rec.type === 'user') {
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => obj(b).type !== 'tool_result'))) recs.push({ at, prompt: true, texts: [] });
    } else if (rec.type === 'assistant' && Array.isArray(c)) {
      const texts = c.map(obj).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string);
      if (texts.length) recs.push({ at, prompt: false, texts });
    }
  }
  if (before !== undefined) recs.sort((a, b) => a.at - b.at); // stable: equal stamps keep file order
  let texts: string[] = [];
  for (const r of recs) texts = r.prompt ? [] : [...texts, ...r.texts];
  const name = basename(rel).toLowerCase();
  for (const t of texts) for (const l of t.split('\n')) if (hasName(l.toLowerCase(), name) && /\bbecause\b/i.test(l)) return l.trim().slice(0, 300);
  return null;
}

const NO_REASON = ': no reason given';

// The reason is often written in the same message as the edit, which is on disk only after PreToolUse. Once the
// transcript is flushed (Stop, the next prompt), find it for each "no reason given" this session and log it.
function reasonsFoundLate(ctx: Ctx): void {
  const { root, input } = ctx;
  if (!ctx.config.checks.multiFile || !ctx.config.unattended.require_reason || typeof input.transcript_path !== 'string') return;
  const mine = readEvents(root).filter((e) => e.session === input.session_id && e.check === 'multi-file');
  const done = new Set(mine.filter((e) => e.decision === 'reason-found-late').map((e) => e.of));
  for (const e of mine) {
    if (e.decision !== 'allow-log' || !e.reason?.endsWith(NO_REASON) || done.has(e.ts)) continue;
    const rel = e.reason.slice(0, -NO_REASON.length);
    const line = findReason(input.transcript_path, rel, Date.parse(e.ts));
    if (line) appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check: 'multi-file', decision: 'reason-found-late', files: [rel], reason: `${rel}: ${line}`, of: e.ts });
  }
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
    if (event === 'Stop' || event === 'UserPromptSubmit') {
      try {
        reasonsFoundLate(ctx);
      } catch {
        // the audit trail is best effort; it never changes a decision
      }
    }
    if (event === 'Stop') return { kind: 'allow' };
    if (event === 'UserPromptSubmit') {
      clearTurn(ctx.root, session); // also resets stopAttempts, so it runs with the gate off too
      return { kind: 'allow' };
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
          const found = findReason(ctx.input.transcript_path, rel);
          const denied = ctx.state.reasonDenied ?? [];
          if (found === undefined) why = 'transcript unreadable';
          else if (found !== null) why = found;
          else if (denied.includes(rel)) why = NO_REASON.slice(2);
          else {
            ctx.save({ ...ctx.state, reasonDenied: [...denied, rel] });
            appendEvent(ctx.root, { ts: new Date().toISOString(), session, check: 'multi-file', decision: 'reason-required', files: [...files, rel] });
            return { kind: 'deny', reason: 'State why each extra file is necessary, then retry. Write one line per file: "<file> because <reason>".', check: 'multi-file' };
          }
        }
        appendEvent(ctx.root, { ts: new Date().toISOString(), session, check: 'multi-file', decision: 'allow-log', files: [...files, rel], ...(why ? { reason: `${rel}: ${why}` } : {}) });
      }
      return { kind: 'allow' };
    }
    if (approved) return { kind: 'allow' };
    return { kind: 'ask', reason: `This change now spans more than one file. Touched: ${list}. Next: ${rel}. Approve to continue this turn.`, check: 'multi-file' };
  },
};
