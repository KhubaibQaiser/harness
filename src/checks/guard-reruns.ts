// What in a command line can run a message's text again, read where the shell runs commands: the first word of each
// simple command past keywords and assignments, every word after a wrapper (sudo, xargs, env, …), and find -exec. A
// word anywhere else (`docker exec`, `kubectl exec`, a path such as `-C /tmp/sh`) runs nothing (re-review 8, round 9).
import { posix } from 'node:path';
import { segments, unquote, words } from '../core/shell-words.js';

/** Keywords before the command word. `select`, `for` and `case` take a name, not a command; `[[` tests nothing it runs. */
const LEADERS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '[[', ']]']);
/** Commands that run a later word as a command; their options may take values, so every later word counts. */
const WRAPPERS = new Set(['command', 'builtin', 'env', 'nice', 'nohup', 'sudo', 'doas', 'xargs', 'timeout', 'stdbuf', 'ionice', 'setsid', 'time',
  'coproc', 'npx', 'bunx', 'uvx', 'flock', 'chronic', 'unbuffer', 'caffeinate', 'systemd-run', 'nsenter', 'chroot', 'firejail']);
/** Package managers whose subcommand runs a command: `pnpm exec|dlx`, `yarn exec|dlx`, `npm exec|x`, `bun x`, `uv run`. */
const RUNNER_SUBCOMMANDS: Record<string, string[]> = { pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], npm: ['exec', 'x'], bun: ['x'], uv: ['run'] };
/** Where a wrapper at `k` starts its command's words (past `pnpm exec`), or -1 when `ws[k]` is no wrapper. */
const wrapped = (ws: string[], k: number) => (WRAPPERS.has(base(ws[k])) ? k + 1 : RUNNER_SUBCOMMANDS[base(ws[k])]?.includes(ws[k + 1]) ? k + 2 : -1);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'mksh', 'ash', 'fish']);
/** Commands that parse text again: eval and friends, a shell (see shellReruns), and those that hand words to a shell. */
const RERUNNERS = new Set(['eval', 'exec', 'source', '.', 'case', 'busybox', 'ssh', 'su', 'watch', 'parallel', 'script', ...SHELLS]);
/** Commands that change what a later name runs. A `name()` definition is found on the skeleton (FUNCTION_DEF). */
const REDEFINERS = new Set(['function', 'alias', 'hash', 'enable', 'unalias']);
const FUNCTION_DEF = /[\w-]\s*\(\s*\)/;
/** Shell options that take the next word. */
const SHELL_VALUE = /^(?:[-+][oO]|--rcfile|--init-file)$/;
const base = (w: string) => w.split('/').pop()!;

/** Each command a line runs, as its name and the words after it. */
function commandsRun(cmd: string): { name: string; args: string[] }[] {
  const out: { name: string; args: string[] }[] = [];
  for (const seg of segments(cmd)) {
    const ws = words(seg).map(unquote);
    let k = 0;
    while (k < ws.length && (LEADERS.has(ws[k]) || /^\w+=/.test(ws[k]))) k++;
    if (k >= ws.length) continue;
    out.push({ name: base(ws[k]), args: ws.slice(k + 1) });
    const w = wrapped(ws, k);
    if (w > 0) for (let j = w; j < ws.length; j++) out.push({ name: base(ws[j]), args: ws.slice(j + 1) });
    const e = ws.findIndex((x) => /^-(?:exec|execdir|ok|okdir)$/.test(x)); // find -exec sh
    if (e >= 0 && ws[e + 1]) out.push({ name: base(ws[e + 1]), args: ws.slice(e + 2) });
  }
  return out;
}

/** True when a shell with these arguments parses text it was given: it reads stdin (no script file, or -s/-i, or a
 *  "script" that is stdin: `-`, `/dev/stdin`, `/dev/fd/N`, a process substitution or a `<` redirect), or its
 *  -c payload holds `$` or a backtick (it can reach `$0`, `$1`) or runs something that parses again. A literal payload
 *  (`bash -c 'echo ok' -m '…'`: the message is only `$0`) or a script file (`zsh -m "…"`: a file name) parses nothing. */
function shellReruns(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SHELL_VALUE.test(a)) { i++; continue; }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
      const payload = args.slice(i + 1).find((x) => !/^[-+]/.test(x));
      return payload === undefined || /[$`]/.test(payload) || reruns(payload);
    }
    if (/^-[a-zA-Z]*[si][a-zA-Z]*$/.test(a)) return true; // sh -s, bash -i: stdin
    if (a === '-' || /^[<>]/.test(a) || /^\/(?:dev|proc)\//.test(posix.normalize(a))) return true; // stdin, /dev/fd/3, <(…), < file
    if (!/^[-+]/.test(a)) return false; // a script file
  }
  return true; // no script file: it reads stdin
}

/** True when the line runs something that can parse a message's text again (see RERUNNERS), or env -S/--s…. */
export function reruns(cmd: string): boolean {
  return commandsRun(cmd).some(({ name, args }) => {
    if (name === 'env') return args.slice(0, Math.max(0, args.findIndex((a) => !/^-|=/.test(a)))).some((a) => /^(?:-[a-zA-Z]*S|--s)/.test(a));
    return RERUNNERS.has(name) && (!SHELLS.has(name) || shellReruns(args));
  });
}

/** True when the line defines a function, alias or hash entry, or enables a builtin: a later name may run something
 *  else (`tail() { sh; }`, `hash -p /bin/sh head`). `skel` has quoted text blanked, `bodiless` keeps it. */
export const redefines = (skel: string, bodiless: string): boolean =>
  FUNCTION_DEF.test(skel) || commandsRun(bodiless).some(({ name }) => REDEFINERS.has(name));
/** `$_` or `${_}`: the last argument of the previous command, which can be the message (`…; eval "$_"`). */
export const LAST_ARG = /\$(?:_(?!\w)|\{_\})/;
