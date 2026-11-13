import { balanced, segments, unquote, words } from '../core/shell-words.js';

// Shell syntax, plus globs, ~, braces and # comments: the agent's shell would run something other than the argv
// harness reads (and later runs without a shell), so a command using any of them never counts as the check.
const SHELL_SYNTAX = /[$`()<>|&;\\*?[\]{}~#\n\r]/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The argv of a command that is exactly one plain program call, quotes removed; else null. */
export function plainArgv(command: string): string[] | null {
  if (SHELL_SYNTAX.test(command) || !balanced(command) || segments(command).length !== 1) return null;
  const ws = words(command.trim());
  if (!ws.length || ASSIGNMENT.test(ws[0]!)) return null;
  return ws.map(unquote);
}
