// Which heredoc bodies are data. A list of the commands that run a body can never be complete (| /bin/sh, su, ssh, at,
// a while-read loop, …), so a body is code unless the command it feeds is a known data sink (re-review 3, N1 and N3).
// The writer rule is strict on purpose (re-review 5): every redirect spelling not listed here is code, a few false
// blocks traded for no misses.
import { posix } from 'node:path';
import { LAST_ARG, redefines, reruns } from './guard-reruns.js';
import { type Scan } from './guard-scan.js';

/** Commands that write what they read to their output: data when that output goes to a plain file. */
const WRITERS = new Set(['cat', 'tee', 'dd', 'printf']);
/** What ends a simple command on a line. A `{` or `}` word does not: `ssh h {cat` is one word, ssh runs the body. The
 *  `&` of a redirect (`1>&2`, `&>f`) and the `|` of `>|` are part of the command. */
const SEP = /[;&|()`]/;
const isSep = (m: string, i: number) =>
  m[i] === '&' ? m[i - 1] !== '>' && m[i - 1] !== '<' && m[i + 1] !== '>' : m[i] === '|' ? m[i - 1] !== '>' : SEP.test(m[i]);
/** A heredoc operator and its delimiter word only, so a redirect glued after it (`<<'EOF'>&2`) stays. */
const HEREDOC_OP = /<<-?[ \t]*[^\s<>;&|()]*/g;
/** A plain path: no quoting needed (masked quotes are NUL), no `$` or backtick, no `..`, and once normalized no `dev`
 *  or `proc` segment (`//dev/stdout`, `/./proc/self/fd/1`, `cd / && cat > dev/stdout`), except `/dev/null` as written. */
const PLAIN = /^[\w./~+,:@%=-]+$/;
function plainPath(t: string | undefined): t is string {
  if (!t || !PLAIN.test(t) || /(?:^|\/)\.\.(?:\/|$)/.test(t)) return false;
  const n = posix.normalize(t);
  return n === '/dev/null' ? t === '/dev/null' : !n.split('/').some((p) => p === 'dev' || p === 'proc');
}
/** `exec` with a redirect anywhere: it moves fds for every later command, so no writer is a plain file write. */
const EXEC_REDIRECT = /(?:^|[\s;&|(){}`])exec\b[^;&|\n]*[<>]/;
/** An editor or pager setting: git, gh or less runs that program on the message (`GIT_EDITOR=sh git commit -e -m …`). */
export const EDITOR_SET = /\b(?:GIT_EDITOR|GH_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR|GIT_PAGER|GH_PAGER|PAGER|LESS|LESSOPEN|LESSCLOSE)=|\b(?:core\.(?:editor|pager)|sequence\.editor|pager\.[\w-]+)\b/i;
/** An editor flag: git and gh open the message in an editor (`git commit -e -m …`, `-em`, `--edit`, `gh … --editor`). */
export const EDIT_FLAG = /^(?:-[a-zA-Z]*e[a-zA-Z]*|--edit|--editor)(?:=|$)/;
/** A command line for the whole-line checks: `bodiless` without heredoc bodies, `skel` also without spaced quoted text. */
export interface Skel { skel: string; bodiless: string }

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

/** The simple commands of one masked line, found once: `at` gives the [start, end) of the one holding an offset. */
class Line {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  constructor(readonly m: string) {
    for (let i = 0, s = 0; i <= m.length; i++) if (i === m.length || isSep(m, i)) { this.starts.push(s); this.ends.push(i); s = i + 1; }
  }
  at(x: number): [number, number] {
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.starts[mid] <= x) lo = mid; else hi = mid - 1; }
    return [this.starts[lo], this.ends[lo]];
  }
  words(start: number, end: number): string[] { return this.m.slice(start, end).replace(HEREDOC_OP, ' ').split(/\s+/).filter(Boolean); }
  piped(end: number): boolean { return this.m[end] === '|' && this.m[end + 1] !== '|'; }
}
/** A writer's words and the files its stdout goes to, or null when a redirect is anything but a plain `>`, `>>` or `>|`
 *  to a plain path: an fd number, any `&` or `<`, a dup. */
function writerWords(ws: string[]): { words: string[]; files: string[] } | null {
  const words: string[] = [], files: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    if (/[&<]/.test(ws[i])) return null;
    if (!ws[i].includes('>')) { if (words.length || !/^\w+=/.test(ws[i])) words.push(ws[i]); continue; }
    const r = /^(>\||>>?)([^>]*)$/.exec(ws[i]);
    const target = r ? r[2] || ws[++i] : undefined;
    if (!plainPath(target)) return null;
    files.push(target);
  }
  return { words, files };
}

/** `-F -`, `-F-` or `--file=-` among `a`, for each of `flags`: the body is the message. */
const fileDash = (a: string[], flags: string[]) => a.some((x, i) => flags.some((f) => x === `${f}=-` || x === `${f}-` || (x === f && a[i + 1] === '-')));
/** `git commit|tag -F -` and `gh … --body-file|--notes-file|-F -`: the body is the message. Not with `-e`, which opens
 *  the message in an editor that may run it. */
function fileFlagSink(cmd: string | undefined, args: string[]): boolean {
  if (args.some((a) => EDIT_FLAG.test(a))) return false;
  if (cmd === 'git') return (args.includes('commit') || args.includes('tag')) && fileDash(args, ['-F', '--file']);
  if (cmd === 'gh') return fileDash(args, ['--body-file', '--notes-file', '-F']);
  return false;
}

/** How often each word (`[\w.-]+`) appears in a command, counted once on first use. */
export function wordCounter(whole: string): (w: string) => number {
  let counts: Map<string, number> | undefined;
  return (w) => {
    if (!counts) { counts = new Map(); for (const x of whole.split(/[^\w.-]+/)) counts.set(x, (counts.get(x) ?? 0) + 1); }
    return counts.get(w) ?? 0;
  };
}
/** True when a written file's name appears in the command again: it may be run (`cat > x.sh <<E && sh x.sh`). */
const reused = (files: string[], count: (w: string) => number) =>
  files.some((f) => { const b = f.split('/').pop()!; return f !== '/dev/null' && (!/^[\w.-]+$/.test(b) || count(b) > 1); });

/** The whole-command flags, read once from the skeleton guard-readings builds. A function, `alias`, `hash` or `enable`
 *  (`cat() { sh; }`) means no writer and no message flag is a sink; a re-runner or `$_` means no message flag is one,
 *  the same rule as for a plain message string. */
export function wholeFlags(c: string, sk: Skel = { skel: c, bodiless: c }) {
  const redef = redefines(sk.skel, sk.bodiless);
  const noMessages = EDITOR_SET.test(sk.skel) || redef || reruns(sk.bodiless) || LAST_ARG.test(c);
  return { count: wordCounter(c), noFiles: EXEC_REDIRECT.test(sk.skel) || redef, noMessages };
}
/**
 * The tests for one command, each simple command judged once, so many `<<` or `-m` stay linear. `sink(lineStart, at)`:
 * the heredoc at `at` feeds a data sink: cat, dd or printf whose every redirect is a plain `>`, `>>` or `>|` to a
 * plain path, tee whose arguments and stdout are all plain paths, dd with a plain `of=`, or `git commit|tag -F -` or
 * `gh … --body-file|--notes-file|-F -`. Never with `exec` and a redirect, a function, `alias`, `hash` or `enable` (they
 * can make `cat` or `git` run something else), an editor or pager setting, a pipe after it, or a file the command
 * names again. `rerunAt(lineStart, at)`: the simple command holding offset `at` has an editor flag (EDIT_FLAG) or a pipe after it.
 * `flags` are read from the whole command once (wholeFlags).
 */
export function commandTests(s: Scan, flags = wholeFlags(s.c)) {
  const { count, noFiles, noMessages } = flags, lines = new Map<number, Line>(), sinks = new Map<number, boolean>(), edited = new Map<number, boolean>();
  const line = (l: number) => { let x = lines.get(l); if (!x) lines.set(l, (x = new Line(maskedLine(s, l)))); return x; };
  const sinkAt = (x: Line, start: number, end: number): boolean => {
    if (x.piped(end)) return false; // the next stage reads it
    const ws = x.words(start, end), [cmd, ...args] = ws.filter((w) => !/^\w+=/.test(w));
    if (!WRITERS.has(cmd)) return !noMessages && fileFlagSink(cmd, args.filter((w) => !/[<>]/.test(w)));
    const w = noFiles ? null : writerWords(ws);
    if (!w) return false;
    const rest = w.words.slice(1), named = rest.filter((a) => !a.startsWith('-'));
    if (cmd === 'tee' && !named.every(plainPath)) return false; // tee /dev/stderr, tee "$o": not a plain file
    const of = cmd === 'dd' ? rest.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)) : [];
    if (!of.every(plainPath)) return false;
    if ((cmd === 'tee' || cmd === 'printf' || cmd === 'cat') && !w.files.length) return false;
    if (cmd === 'dd' && !w.files.length && !of.length) return false;
    return !reused([...w.files, ...(cmd === 'tee' ? named : []), ...of], count);
  };
  return {
    sink: (l: number, at: number) => {
      const x = line(l), [start, end] = x.at(at - l);
      let v = sinks.get(l + start);
      if (v === undefined) sinks.set(l + start, (v = sinkAt(x, start, end)));
      return v;
    },
    // A pipe could feed what git prints (`[branch sha] subject`) to a later stage, so a piped message command is code.
    rerunAt: (l: number, at: number) => {
      const x = line(l), [start, end] = x.at(at - l);
      let v = edited.get(l + start);
      if (v === undefined) edited.set(l + start, (v = x.piped(end) || x.words(start, end).some((w) => EDIT_FLAG.test(w))));
      return v;
    },
  };
}
