// Extra readings of a Bash command for the guard's text rules: what the shell can turn a word into before it runs.
// Imported by guard.ts, which this module imports back: use guard.ts names only inside functions, never at load time.
import picomatch from 'picomatch';
import { commandStart, quoteFree, SEGMENTS } from './guard.js';

/** Command names the text rules and checks look for. A command-position glob that can match one is read as it. */
const RULED = ['git', 'gh', 'curl', 'wget', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'chmod', 'dd', 'rm', 'sudo', 'eval', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv',
  'cdk', 'terraform', 'aws', 'kubectl', 'docker', 'vercel', 'harness', 'cli.mjs', 'cli.js'];
/** Readings of one segment (a glob, then a glob after the wrapper it became, …) or of one zsh alternation. */
const MAX_SEGMENT_READINGS = 32;
/** All segments' readings combined (every glob at once) while the product stays this small. */
const MAX_COMBINED = 64;
/** Readings in all. Past this the guard asks: it cannot say the command is safe. */
export const MAX_READINGS = 2048;
const GLOB = /[*?[]/;
/** zsh's default glob alternation inside a word: g(i|x)t. Bash rejects it, so reading it is only stricter. */
const ZSH_ALT = /(?<=[\w./*?\]-])\(([^()\s]*\|[^()\s]*)\)/;
let segmentSplit: RegExp | undefined; // built on first use, see the import note

export interface GlobReadings { texts: string[]; capped: boolean }

/** Each alternative of the first (a|b) group, recursively. */
function alternations(c: string, out: string[]): boolean {
  const m = ZSH_ALT.exec(c);
  if (!m) return false;
  for (const alt of m[1].split('|')) {
    if (out.length >= MAX_SEGMENT_READINGS) return true;
    const t = c.slice(0, m.index) + alt + c.slice(m.index + m[0].length);
    out.push(t);
    if (alternations(t, out)) return true;
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
    if (out.length >= MAX_SEGMENT_READINGS) return true;
    const t = [...ws.slice(0, j), tok.slice(0, tok.length - last.length) + n, ...ws.slice(j + 1)].join('');
    out.push(t);
    if (segmentReadings(t, out)) return true;
  }
  return false;
}

/**
 * Readings where command-position globs and zsh alternations are what the shell may expand them to. Bash expands a glob
 * against cwd before the command lookup, so `g?t` runs git when a file named git is there. Matched on the ruled names
 * only, never the disk. Every glob at once while that stays small (`c?rl x | s?` needs both), else each segment's
 * readings on their own, so a run of harmless globs cannot push a dangerous one past the cap.
 */
export function globReadings(command: string): GlobReadings {
  if (!GLOB.test(command) && !ZSH_ALT.test(command)) return { texts: [], capped: false };
  const alts = [command];
  let capped = alternations(command, alts);
  const texts = alts.slice(1);
  for (const a of alts) {
    if (!GLOB.test(a)) continue;
    const parts = a.split((segmentSplit ??= new RegExp(`(${SEGMENTS.source})`))); // separators at odd indices
    const per = parts.map((p, i) => {
      const out: string[] = [];
      if (i % 2 === 0 && segmentReadings(p, out)) capped = true;
      return out;
    });
    if (per.reduce((n, v) => n * (v.length + 1), 1) - 1 <= MAX_COMBINED) {
      let combos = [parts];
      per.forEach((v, i) => { combos = combos.flatMap((c) => [c, ...v.map((x) => c.map((p, k) => (k === i ? x : p)))]); });
      texts.push(...combos.slice(1).map((c) => c.join(''))); // combos[0] is the command itself
    } else {
      capped = true; // one segment at a time misses a pair across a pipe (c?rl x | s?), so the guard asks at least
      for (const x of per.flat()) {
        if (texts.length >= MAX_READINGS) return { texts, capped };
        texts.push(x.trim());
      }
    }
    if (texts.length > MAX_READINGS) return { texts: texts.slice(0, MAX_READINGS), capped: true };
  }
  return { texts, capped };
}

/** A substitution glued inside a word (git pu``sh -f, pu$(true)sh) builds the word at run time: the command without it. */
const SPLICE = /(?<=[\w./-])(?:`[^`]*`|\$\([^()]*\))|(?:`[^`]*`|\$\([^()]*\))(?=[\w./-])/g;
export const splicedReading = (c: string): string | null => {
  const s = c.replace(SPLICE, '');
  return s === c ? null : s;
};

/** A git global option's value: a quoted string (spaces and all) or a word. */
const V = `(?:'[^']*'|"(?:[^"\\\\]|\\\\.)*"|\\S+)`;
/** git's global options and their values (-C dir, -c k=v, --git-dir[=]x, --no-pager…), so `git -C . push -f` reads as `git push -f`. */
const GIT_GLOBALS = new RegExp(`\\bgit(?:[ \\t]+(?:-[Cc][ \\t]+${V}|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)(?:=${V}|[ \\t]+${V})|--?[\\w-]+(?:=${V})?))+(?=[ \\t])`, 'g');
/** The git reading of the text rules: a separator inside quotes is a literal argument (`git push origin 'a;b' main`),
 *  quotes are off as in quoteFree, and git's global options are dropped. */
export const gitPlain = (c: string): string =>
  quoteFree(c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => q.replace(/[;&|\n]/g, '_'))).replace(GIT_GLOBALS, 'git');
