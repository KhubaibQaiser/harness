// Which heredoc bodies are data. A list of the commands that run a body can never be complete (| /bin/sh, su, ssh, at,
// a while-read loop, …), so a body is code unless the command it feeds is a known data sink (re-review 3, N1 and N3).
import type { Scan } from './guard-scan.js';

/** Commands that write what they read to their output: data when that output goes to a file. */
const WRITERS = new Set(['cat', 'tee', 'dd', 'printf']);
/** What ends a simple command on a line. A `{` or `}` word does not: `ssh h {cat` is one word, ssh runs the body. The
 *  `&` of a redirect (`1>&2`, `&>f`) and the `|` of `>|` are part of the command. */
const SEP = /[;&|()`]/;
const isSep = (m: string, i: number) =>
  m[i] === '&' ? m[i - 1] !== '>' && m[i - 1] !== '<' && m[i + 1] !== '>' : m[i] === '|' ? m[i - 1] !== '>' : SEP.test(m[i]);
/** The simple command around offset `at` of masked line `m`: its bounds, and whether a pipe takes its output on. */
function commandAt(m: string, at: number, to = at): { start: number; end: number; piped: boolean } {
  let start = at, end = to;
  while (start > 0 && !isSep(m, start - 1)) start--;
  while (end < m.length && !isSep(m, end)) end++;
  return { start, end, piped: m[end] === '|' && m[end + 1] !== '|' };
}
/** A redirection word: an fd or `&`, the operator, then the target when it is glued on (`>f`, `2>&1`, `&>>log`). */
const REDIRECT = /^(\d*|&)([<>][>&|]?)(.*)$/;
/** A target that may not be a file: an fd, /dev or /proc, or a word the guard cannot read (quoted, escaped or with an
 *  expansion). Its output may still reach a pipe the guard cannot see: `( cat >/dev/stdout <<E ) | sh`. */
const NOT_A_FILE = /^(?:&|\/dev\/(?!null$)|\/proc\/)|[\0$`]/;
const isFile = (t: string | undefined) => !!t && !NOT_A_FILE.test(t);

/** The logical line at `from`, up to its first newline outside quotes, with each quoted span and escape masked as NUL
 *  characters (same length, so offsets carry over). */
export function maskedLine(s: Scan, from: number): string {
  const c = s.c;
  let out = '';
  for (let i = from; i < c.length && c[i] !== '\n'; i++) {
    const ch = c[i];
    const e = ch === '\\' ? i + 2 : ch === '$' && c[i + 1] === "'" ? s.closeAnsiC(i + 2) : ch === "'" ? c.indexOf("'", i + 1) + 1 || c.length : ch === '"' ? s.closeDouble(i) : i + 1;
    out += e === i + 1 ? ch : '\0'.repeat(Math.min(e, c.length) - i);
    i = e - 1;
  }
  return out;
}

/** `-F -`, `-F-` or `--file=-` among `a`, for each of `flags`: the body is the message. */
const fileDash = (a: string[], flags: string[]) => a.some((x, i) => flags.some((f) => x === `${f}=-` || x === `${f}-` || (x === f && a[i + 1] === '-')));

/** The command's words without leading assignments and redirections, and where its stdout ends up once every redirect
 *  is applied in order: undefined (not redirected), a file, or null (an fd dup such as `>&3` or `1>&2`, or a target
 *  that may not be a file). */
function commandWords(seg: string): { words: string[]; out: string | null | undefined } {
  const t = seg.split(/\s+/).filter(Boolean), words: string[] = [];
  let out: string | null | undefined;
  for (let i = 0; i < t.length; i++) {
    const r = REDIRECT.exec(t[i]);
    if (r) {
      const target = r[3] || t[++i]; // glued on, or the next word
      if (r[2][0] === '>' && (r[1] === '' || r[1] === '1' || r[1] === '&')) out = r[2] !== '>&' && isFile(target) ? target : null;
    } else if (words.length || !/^\w+=/.test(t[i])) words.push(t[i]);
  }
  return { words, out };
}

/** Commands whose message flag's value is only text: `git commit|tag|merge|notes -m`, `gh pr|issue|release … --body`. */
const MESSAGE_TAKERS: Record<string, string[]> = { git: ['commit', 'tag', 'merge', 'notes'], gh: ['pr', 'issue', 'release'] };
/** True when the quoted span at `at` of masked line `m` is an argument of a known message-taking command whose output
 *  no pipe takes on. */
export function messageCommand(m: string, at: number): boolean {
  const { start, end, piped } = commandAt(m, at);
  if (piped) return false;
  const [cmd, ...args] = commandWords(m.slice(start, end)).words;
  const subs = MESSAGE_TAKERS[cmd];
  return !!subs && (cmd === 'gh' ? subs.includes(args[0]) : args.some((a) => subs.includes(a)));
}

/**
 * A test for one masked line `m`: true when the heredoc whose `<<` is at `at` feeds a known data sink: cat, dd or
 * printf whose final stdout is a file (see NOT_A_FILE), tee when its stdout is a file too, `git commit|tag -F -`,
 * `gh … --body-file|--notes-file|-F -`, or, when `argValue` (the line starts a $(…) that is a flag's value,
 * `-m "$(cat <<'EOF'`), a bare `cat`. A pipeline that goes on past it, a process substitution in it, or a written file
 * the command names again (`&& sh x.sh`) makes it code. Each simple command is judged once, so many `<<` stay linear.
 */
export function sinkTest(m: string, argValue: boolean, count: (w: string) => number): (at: number) => boolean {
  const seen = new Map<number, boolean>();
  let start = 0, end = -1;
  return (at) => {
    if (at >= end) ({ start, end } = commandAt(m, at)); // the next simple command: its bounds, found once
    let data = seen.get(start);
    if (data === undefined) seen.set(start, (data = isSink(m, start, end, argValue, count)));
    return data;
  };
}

/** How often each word (`[\w.-]+`) appears in a command, counted once on first use. */
export function wordCounter(whole: string): (w: string) => number {
  let counts: Map<string, number> | undefined;
  return (w) => {
    if (!counts) { counts = new Map(); for (const x of whole.split(/[^\w.-]+/)) counts.set(x, (counts.get(x) ?? 0) + 1); }
    return counts.get(w) ?? 0;
  };
}
/** True when a written file's name appears in the command again: it may be run (`cat > x.sh <<E && sh x.sh`). A name
 *  that is not one plain word counts as named again. */
const reused = (files: string[], count: (w: string) => number) =>
  files.some((f) => { const b = f.split('/').pop()!; return f !== '/dev/null' && (!/^[\w.-]+$/.test(b) || count(b) > 1); });

function isSink(m: string, start: number, end: number, argValue: boolean, count: (w: string) => number): boolean {
  if (m[end] === '|' && m[end + 1] !== '|') return false; // the next stage reads it
  const seg = m.slice(start, end).replace(/<<-?[ \t]*\S*/g, ' ');
  if (/[<>]\(/.test(seg)) return false; // >(sh) runs what it gets
  const { words, out } = commandWords(seg);
  const [cmd, ...args] = words;
  if (!WRITERS.has(cmd) || out === null) return !WRITERS.has(cmd) && fileFlagSink(cmd, args);
  // tee copies its input to stdout too, so its stdout must go to a file as well; dd writes to of= instead of stdout.
  const files = out ? [out] : [];
  if (cmd === 'tee') files.push(...args.filter((a) => !a.startsWith('-') && isFile(a)));
  const of = cmd === 'dd' ? args.filter((a) => a.startsWith('of=') && isFile(a.slice(3))).map((a) => a.slice(3)) : [];
  if (out || of.length) return !reused([...files, ...of], count);
  return argValue && start === 0 && cmd === 'cat' && !args.length;
}

/** `git commit|tag -F -` and `gh … --body-file|--notes-file|-F -`: the body is the message. */
function fileFlagSink(cmd: string | undefined, args: string[]): boolean {
  if (cmd === 'git') return (args.includes('commit') || args.includes('tag')) && fileDash(args, ['-F', '--file']);
  if (cmd === 'gh') return fileDash(args, ['--body-file', '--notes-file', '-F']);
  return false;
}
