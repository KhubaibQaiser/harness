// Extra readings of a Bash command for the guard's text rules: what the shell can turn a word into before it runs.
// Imported by guard.ts, which this module imports back: use guard.ts names only inside functions, never at load time.
import picomatch from 'picomatch';
import { commandStart, quoteFree, SEGMENTS } from './guard.js';
import { Groups, quotedAt, type Quoted, Scan, ScanBudget } from './guard-scan.js';
import { commandTests, EDITOR_SET, type Skel, wholeFlags } from './guard-sinks.js';
import { LAST_ARG, redefines, reruns } from './guard-reruns.js';

/** Command names the text rules and checks look for. A command-position glob that can match one is read as it. */
const RULED = ['git', 'gh', 'curl', 'wget', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'chmod', 'dd', 'rm', 'sudo', 'eval', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv',
  'cdk', 'terraform', 'aws', 'kubectl', 'docker', 'vercel', 'harness', 'cli.mjs', 'cli.js'];
/** Readings of one segment (a glob, then a glob after the wrapper it became, …) or of one command word's zsh alternations. */
const MAX_SEGMENT_READINGS = 32;
/** All segments' readings combined (every glob at once) while the product stays this small. */
const MAX_COMBINED = 64;
/** Readings in all. Past this the guard asks: it cannot say the command is safe. */
export const MAX_READINGS = 2048;
/** Characters of reading text in all, so a big command gets few full-length readings and answers fast. */
const MAX_READING_CHARS = 16 * 1024;
const GLOB = /[*?[]/;
/** zsh's default glob alternation inside a word: g(i|x)t. Bash rejects it, so reading it is only stricter. */
const ZSH_ALT = /(?<=[\w./*?\]-])\(([^()\s]*\|[^()\s]*)\)/g;
let segmentSplit: RegExp | undefined; // built on first use, see the import note

export interface GlobReadings { texts: string[]; capped: boolean }

/** Collects readings once each, within MAX_READINGS and MAX_READING_CHARS. `add` is false when a bound is hit. */
class Budget {
  readonly seen = new Set<string>();
  chars = 0;
  constructor(private readonly own: string) {}
  add(t: string): boolean {
    if (t === this.own || this.seen.has(t)) return true;
    if (this.seen.size >= MAX_READINGS || this.chars + t.length > MAX_READING_CHARS) return false;
    this.seen.add(t);
    this.chars += t.length;
    return true;
  }
  fits(n: number, len: number): boolean { return this.seen.size + n <= MAX_READINGS && this.chars + n * len <= MAX_READING_CHARS; }
}

/** Where the quoted spans and heredoc bodies of a command are. Offsets into the command, `to` exclusive. */
interface Heredoc { from: number; to: number; literal: boolean; program: boolean } // the body and its end line
interface Layout { quotes: Quoted[]; heredocs: Heredoc[] }

/** Where the shell sees quotes and heredoc bodies: `\` escapes outside quotes, `'…'` is literal, `$'…'` is literal with
 *  `\` escapes, `"…"` keeps its substitutions, `$((…))` and `((…))` are arithmetic (`1<<E` is a shift), and `<<WORD`
 *  takes the lines up to WORD. A body is a program unless `tests.sink` says it goes to a data sink, outside any
 *  group. A heredoc this cannot read (a delimiter with an expansion, no end line) leaves every body in place. */
function layout(s: Scan, tests: { sink: (l: number, at: number) => boolean }): Layout {
  const c = s.c, quotes: Quoted[] = [], heredocs: Heredoc[] = [], groups = new Groups();
  let pending: { word: string; dash: boolean; literal: boolean; data: boolean }[] = [], lineStart = 0, ticks = 0;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    const q = ch === '\\' ? null : quotedAt(s, i);
    if (ch === '\\') i++;
    else if (q) { quotes.push({ ...q, line: lineStart }); i = q.end - 1; }
    else if ((ch === '$' && c[i + 1] === '(' && c[i + 2] === '(') || (ch === '(' && c[i + 1] === '(')) i = s.closeParen(i + (ch === '$' ? 3 : 2), 2) - 1;
    else if (ch === '<' && c[i + 1] === '<') {
      if (c[i + 2] === '<') { i += 2; continue; } // a here-string
      let d = i + 2;
      const dash = c[d] === '-';
      if (dash) d++;
      while (c[d] === ' ' || c[d] === '\t') d++;
      let word = '', q = '', literal = false;
      for (; d < c.length; d++) {
        const x = c[d];
        if (q) { if (x === q) q = ''; else word += x; }
        else if (x === '"' || x === "'") { q = x; literal = true; }
        else if (x === '\\') { literal = true; word += c[++d] ?? ''; }
        else if (/[\s;|&<>()]/.test(x)) break;
        else word += x;
      }
      if (q || !/^\w+$/.test(word)) return { quotes, heredocs: [] };
      // A writer inside ( ), { }, $( ) or backticks is code: the group may pipe, redirect or capture what it prints.
      pending.push({ word, dash, literal, data: groups.depth === 0 && ticks % 2 === 0 && tests.sink(lineStart, i) });
      i = d - 1;
    } else if (ch === '\n' && pending.length) {
      let p = i + 1;
      for (const h of pending) {
        const from = p;
        for (;;) {
          if (p >= c.length) return { quotes, heredocs: [] }; // no end line: nothing is hidden
          const nl = c.indexOf('\n', p), end = nl < 0 ? c.length : nl;
          const l = c.slice(p, end);
          p = nl < 0 ? c.length : nl + 1;
          if ((h.dash ? l.replace(/^\t+/, '') : l) === h.word) break;
        }
        heredocs.push({ from, to: p, literal: h.literal, program: !h.data });
      }
      pending = [];
      i = p - 1;
      lineStart = p;
    } else if (ch === '\n') lineStart = i + 1;
    else if (ch === '`') ticks++;
    else groups.step(c, i);
  }
  return { quotes, heredocs };
}

/** The command as its own shell runs it, for the whole-line checks. `bodiless`: heredoc bodies blanked. `skel` also
 *  blanks quoted text with a space in it and unquotes a one-word quote (`'sh'`, `"eval"`, `h\ash` stay those words). */
function skeleton(s: Scan): Skel {
  const c = s.c, { quotes, heredocs } = layout(s, { sink: () => false });
  const bodies = heredocs.map((h) => ({ from: h.from, to: h.to, put: '\n' }));
  const cuts = [...quotes.map((q) => ({ from: q.start, to: q.end, put: /\s/.test(c.slice(q.start, q.end)) ? ' ' : c.slice(q.start, q.end).replace(/^\$?['"]|['"]$/g, '') })), ...bodies];
  const apply = (xs: typeof bodies) => { let out = '', at = 0; for (const x of xs.sort((a, b) => a.from - b.from)) { out += c.slice(at, x.from) + x.put; at = x.to; } return out + c.slice(at); };
  return { skel: apply(cuts).replace(/\\/g, ''), bodiless: apply(bodies) };
}
export const commandSkeleton = (c: string): Skel => skeleton(new Scan(c));
/** Picks the quoted spans that are data, given the command's tests and skeleton. `rerun` (optional) picks the spans
 *  whose text something on the line may run again: their text is read as a command line of its own, at the end. */
type Blank = ((c: string, tests: ReturnType<typeof commandTests>, sk: Skel) => (q: Quoted) => boolean) & { rerun?: (c: string, tests: ReturnType<typeof commandTests>, sk: Skel) => (q: Quoted) => boolean };
/** The command with data taken out: a heredoc body nobody runs (its end line too), keeping the $(…) and `…` of an
 *  unquoted-delimiter body as lines, and each quoted span `blank` picks, as '' plus the substitutions a "…" span runs. */
function withoutData(c: string, blank: Blank): string {
  if (!/['"<]/.test(c)) return c;
  const s = new Scan(c), sk = skeleton(s), tests = commandTests(s, wholeFlags(c, sk)), { quotes, heredocs } = layout(s, tests), picks = blank(c, tests, sk);
  const cuts = [...quotes.filter(picks).map((q) => ({ from: q.start, to: q.end, put: "''" + q.subs.map((x) => ` $(${x})`).join('') })),
    ...heredocs.filter((h) => !h.program).map((h) => ({ from: h.from, to: h.to, put: h.literal ? '' : s.substitutions(h.from, h.to).map((x) => x + '\n').join('') }))]
    .sort((a, b) => a.from - b.from);
  const again = blank.rerun ? quotes.filter(blank.rerun(c, tests, sk)).map((q) => '\n' + c.slice(q.start + 1, q.end - 1).replace(/\\(["\\$`])/g, '$1')).join('') : '';
  if (!cuts.length) return c + again;
  let out = '', at = 0;
  for (const x of cuts) { out += c.slice(at, x.from) + x.put; at = x.to; }
  return out + c.slice(at) + again;
}

const spaced = (c: string) => (q: Quoted) => /\s/.test(c.slice(q.start, q.end));
/** The glob readings' start: data out, and every quoted span with whitespace in it is data (a commit message's `* one`
 *  bullet, a JSDoc ` * ` line, a regex's `(a|b)`). -c payloads and eval's words are read on their own by the guard.
 *  A quoted single word stays: `'g?t' push` is read as a glob. */
const words = (c: string): string => withoutData(c, spaced);
/** A message value: `-m`, `-am`, `--message`, `--body`, `--title` or `--notes` right before the quoted span. */
const MESSAGE_FLAG = /(?:^|\s)(?:-[a-zA-Z]*m|--message|--body|--title|--notes)(?:=|[ \t]+)$/;
const before = (c: string, q: Quoted) => c.slice(Math.max(0, q.start - 16), q.start);
/** The text rules' reading: data heredoc bodies out, and a plain quoted message value with whitespace in it is data
 *  (`git commit -m 'why (git push -f) is bad'`). Plain means no $(…) or backtick in it, no editor flag or pipe on its command,
 *  and nothing in the command line that can run it again (reruns, `$_`, redefines, an editor or pager setting). */
const safeLine = (c: string, sk: Skel) => !reruns(sk.bodiless) && !LAST_ARG.test(c) && !redefines(sk.skel, sk.bodiless) && !EDITOR_SET.test(sk.skel);
const messageSpan = (c: string) => { const sp = spaced(c); return (q: Quoted) => !q.subs.length && sp(q) && MESSAGE_FLAG.test(before(c, q)); };
type Tests = ReturnType<typeof commandTests>;
const edited = (tests: Tests, q: Quoted) => tests.rerunAt(q.line ?? 0, q.start);
const messages: Blank = Object.assign((c: string, tests: Tests, sk: Skel) => {
  const safe = safeLine(c, sk), msg = messageSpan(c);
  return (q: Quoted) => safe && msg(q) && !edited(tests, q);
}, {
  // A plain message that something on the line may run (eval, a shell, `$_`, an editor) is read as commands too, even
  // where its quote would hide a rule: `eval git commit -m "x; git push -f"`.
  rerun: (c: string, tests: Tests, sk: Skel) => {
    const safe = safeLine(c, sk), msg = messageSpan(c);
    return (q: Quoted) => msg(q) && (!safe || edited(tests, q));
  },
});
export const textRulesView = (c: string): string => withoutData(c, messages);
/** A test for one line: true when `<<` at `at` sits in arithmetic (`$((1<<E))`), which the heredoc reader skips. One scan
 *  per line, and `at` must grow from call to call, so a line of many `<<` is linear. A line too deep to scan counts as
 *  arithmetic everywhere: its bodies stay in place, which is only stricter. */
export function arithmeticTest(line: string): (at: number) => boolean {
  const s = new Scan(line), opens: number[] = [], ends: number[] = [];
  let scanned = 0, k = 0, deep = false;
  return (at) => {
    for (; !deep && scanned < at; scanned++) {
      const i = scanned;
      if (!((line[i] === '$' && line[i + 1] === '(' && line[i + 2] === '(') || (line[i] === '(' && line[i + 1] === '('))) continue;
      try { ends.push(s.closeParen(i + (line[i] === '$' ? 3 : 2), 2)); } catch (err) { if (!(err instanceof ScanBudget)) throw err; deep = true; break; }
      opens.push(i);
      scanned = ends[ends.length - 1] - 1;
    }
    while (k < ends.length && ends[k] <= at) k++;
    return deep || (k < ends.length && opens[k] < at);
  };
}

/** The offsets of each segment's command word, as commandStart reads it. Alternation groups are masked first, so their
 *  `(`, `|` and `)` split nothing. */
function commandWordStarts(masked: string): Set<number> {
  const starts = new Set<number>();
  const seg = (a: string, from: number) => {
    const toks = [...a.matchAll(/[^ \t]+/g)];
    const k = commandStart(toks.map((t) => t[0]));
    if (toks[k]) starts.add(from + toks[k].index!);
  };
  let at = 0;
  for (const m of masked.matchAll(new RegExp(SEGMENTS.source, 'g'))) { seg(masked.slice(at, m.index), at); at = m.index! + m[0].length; }
  seg(masked.slice(at), at);
  return starts;
}

/** The first alternation group in a command word (only there can it pick the command), or null. */
function commandGroup(c: string): RegExpMatchArray | null {
  const groups = [...c.matchAll(ZSH_ALT)];
  if (!groups.length) return null;
  const masked = c.replace(ZSH_ALT, (g) => '_'.repeat(g.length));
  const starts = commandWordStarts(masked);
  let ws = -1, we = -1;
  for (const g of groups) {
    if (g.index! >= we) { // a new word: find its bounds once
      ws = g.index!;
      while (ws > 0 && !/[\s;&|()`]/.test(masked[ws - 1])) ws--;
      we = g.index!;
      while (we < masked.length && !/[\s;&|()`]/.test(masked[we])) we++;
    }
    if (starts.has(ws)) return g;
  }
  return null;
}

/** Each alternative of the first command-word (a|b) group, recursively. True when a bound is hit. */
function alternations(c: string, out: string[], b: Budget): boolean {
  const m = commandGroup(c);
  if (!m) return false;
  for (const alt of m[1].split('|')) {
    const t = c.slice(0, m.index) + alt + c.slice(m.index! + m[0].length);
    if (out.length >= MAX_SEGMENT_READINGS || !b.add(t)) return true;
    out.push(t);
    if (alternations(t, out, b)) return true;
  }
  return false;
}

/** Readings of one segment: its command-position glob word (g?t, gi[t], *it, /usr/bin/g?t, dist/cl?.mjs) as each ruled
 *  name it can match, its directory kept, then again for the word that becomes the command (s?do g?t). True when capped. */
function segmentReadings(seg: string, out: string[]): boolean {
  const ws = seg.split(/([ \t]+)/); // a capturing split: words at even indices, the spaces between them at odd ones
  const at = ws.flatMap((w, i) => (i % 2 === 0 && w ? [i] : []));
  const j = at[commandStart(at.map((i) => ws[i]))];
  if (j === undefined) return false;
  const tok = ws[j], last = tok.split(/[\\/]/).pop()!;
  // ponytail: quotes are dropped, so a quoted 'g?t' (literal to the shell) is read as a glob too; stricter, never looser.
  const base = last.replace(/['"]/g, '').replace(/\[!/g, '[^'); // picomatch reads only [^x] as a negated class
  if (!GLOB.test(base)) return false;
  const m = picomatch(base, { nocase: true }); // macOS and Windows file systems ignore case
  for (const n of RULED.filter((x) => m(x))) {
    const t = [...ws.slice(0, j), tok.slice(0, tok.length - last.length) + n, ...ws.slice(j + 1)].join('');
    if (out.length >= MAX_SEGMENT_READINGS || out.length * t.length > MAX_READING_CHARS) return true;
    out.push(t);
    if (segmentReadings(t, out)) return true;
  }
  return false;
}

/**
 * Readings where command-position globs and zsh alternations are what the shell may expand them to. Bash expands a glob
 * against cwd before the command lookup, so `g?t` runs git when a file named git is there. Matched on the ruled names
 * only, never the disk. Every glob at once while that stays small (`c?rl x | s?` needs both), else each segment's
 * readings on their own, so a run of harmless globs cannot push a dangerous one past the cap. `capped` means a bound
 * was hit, and the guard asks.
 */
export function globReadings(command: string): GlobReadings {
  const text = words(command);
  if (!GLOB.test(text) && !text.includes('(')) return { texts: [], capped: false };
  const b = new Budget(text);
  const alts = [text];
  let capped = alternations(text, alts, b);
  for (const a of alts) {
    if (capped) break;
    if (!GLOB.test(a)) continue;
    const parts = a.split((segmentSplit ??= new RegExp(`(${SEGMENTS.source})`))); // separators at odd indices
    const per = parts.map((p, i) => {
      const out: string[] = [];
      if (i % 2 === 0 && segmentReadings(p, out)) capped = true;
      return out;
    });
    const product = per.reduce((n, v) => n * (v.length + 1), 1) - 1;
    if (product <= MAX_COMBINED && b.fits(product, a.length)) {
      let combos = [parts];
      per.forEach((v, i) => { combos = combos.flatMap((c) => [c, ...v.map((x) => c.map((p, k) => (k === i ? x : p)))]); });
      for (const c of combos.slice(1)) b.add(c.join('')); // combos[0] is the text itself
    } else {
      capped = true; // one segment at a time misses a pair across a pipe (c?rl x | s?), so the guard asks at least
      for (const x of per.flat()) if (!b.add(x.trim())) break;
    }
  }
  return { texts: [...b.seen], capped };
}

/** A substitution glued inside a word (git pu``sh -f, pu$(true)sh) builds the word at run time: the command without it. */
const SPLICE = /(?<=[\w./-])(?:`[^`]*`|\$\([^()]*\))|(?:`[^`]*`|\$\([^()]*\))(?=[\w./-])/g;
export const splicedReading = (c: string): string | null => {
  const w = words(c);
  const s = w.replace(SPLICE, '');
  return s === w ? null : s;
};

/** A git global option's value: a quoted string (spaces and all) or a word. */
const V = `(?:'[^']*'|"(?:[^"\\\\]|\\\\.)*"|\\S+)`;
/** git's global options and their values (-C dir, -c k=v, --git-dir[=]x, --no-pager…), so `git -C . push -f` reads as `git push -f`. */
const GIT_GLOBALS = new RegExp(`\\bgit(?:[ \\t]+(?:-[Cc][ \\t]+${V}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)(?:=${V}|[ \\t]+${V})|--?[\\w-]+(?:=${V})?))+(?=[ \\t])`, 'g');
/** The git reading of the text rules: a separator inside quotes is a literal argument (`git push origin 'a;b' main`),
 *  quotes are off as in quoteFree, and git's global options are dropped. */
export const gitPlain = (c: string): string =>
  quoteFree(c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[;&|\n]/g, '_'))).replace(GIT_GLOBALS, 'git');
