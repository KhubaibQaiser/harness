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

/** Every configured stop step that resolves here, label -> argv (the first step per label), reading package.json once. */
export function checkArgvs(root: string, config: HarnessConfig): Map<string, string[]> {
  const scripts = scriptsOf(root), out = new Map<string, string[]>();
  for (const step of config.stop.steps) {
    const r = resolveStep(step, config.stop.package_manager, scripts);
    if (r && !out.has(r.label)) out.set(r.label, [r.cmd, ...r.args]);
  }
  return out;
}

/** The argv the stop step labelled `name` runs, e.g. ['pnpm', 'run', 'test']; null when no configured step resolves to it. */
export const checkArgv = (root: string, config: HarnessConfig, name: string): string[] | null => checkArgvs(root, config).get(name) ?? null;

/** What the hook records from `harness done --blocked "<reason>"`: the row keeps this many characters. */
export const MAX_BLOCKED_REASON = 500;

/** The reason of a command line that is exactly `harness done --blocked "<reason>"` with a non-blank reason; else null. The CLI and the hook share it. */
export function blockedReason(command: string): string | null {
  const a = harnessArgs(command);
  return a?.length === 3 && a[0] === 'done' && a[1] === '--blocked' && a[2]!.trim() ? a[2]! : null;
}
