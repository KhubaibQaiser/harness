// Hook events come only from Claude Code: a command that runs the dispatcher in hook mode (it would read forged hook JSON
// on stdin) or copies a hook file out is denied. A guardrail on command text; the sandbox is the real boundary.
import { runnerName, type Seg, walkCommands, type Where } from '../guard.js';

// dispatch.ts's entry flags: with one of them the dispatcher never reads stdin as a hook event.
const ENTRY_FLAGS = new Set(['--pr-size', '--pr-size-raise', '--self-test']);
const COPIERS = new Set(['cp', 'mv', 'ln', 'rsync', 'install', 'ditto', 'dd', 'scp', 'tee', 'copy', 'copy-item', 'move-item']);
const REDIRECTS = new Set(['>', '>>', '<', '>|']);
export const HAND_RUN = "Blocked by pr-size: hook events come only from Claude Code. Run `.harness/hooks/dispatch.mjs` by hand only with `--pr-size`, `--pr-size-raise` or `--self-test`, and don't copy, move or link files out of `.harness/hooks/`.";

const norm = (t: string) => t.replace(/\\/g, '/');
const isHookFile = (t: string) => /(^|[/=])\.harness\/hooks(\/|$)/i.test(norm(t));
const isDispatcher = (t: string) => /(^|\/)\.harness\/hooks\/dispatch\.mjs$/i.test(norm(t));

function badSeg({ toks, k, next }: Seg): true | null {
  const cmd = toks[k] ?? '';
  const rest = toks.slice(k + 1);
  const hidden = cmd.startsWith('$') || cmd.startsWith('`');
  // Running the dispatcher (directly, through node/npx/env, or a hidden runner) with no entry flag.
  if ((isDispatcher(cmd) || (hidden && rest.some(isDispatcher))) && !rest.some((t) => ENTRY_FLAGS.has(t))) return true;
  if (isDispatcher(cmd)) return null;
  const hookArg = rest.some(isHookFile);
  // Copying, moving or linking a hook file, or sending one through a redirect or a pipe (`cat … > x`, `cat … | tee x`).
  if (hookArg && (COPIERS.has(runnerName(cmd)) || toks.some((t) => REDIRECTS.has(t)) || next === '|')) return true;
  return null;
}

/** The deny reason for a hand-run dispatcher or a copied hook file, or null. Commands that never name hooks skip the walk. */
export function handRun(command: string, w: Where): string | null {
  if (!/hooks|dispatch/i.test(command)) return null;
  return walkCommands(command, w, badSeg) ? HAND_RUN : null;
}
