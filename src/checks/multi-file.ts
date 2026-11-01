// Asks once before an agent edits a second source unit in one turn; approval covers the rest of the turn.
// ponytail: Bash writes are not counted in M1 (spec 9b).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { appendEvent } from '../core/events.js';
import { matches, pairKey, toRepoPath } from '../core/paths.js';
import { clearTurn } from '../core/state.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { editTarget } from '../hooks/edit-target.js';

const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

// Repo-relative path of a counted edit, or null for other tools, outside-root, snapshots, lockfiles and generated files.
function target(ctx: Ctx): string | null {
  const p = editTarget(ctx.input);
  if (p === null) return null;
  const rel = toRepoPath(ctx.root, p);
  if (rel === null || /(^|\/)__snapshots__\//.test(rel) || rel.endsWith('.snap') || LOCKS.includes(basename(rel)) || matches(rel, ctx.config.multi_file_gate.generated)) return null;
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
// ponytail: the transcript JSONL format is not a documented stable API; unknown shapes are skipped and an unreadable file fails open.
function findReason(path: unknown, rel: string): string | null | undefined {
  if (typeof path !== 'string' || !path) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let texts: string[] = [];
  for (const line of raw.split('\n')) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const rec = obj(o);
    const c = obj(rec.message).content;
    if (rec.type === 'user') {
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => obj(b).type !== 'tool_result'))) texts = [];
    } else if (rec.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        const { type, text } = obj(b);
        if (type === 'text' && typeof text === 'string') texts.push(text);
      }
    }
  }
  const name = basename(rel).toLowerCase();
  for (const t of texts) for (const l of t.split('\n')) if (hasName(l.toLowerCase(), name) && /\bbecause\b/i.test(l)) return l.trim().slice(0, 300);
  return null;
}

export const multiFile: Check = {
  name: 'multiFile',
  events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
  run(ctx) {
    const { hook_event_name: event, session_id: session } = ctx.input;
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
    // PreToolUse only decides; PostToolUse records, so a declined ask leaves no trace.
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
          else if (denied.includes(rel)) why = 'no reason given';
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
