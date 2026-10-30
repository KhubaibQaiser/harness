// Asks once before an agent edits a second source unit in one turn; approval covers the rest of the turn.
// ponytail: Bash writes are not counted in M1 (spec 9b).
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
    if (units.size === 0 || units.has(pairKey(rel))) return { kind: 'allow' };
    const list = files.join(', ');
    if (ctx.unattended) {
      const mode = ctx.config.unattended.multi_file_gate;
      if (mode === 'block') return { kind: 'deny', reason: `Unattended multi-file change blocked. Wanted: ${[...files, rel].join(', ')}.`, check: 'multi-file' };
      if (mode === 'allow-log') appendEvent(ctx.root, { ts: new Date().toISOString(), session, check: 'multi-file', decision: 'allow-log', files: [...files, rel] });
      return { kind: 'allow' };
    }
    if (approved) return { kind: 'allow' };
    return { kind: 'ask', reason: `This change now spans more than one file. Touched: ${list}. Next: ${rel}. Approve to continue this turn.`, check: 'multi-file' };
  },
};
