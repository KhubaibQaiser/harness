// Turns a configured stop step into a command, and finds binaries without a shell.
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig, StopStep } from '../../core/config.js';

export type Resolved = { cmd: string; args: string[]; label: string };

// Own-property check: a script named "toString" must not match the prototype.
export function resolveStep(
  step: StopStep,
  pm: HarnessConfig['stop']['package_manager'],
  scripts: Record<string, unknown>,
  _platform: NodeJS.Platform = process.platform,
): Resolved | null {
  if (typeof step !== 'string') return { cmd: step.run[0], args: step.run.slice(1), label: step.name };
  if (pm === 'none' || !Object.hasOwn(scripts, step)) return null;
  return { cmd: pm, args: ['run', step], label: step };
}

const isFile = (f: string, win: boolean) => {
  try {
    if (!statSync(f).isFile()) return false;
    if (!win) accessSync(f, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findOnPath(cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const win = platform === 'win32';
  const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
  const dirs = (key ? env[key] ?? '' : '').split(win ? ';' : ':').filter(Boolean);
  const pathext = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [];
  const names = win ? [cmd, ...pathext.map((e) => cmd + e.toLowerCase()), ...pathext.map((e) => cmd + e)] : [cmd];
  for (const d of dirs) for (const n of names) if (isFile(join(d, n), win)) return join(d, n);
  return null;
}

// cmd.exe line for a .cmd/.bat file, quoted like cross-spawn: Win32 argv quoting, then ^-escape the cmd.exe meta characters.
const META = /([()\][%!^"`<>&|;, *?])/g;
export function winCmdLine(file: string, args: string[]): string {
  const arg = (a: string) => `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1');
  return `"${[file.replace(META, '^$1'), ...args.map(arg)].join(' ')}"`;
}
