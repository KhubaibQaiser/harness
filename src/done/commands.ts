import { commandStart, HARNESS_CMD, runnerName } from '../checks/guard.js';
import { resolveStep, scriptsOf } from '../checks/stop/runner.js';
import type { HarnessConfig } from '../core/config.js';
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

/** The args of a command line that is exactly one harness invocation (`npx harness done …` too); else null. */
export function harnessArgs(command: string): string[] | null {
  const argv = plainArgv(command);
  if (!argv) return null;
  const k = commandStart(argv);
  return k < argv.length && HARNESS_CMD.test(argv[k]!) ? argv.slice(k + 1) : null;
}

const RUNNER = /^(vitest|jest)$/;
/** A known test runner call (plan Decisions): vitest or jest, through npx, pnpm, yarn, bunx or pnpm/yarn exec; or a package manager's test script. */
export function isTestRunner(argv: string[]): boolean {
  const [a = '', b = '', c = ''] = [runnerName(argv[0] ?? ''), argv[1], argv[2]];
  if (RUNNER.test(a) || (['npx', 'pnpm', 'yarn', 'bunx'].includes(a) && RUNNER.test(b))) return true;
  if ((a === 'pnpm' || a === 'yarn') && b === 'exec' && RUNNER.test(c)) return true;
  return ['npm', 'pnpm', 'yarn', 'bun'].includes(a) && (b === 'test' || (b === 'run' && c === 'test'));
}

/** The argv the stop step labelled `name` runs, e.g. ['pnpm', 'run', 'test']; null when no configured step resolves to it. */
export function checkArgv(root: string, config: HarnessConfig, name: string): string[] | null {
  const scripts = scriptsOf(root);
  for (const step of config.stop.steps) {
    const r = resolveStep(step, config.stop.package_manager, scripts);
    if (r?.label === name) return [r.cmd, ...r.args];
  }
  return null;
}
