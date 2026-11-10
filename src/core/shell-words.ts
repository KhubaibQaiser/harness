// A small, quote-aware reading of a shell command line, shared by the guard and protect. A seatbelt, not a parser:
// no expansions. Quoting: '…', "…" (only \" \\ \$ \` escape), $'…' (\' and \\ escape), and \x outside quotes.
// When the quoting doesn't balance, callers check more, not less (see `balanced`).
// ponytail: POSIX quoting only; PowerShell rules are not modelled.

type Piece = { text: string; sep: string };

/** Characters of command text one guard or protect run may split into pieces. Every reading at every nesting level
 *  is split here, so this bounds the whole run's work (re-review 21, P1b): 100 KB read 40 times over. The most a plain
 *  input took when measured was 2.9 M (a 99 KB shell body); four nested shell bodies of 90 KB take 16 to 20 M. */
export const WORK_BUDGET_CHARS = 4_000_000;
/** Thrown when a run spends WORK_BUDGET_CHARS: the check cannot read the command in time, so the hook denies. */
export class WorkBudget extends Error {}
export const WORK_BUDGET_WHY = 'the command is too large or too deeply nested for harness to read before the hook times out, so it is denied; split it into smaller commands';
let work = -1; // characters charged in the open run, or -1 outside one
/** Runs `fn` as one run with a fresh budget; a run inside a run shares the outer one. */
export function withWorkBudget<T>(fn: () => T): T {
  if (work >= 0) return fn();
  work = 0;
  try {
    return fn();
  } finally {
    work = -1;
  }
}
/** The characters charged so far in the open run (for tests). */
export const workSpent = (): number => work;
/** Charges `n` characters of work to the open run (a no-op outside one); past the budget it throws WorkBudget. */
const charge = (n: number): void => { if (work >= 0 && (work += n) > WORK_BUDGET_CHARS) throw new WorkBudget(WORK_BUDGET_WHY); };
/**
 * `fn` (pure, on one string) with its last few results kept, one set per `variant()` value (module state the result
 * depends on). A repeat returns the kept result and charges the work the first call did, so a run spends and stops on
 * the budget exactly where it did without the cache (round 28: one decision asks the same question of the same text
 * several times). A result computed outside a run has no known cost and is computed again inside one. Results are
 * shared: callers must not mutate them.
 */
export function remember<R>(fn: (a: string) => R, variant: () => number = () => 0, size = 4): (a: string) => R {
  const sets: Map<string, { r: R; cost: number }>[] = [];
  return (a) => {
    const kept = (sets[variant()] ??= new Map());
    const hit = kept.get(a);
    if (hit && (hit.cost >= 0 || work < 0)) { if (hit.cost > 0) charge(hit.cost); return hit.r; }
    const w0 = work, r = fn(a);
    if (kept.size >= size) kept.delete(kept.keys().next().value!);
    kept.set(a, { r, cost: w0 >= 0 && work >= w0 ? work - w0 : -1 });
    return r;
  };
}

/** The command split at ; & | && || newlines, parentheses and backticks outside quotes, with the separator after each. */
export function pieces(cmd: string): Piece[] {
  charge(cmd.length);
  const out: Piece[] = [];
  let from = 0; // the piece so far is cmd.slice(from, i): offsets, not a string built a char at a time (re-review 22b, F4)
  let quote = ''; // ', ", or $ for $'…'
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && (quote === '"' || quote === '$') && i + 1 < cmd.length) i++;
      else if (c === (quote === '$' ? "'" : quote)) quote = '';
    } else if (c === '\\' && i + 1 < cmd.length) i++;
    else if (c === '$' && cmd[i + 1] === "'") (quote = '$'), i++;
    else if (c === '"' || c === "'") quote = c;
    else if (/[;&|\n()`]/.test(c)) {
      // 2>&1, >&2 and &> are redirections, not separators.
      if (c === '&' && ((i > from && (cmd[i - 1] === '>' || cmd[i - 1] === '<')) || cmd[i + 1] === '>')) continue;
      const text = cmd.slice(from, i);
      const sep = (c === '|' || c === '&') && cmd[i + 1] === c ? c + cmd[++i] : c;
      out.push({ text, sep });
      from = i + 1;
    }
  }
  out.push({ text: cmd.slice(from), sep: '' });
  return out.map((p) => ({ ...p, text: p.text.trim() })).filter((p) => p.text);
}
export const segments = (cmd: string): string[] => pieces(cmd).map((p) => p.text);

/** False when a quote is left open: the reader may then have split the command wrongly. */
export function balanced(cmd: string): boolean {
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && (quote === '"' || quote === '$')) i++;
      else if (c === (quote === '$' ? "'" : quote)) quote = '';
    } else if (c === '\\') i++;
    else if (c === '$' && cmd[i + 1] === "'") (quote = '$'), i++;
    else if (c === '"' || c === "'") quote = c;
  }
  return !quote;
}

/** The words of one segment, quotes kept (a word may join quoted and unquoted parts, as in --eval="x"). */
export const words = (seg: string): string[] => seg.match(/(?:\$'(?:\\.|[^'\\])*'?|"(?:\\.|[^"\\])*"?|'[^']*'?|\\.|[^\s"'\\])+/g) ?? [];

const ANSI: Record<string, string> = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '\\': '\\' };
/** A word as the shell passes it on: quotes removed; in double quotes only \" \\ \$ \` are escapes. */
export function unquote(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '$' && word[i + 1] === "'") {
      for (i += 2; i < word.length && word[i] !== "'"; i++) out += word[i] === '\\' && i + 1 < word.length ? (ANSI[word[++i]] ?? word[i]) : word[i];
    } else if (c === "'") {
      const end = word.indexOf("'", i + 1);
      out += word.slice(i + 1, end < 0 ? word.length : end);
      i = end < 0 ? word.length : end;
    } else if (c === '"') {
      for (i++; i < word.length && word[i] !== '"'; i++) {
        if (word[i] === '\\' && /["\\$`]/.test(word[i + 1] ?? '')) i++;
        out += word[i];
      }
    } else if (c === '\\' && i + 1 < word.length) out += word[++i];
    else out += c;
  }
  return out;
}

export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'script']);
/** A word's command name: its last path segment, lower case, without a Windows extension or an @version (node@22). */
const NAME_PLAIN = /^[a-z0-9_-]*$/; // a word every name rule leaves as it is
export const commandName = (word: string): string => (NAME_PLAIN.test(word) ? word : commandNameOf(word)); // most words are plain
const commandNameOf = (word: string): string =>
  word.replace(/["']/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, '').replace(/^([^@]+)@.*$/, '$1'); // backslashes are separators here

/** GNU env -S escapes: `\_` is a space inside double quotes (a separator outside), and the C escapes. */
const ENV_ESC: Record<string, string> = { _: ' ', n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' };
/**
 * An `env -S` string as env splits it: whitespace separates words; '…' and "…" group (backslash escapes inside "…"
 * and outside quotes); `(`, `;` and the like are ordinary characters. Returned as a command line whose words are
 * single-quoted, so the shell-rule reader keeps them whole.
 */
export function envSplit(str: string): string {
  const out: string[] = [];
  let cur: string | null = null;
  let quote = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote === "'") { if (c === "'") quote = ''; else if (c === '\\' && /['\\]/.test(str[i + 1] ?? '')) cur += str[++i]; else cur += c; continue; }
    if (quote === '"') { if (c === '"') quote = ''; else if (c === '\\' && i + 1 < str.length) cur += ENV_ESC[str[++i]] ?? str[i]; else cur += c; continue; }
    if (/\s/.test(c) || (c === '\\' && str[i + 1] === '_')) { // an unquoted \_ separates words, as a space does
      if (c === '\\') i++;
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur ??= '';
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\' && i + 1 < str.length) cur += ENV_ESC[str[++i]] ?? str[i];
    else cur += c;
  }
  if (cur !== null) out.push(cur);
  return out.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(' ');
}

// Shell options whose value is the next word: bash -o pipefail, -O extglob, +o history, --rcfile F, --init-file F.
const SHELL_VALUE = /^(?:[-+][oO]|--rcfile|--init-file)$/;
/** The commands that `sh -c`, `bash -c`, `script -c` (and the like) and `env -S` run, unquoted, wherever they appear. */
export const cPayloads = remember(cPayloadsOf);
function cPayloadsOf(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of segments(cmd)) {
    const ws = words(seg);
    for (let i = 0; i < ws.length; i++) {
      const name = commandName(ws[i]);
      if (name === 'env') {
        for (let j = i + 1; j < ws.length && unquote(ws[j]).startsWith('-'); j++) { // env "-S" is still -S
          const w = unquote(ws[j]);
          // GNU env's options whose value is the next word: -u/--unset NAME, -C/--chdir DIR, -a/--argv0 ARG (also at
          // the end of a cluster, -iu NAME). The signal options take their value attached (--block-signal=SIG).
          if (/^-[a-zA-Z0]*[uCa]$/.test(w) || ['--unset', '--chdir', '--argv0'].includes(w)) { j++; continue; }
          // -S, also at the end of a short-option cluster (-iS, -vS), with the string as the next word or attached.
          if (/^-[a-zA-Z0]*S$/.test(w) || w === '--split-string') { if (ws[j + 1] !== undefined) out.push(envSplit(unquote(ws[j + 1]))); break; }
          if (w.startsWith('--split-string=')) { out.push(envSplit(w.slice(15))); break; }
          const attached = /^-[a-zA-RT-Z0]*S(.+)$/.exec(w);
          if (attached) { out.push(envSplit(attached[1])); break; }
        }
      }
      if (!SHELLS.has(name)) continue;
      // A shell's payload is its first non-option word after -c (sh -c -x CMD, bash -c -o pipefail CMD); script's -c
      // takes the next word, whatever it is.
      let c = false, ended = false;
      for (let j = i + 1; j < ws.length; j++) {
        const w = unquote(ws[j]); // a quoted or escaped option is still an option: bash "-c" -m CMD, sh -c \\-x CMD
        if (c && !ended && (w === '--' || w === '-')) { ended = true; continue; } // bash -c -- CMD
        if (c && (ended || name === 'script' || !/^[-+]/.test(w))) { out.push(w); break; }
        if (SHELL_VALUE.test(w)) { j++; continue; }
        if (!/^[-+]/.test(w)) break;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w)) c = true;
      }
    }
  }
  return out;
}

/**
 * Text fed on stdin to a command, with that command's name: `echo …`/`printf …` piped into it, a `<<<` here-string,
 * or a here-document body. Only when the command reads its program from stdin (no script file, no -c/-e). `start`
 * finds where the command runs in a list of words (the caller's walk, stopping at shells and interpreters).
 */
/** `lines`, on a heredoc's program: the operator's line and the end line (lines.length when there is none). */
export function stdinPrograms(cmd: string, start: (ws: string[]) => number): { name: string; text: string; lines?: [number, number] }[] {
  const out: { name: string; text: string; lines?: [number, number] }[] = [];
  // Reads its program from stdin: only flags follow (bash -s, node -), none of them -c/-e/-p.
  const reads = (ws: string[], k: number) =>
    k < ws.length && ws.slice(k + 1).every((w) => w === '-' || /^\d*<<?-?/.test(w) || (/^-[a-zA-Z]*$/.test(w) && !/^-[a-zA-Z]*[cep]/.test(w)));
  const ps = pieces(cmd);
  for (let i = 0; i < ps.length; i++) {
    const ws = words(ps[i].text);
    const k = start(ws.map((w) => w.replace(/["']/g, '')));
    const name = commandName(ws[k] ?? '');
    // a | b: a literal echo/printf as the program of b
    if (ps[i].sep === '|' && ps[i + 1]) {
      const next = words(ps[i + 1].text);
      const nk = start(next.map((w) => w.replace(/["']/g, '')));
      const src = ws.map(unquote);
      if (reads(next.filter((w) => !/^\d*[<>]/.test(w)), nk) && (src[0] === 'echo' || src[0] === 'printf')) {
        const args = src.slice(1).filter((a, j) => !(src[0] === 'echo' && j === 0 && /^-[neE]+$/.test(a)));
        out.push({ name: commandName(next[nk]), text: (src[0] === 'printf' ? args[0] ?? '' : args.join(' ')).replace(/\\n/g, '\n') });
      }
    }
    // cmd <<< 'text'
    const h = ws.findIndex((w) => w.startsWith('<<<'));
    if (h >= 0 && reads(ws.slice(0, h), k)) out.push({ name, text: unquote(ws[h] === '<<<' ? ws[h + 1] ?? '' : ws[h].slice(3)) });
  }
  // cmd <<'EOF' … EOF (the body is not split into commands by the reader above)
  const lines = cmd.split('\n');
  // Where each possible end word stands, so finding a body's end is one step, not a search to the end (re-review 20, P1).
  let ends: Map<string, { at: number[]; next: number }> | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(lines[i]);
    if (!m || /<<</.test(lines[i])) continue;
    const before = words(lines[i].slice(0, m.index));
    const k = start(before.map((w) => w.replace(/["']/g, '')));
    if (!reads(before, k)) continue;
    if (!ends) {
      ends = new Map();
      lines.forEach((l, j) => { const t = l.trim(); if (/^[A-Za-z_]\w*$/.test(t)) (ends!.get(t) ?? ends!.set(t, { at: [], next: 0 }).get(t)!).at.push(j); });
    }
    const e = ends.get(m[2]);
    while (e && e.next < e.at.length && e.at[e.next] <= i) e.next++; // i only grows, so each list is walked once
    const end = e?.at[e.next] ?? lines.length;
    // The body is built only when read: callers keep shell and interpreter programs and drop the rest.
    let text: string | undefined;
    out.push({ name: commandName(before[k] ?? ''), get text() { return (text ??= lines.slice(i + 1, end).join('\n')); }, lines: [i, end] });
  }
  return out;
}
