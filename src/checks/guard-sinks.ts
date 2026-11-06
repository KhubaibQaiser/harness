// Which heredoc bodies are data. A list of the commands that run a body can never be complete (| /bin/sh, su, ssh, at,
// a while-read loop, …), so a body is code unless the command it feeds is a known data sink (re-review 3, N1 and N3).
import type { Scan } from './guard-scan.js';

/** Commands that write what they read to their output: data when that output goes to a file. */
const WRITERS = new Set(['cat', 'tee', 'dd', 'printf']);
/** What ends a simple command on a line. A `{` or `}` word does not: `ssh h {cat` is one word, ssh runs the body. */
const SEP = /[;&|()`]/;
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

/** The command's words without leading assignments and redirections, and the files its stdout is redirected to. */
function commandWords(seg: string): { words: string[]; files: string[] } {
  const t = seg.split(/\s+/).filter(Boolean), words: string[] = [], files: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const r = REDIRECT.exec(t[i]);
    if (r) {
      const target = r[3] || t[++i]; // glued on, or the next word
      if (/^>[>|]?$/.test(r[2]) && (r[1] === '' || r[1] === '1' || r[1] === '&') && isFile(target)) files.push(target);
    } else if (words.length || !/^\w+=/.test(t[i])) words.push(t[i]);
  }
  return { words, files };
}

/**
 * A test for one masked line `m`: true when the heredoc whose `<<` is at `at` feeds a known data sink: cat, tee, dd or
 * printf writing to a file (see NOT_A_FILE), `git commit|tag -F -`, `gh … --body-file|--notes-file|-F -`, or, when
 * `argValue` (the line starts a $(…) that is a flag's value, `-m "$(cat <<'EOF'`), a bare `cat`. A pipeline that goes on
 * past it, a process substitution in it, or a written file the command names again (`&& sh x.sh`) makes it code. Each simple command is judged once, so many `<<` stay linear.
 */
export function sinkTest(m: string, argValue: boolean, count: (w: string) => number): (at: number) => boolean {
  const seen = new Map<number, boolean>();
  let start = 0, end = -1;
  return (at) => {
    if (at >= end) { // the next simple command: its bounds, found once
      for (start = at; start > 0 && !SEP.test(m[start - 1]);) start--;
      for (end = at; end < m.length && !SEP.test(m[end]);) end++;
    }
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
  files.some((f) => { const b = f.split('/').pop()!; return !/^[\w.-]+$/.test(b) || count(b) > 1; });

function isSink(m: string, start: number, end: number, argValue: boolean, count: (w: string) => number): boolean {
  if (m[end] === '|' && m[end + 1] !== '|') return false; // the next stage reads it
  const seg = m.slice(start, end).replace(/<<-?[ \t]*\S*/g, ' ');
  if (/[<>]\(/.test(seg)) return false; // >(sh) runs what it gets
  const { words, files } = commandWords(seg);
  const [cmd, ...args] = words;
  if (WRITERS.has(cmd)) {
    if (cmd === 'tee') files.push(...args.filter((a) => !a.startsWith('-') && isFile(a)));
    if (cmd === 'dd') files.push(...args.filter((a) => a.startsWith('of=') && isFile(a.slice(3))).map((a) => a.slice(3)));
    return files.length ? !reused(files, count) : argValue && start === 0 && cmd === 'cat' && !args.length;
  }
  if (cmd === 'git') return (args.includes('commit') || args.includes('tag')) && fileDash(args, ['-F', '--file']);
  if (cmd === 'gh') return fileDash(args, ['--body-file', '--notes-file', '-F']);
  return false;
}
