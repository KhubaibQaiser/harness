// Asks once before an agent edits a second source unit in one turn; approval covers the rest of the turn.
// ponytail: Bash writes are not counted in M1 (spec 9b).
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { appendEvent } from '../core/events.js';
import { matches, pairKey, toRepoPath } from '../core/paths.js';
import { clearTurn } from '../core/state.js';
import type { Check, Ctx } from '../hooks/dispatch.js';

const LOCKS = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'];

// Repo-relative path of a counted edit, or null for other tools, outside-root, snapshots, lockfiles and generated files.
function target(ctx: Ctx): string | null {
  const { tool_name, tool_input = {} } = ctx.input;
  const key = tool_name === 'NotebookEdit' ? 'notebook_path' : tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit' ? 'file_path' : '';
  const p = key && tool_input[key];
  if (typeof p !== 'string' || !p) return null;
  const rel = toRepoPath(ctx.root, p);
  if (rel === null || /(^|\/)__snapshots__\//.test(rel) || rel.endsWith('.snap') || LOCKS.includes(basename(rel)) || matches(rel, ctx.config.multi_file_gate.generated)) return null;
  return rel;
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
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const c = o?.message?.content;
    if (o?.type === 'user') {
      const prompt = typeof c === 'string' || (Array.isArray(c) && c.some((b: any) => b?.type !== 'tool_result'));
      if (prompt) texts = [];
    } else if (o?.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
  }
  const name = basename(rel).toLowerCase();
  for (const t of texts) for (const l of t.split('\n')) if (l.toLowerCase().includes(name) && /\bbecause\b/i.test(l)) return l.trim().slice(0, 300);
  return null;
}

export const multiFile: Check = {
  name: 'multiFile',
  events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'],
  run(ctx) {
    if (!ctx.config.checks.multiFile) return { kind: 'allow' };
    const { hook_event_name: event, session_id: session } = ctx.input;
    if (event === 'UserPromptSubmit') {
      clearTurn(ctx.root, session);
      return { kind: 'allow' };
    }
    const rel = target(ctx);
    if (rel === null) return { kind: 'allow' };
    const { files, approved } = ctx.state;
    const units = new Set(files.map(pairKey));
    if (event === 'PostToolUse') {
      units.add(pairKey(rel));
      ctx.save({ ...ctx.state, files: files.includes(rel) ? files : [...files, rel], approved: approved || units.size >= 2 });
      return { kind: 'allow' };
    }
    // Record whenever allowed, so a parallel second PreToolUse sees this file.
    const record = () => {
      if (!files.includes(rel)) ctx.save({ ...ctx.state, files: [...files, rel] });
    };
    if (units.size === 0 || units.has(pairKey(rel))) {
      record();
      return { kind: 'allow' };
    }
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
      record();
      return { kind: 'allow' };
    }
    if (approved) {
      record();
      return { kind: 'allow' };
    }
    return { kind: 'ask', reason: `This change now spans more than one file. Touched: ${list}. Next: ${rel}. Approve to continue this turn.`, check: 'multi-file' };
  },
};
