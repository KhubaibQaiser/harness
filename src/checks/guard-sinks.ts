// Which heredoc bodies are data. A list of the commands that run a body can never be complete (| /bin/sh, su, ssh, at,
// a while-read loop, …), so a body is code unless the command it feeds is a known data sink (re-review 3, N1 and N3).
// The writer rule is strict on purpose (re-review 5): every redirect spelling not listed here is code, a few false
// blocks traded for no misses.
import { commandStart } from './guard.js';
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
/** A plain path: no quoting needed (masked quotes are NUL), no `$` or backtick, not a device or /proc but /dev/null. */
const PLAIN = /^[\w./~+,:@%=-]+$/;
const plainPath = (t: string | undefined): t is string => !!t && PLAIN.test(t) && (t === '/dev/null' || !/^\/(?:dev|proc)(?:\/|$)/.test(t));
/** `exec` with a redirect anywhere: it moves fds for every later command, so no writer is a plain file write. */
const EXEC_REDIRECT = /(?:^|[\s;&|(){}`])exec\b[^;&|\n]*[<>]/;
/** An editor or pager setting: git runs that program on the message (`GIT_EDITOR=sh git commit -e -m …`). */
export const EDITOR_SET = /\b(?:GIT_EDITOR|EDITOR|VISUAL|GIT_SEQUENCE_EDITOR|GIT_PAGER)=|\bcore\.(?:editor|pager)\b/i;

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
  /** True when a pipe takes the output of the command ending at `end` on to a stage that is not only a reader. */
  pipedOn(end: number, readers: boolean): boolean {
    while (this.m[end] === '|' && this.m[end + 1] !== '|') {
      const [s, e] = this.at(end + (this.m[end + 1] === '&' ? 2 : 1));
      if (!readers || !READERS.has(this.words(s, e)[0])) return true;
      end = e;
    }
    return false;
  }
}
/** Commands that only read the output a message command prints (`git commit … 2>&1 | tail -5`). */
const READERS = new Set(['tail', 'head', 'cat', 'grep', 'wc', 'less', 'more']);

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
/** `git commit|tag -F -` and `gh … --body-file|--notes-file|-F -`: the body is the message. */
function fileFlagSink(cmd: string | undefined, args: string[]): boolean {
  if (cmd === 'git') return (args.includes('commit') || args.includes('tag')) && fileDash(args, ['-F', '--file']);
  if (cmd === 'gh') return fileDash(args, ['--body-file', '--notes-file', '-F']);
  return false;
}

/** git's global options that take the next word: `-C dir`, `-c k=v`, `--git-dir x`. */
const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env|--attr-source)$/;
/** Commands whose message flag's value is only text: `git commit|tag|merge|notes -m`, `gh pr|issue|release … --body`,
 *  read past wrappers (`command`, `env X=1`) and global options (`git -C x`, `gh -R o/r`). */
function messageTaker(ws: string[]): boolean {
  const k = commandStart([...ws]), [cmd, ...a] = ws.slice(k).filter((w) => !/[<>]/.test(w));
  let i = 0;
  if (cmd === 'git') { while (a[i]?.startsWith('-')) i += GIT_VALUE.test(a[i]) ? 2 : 1; return ['commit', 'tag', 'merge', 'notes'].includes(a[i]); }
  if (cmd === 'gh') { while (a[i]?.startsWith('-')) i += a[i] === '-R' || a[i] === '--repo' ? 2 : 1; return ['pr', 'issue', 'release'].includes(a[i]); }
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

/**
 * The sink and message tests for one command `c`, each simple command judged once, so many `<<` or `-m` stay linear.
 * `sink(lineStart, at)`: the heredoc at `at` feeds a data sink: cat, dd or printf whose every redirect is a plain `>`,
 * `>>` or `>|` to a plain path, tee whose arguments and stdout are all plain paths, dd with a plain `of=`,
 * `git commit|tag -F -` or `gh … --body-file|--notes-file|-F -`, or, when `argValue` (`c` is a message flag's $(…)
 * value), a bare `cat`. Never with `exec` and a redirect in `c`, a pipe after it, or a file `c` names again.
 * `message(lineStart, at)`: the span at `at` is an argument of a known message-taking command, not piped on but into
 * a reader, with no editor or pager setting in `c`. `whole` is the command these flags are read from (default `s.c`).
 */
export function commandTests(s: Scan, argValue: boolean, whole = s.c) {
  const c = whole, count = wordCounter(c), lines = new Map<number, Line>(), sinks = new Map<number, boolean>(), messages = new Map<number, boolean>();
  const noFiles = EXEC_REDIRECT.test(c), editor = EDITOR_SET.test(c);
  const line = (l: number) => { let x = lines.get(l); if (!x) lines.set(l, (x = new Line(maskedLine(s, l)))); return x; };
  const sinkAt = (x: Line, start: number, end: number, l: number): boolean => {
    if (x.pipedOn(end, false)) return false; // the next stage reads it
    const ws = x.words(start, end), [cmd, ...args] = ws.filter((w) => !/^\w+=/.test(w));
    if (!WRITERS.has(cmd)) return !editor && fileFlagSink(cmd, args.filter((w) => !/[<>]/.test(w)));
    const w = noFiles ? null : writerWords(ws);
    if (!w) return false;
    const rest = w.words.slice(1), named = rest.filter((a) => !a.startsWith('-'));
    if (cmd === 'tee' && !named.every(plainPath)) return false; // tee /dev/stderr, tee "$o": not a plain file
    const of = cmd === 'dd' ? rest.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)) : [];
    if (!of.every(plainPath)) return false;
    if ((cmd === 'tee' || cmd === 'printf' || cmd === 'cat') && !w.files.length) return argValue && l === 0 && start === 0 && cmd === 'cat' && !rest.length;
    if (cmd === 'dd' && !w.files.length && !of.length) return false;
    return !reused([...w.files, ...(cmd === 'tee' ? named : []), ...of], count);
  };
  const memo = (cache: Map<number, boolean>, f: (x: Line, s: number, e: number, l: number) => boolean) => (l: number, at: number) => {
    const x = line(l), [start, end] = x.at(at - l);
    let v = cache.get(l + start);
    if (v === undefined) cache.set(l + start, (v = f(x, start, end, l)));
    return v;
  };
  return {
    sink: memo(sinks, sinkAt),
    message: memo(messages, (x, start, end) => !editor && !x.pipedOn(end, true) && messageTaker(x.words(start, end))),
  };
}
