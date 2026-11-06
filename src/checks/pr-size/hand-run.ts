// Hook events come only from Claude Code: a command that runs the dispatcher in hook mode (it would read forged hook JSON
// on stdin) or copies a hook file out is denied. A guardrail on command text; the sandbox is the real boundary.
import { posix } from 'node:path';
import { runnerName, type Seg, walkCommands, type Where } from '../guard.js';

// dispatch.ts's entry flags: with one of them the dispatcher never reads stdin as a hook event.
const ENTRY_FLAGS = new Set(['--pr-size', '--pr-size-raise', '--self-test']);
const COPIERS = new Set(['cp', 'mv', 'ln', 'rsync', 'install', 'ditto', 'dd', 'scp', 'tee', 'copy', 'copy-item', 'move-item']);
// A redirect word, spaced or not (`>`, `>>x`, `2>`, `<<<`).
const REDIRECT = /^\d*(<{1,3}|>{1,2}\|?|&>)/;
export const HAND_RUN = "Blocked by pr-size: hook events come only from Claude Code. Run a hook dispatcher (`.harness/hooks/dispatch.mjs`, or the package's `dist/hooks/dispatch.mjs`) by hand only with `--pr-size`, `--pr-size-raise` or `--self-test`, and don't copy, move or link hook files, or pipe or redirect them, even to read them.";

// One spelling per path: quotes dropped, `\` read as `/`, and `//`, `./` and `..` collapsed (`.harness//hooks/./x`).
const norm = (t: string) => posix.normalize(t.replace(/['"]/g, '').replace(/\\/g, '/'));
// Any dispatcher: the repo's `.harness/hooks/`, the package's `dist/hooks/` (node_modules, the npx cache, a plugin root),
// or a `.harness` symlink, all end in `hooks/dispatch.mjs`.
const isDispatcher = (t: string) => /(^|\/)hooks\/dispatch\.mjs$/i.test(norm(t));
const isHookFile = (t: string) => isDispatcher(t) || /(^|[/=])\.harness\/hooks(\/|$)/i.test(norm(t));

function badSeg({ toks, k, prev, next }: Seg): true | null {
  const cmd = toks[k] ?? '';
  const rest = toks.slice(k + 1);
  const hidden = cmd.startsWith('$') || cmd.startsWith('`');
  // Running the dispatcher (directly, through node/npx/env, or a hidden runner) with no entry flag.
  if ((isDispatcher(cmd) || (hidden && rest.some(isDispatcher))) && !rest.some((t) => ENTRY_FLAGS.has(t))) return true;
  if (isDispatcher(cmd)) return null;
  const hookArg = rest.some(isHookFile);
  // Copying, moving or linking a hook file, or one in a segment with a redirect or a pipe in or out (`cat … > x`,
  // `cat … | tee x`, `cat forged.json | tsx …/dispatch.mjs`, where the runner isn't one the walker steps past).
  if (hookArg && (COPIERS.has(runnerName(cmd)) || toks.some((t) => REDIRECT.test(t)) || next === '|' || prev === '|')) return true;
  return null;
}

/** The deny reason for a hand-run dispatcher or a copied hook file, or null. Commands that never name hooks skip the walk. */
export function handRun(command: string, w: Where): string | null {
  if (!/hooks|dispatch/i.test(command)) return null;
  return walkCommands(command, w, badSeg) ? HAND_RUN : null;
}
