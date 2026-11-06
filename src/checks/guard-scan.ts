// The guard's quote and substitution scanner: where "…", '…', $'…', $(…) and `…` end, as the shell reads them.
// Each span's end is found once and remembered, so nested "$(…" spans cost linear time, not 2^depth (re-review 3, N4).

/** Nesting of "…" and $(…) the scanner follows. Deeper, it gives up and the guard asks. */
export const MAX_SCAN_DEPTH = 256;
/** Scan steps per character of the command. The scan is linear, so this only backstops a bug; past it the guard asks. */
export const SCAN_STEPS_PER_CHAR = 8;
/** Steps every scan may take whatever its length, so a short command never runs out. */
const SCAN_STEPS_BASE = 1024;

/** Thrown when a scan hits MAX_SCAN_DEPTH or its step budget: the guard cannot read the command, so it asks. */
export class ScanBudget extends Error {}
export const SCAN_BUDGET_WHY = `the command nests quotes and substitutions deeper than the guard reads (${MAX_SCAN_DEPTH} nested spans), so it cannot tell what runs`;

/** One scan of one command. Ends are cached by the offset where the span's body starts. */
export class Scan {
  private readonly parens = new Map<number, number>();
  private readonly dquotes = new Map<number, number>();
  private depth = 0;
  private steps = 0;
  private readonly limit: number;
  constructor(readonly c: string) { this.limit = SCAN_STEPS_BASE + SCAN_STEPS_PER_CHAR * c.length; }

  private step(): void { if (++this.steps > this.limit) throw new ScanBudget('scan step budget'); }
  private enter(): void { if (++this.depth > MAX_SCAN_DEPTH) throw new ScanBudget('scan depth'); }

  /** Index just past the `)` that closes a `$(` or `(` whose body starts at `k`, skipping quotes, backticks and escapes. */
  closeParen(k: number, depth = 1): number {
    const cached = depth === 1, hit = cached ? this.parens.get(k) : undefined; // only a $( or ( body is cached, not (( arithmetic
    if (hit !== undefined) return hit;
    this.enter();
    const c = this.c, from = k;
    let end = c.length;
    for (; k < c.length; k++) {
      this.step();
      const ch = c[k];
      if (ch === '\\') k++;
      else if (ch === '$' && c[k + 1] === "'") k = this.closeAnsiC(k + 2) - 1;
      else if (ch === "'") { const e = c.indexOf("'", k + 1); k = e < 0 ? c.length : e; }
      else if (ch === '"') k = this.closeDouble(k) - 1;
      else if (ch === '`') k = this.closeTick(k + 1) - 1;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) { end = k + 1; break; }
    }
    this.depth--;
    if (cached) this.parens.set(from, end);
    return end;
  }

  /** Index just past the backtick that closes one opened at `k - 1`. */
  closeTick(k: number): number {
    const c = this.c;
    for (; k < c.length; k++) {
      this.step();
      if (c[k] === '\\') k++;
      else if (c[k] === '`') return k + 1;
    }
    return c.length;
  }

  /** Index just past the `'` that closes a `$'` whose body starts at `k`: `\` escapes inside, `\'` too. */
  closeAnsiC(k: number): number {
    const c = this.c;
    for (; k < c.length; k++) {
      this.step();
      if (c[k] === '\\') k++;
      else if (c[k] === "'") return k + 1;
    }
    return c.length;
  }

  /** Index just past a "…" span opened at `i`: `\` escapes, and $(…) and `…` run inside. */
  closeDouble(i: number): number {
    const hit = this.dquotes.get(i);
    if (hit !== undefined) return hit;
    this.enter();
    const c = this.c;
    let k = i + 1;
    for (; k < c.length && c[k] !== '"'; k++) {
      this.step();
      if (c[k] === '\\') k++;
      else if (c[k] === '$' && c[k + 1] === '(') k = this.closeParen(k + 2) - 1;
      else if (c[k] === '`') k = this.closeTick(k + 1) - 1;
    }
    this.depth--;
    const end = Math.min(k + 1, c.length);
    this.dquotes.set(i, end);
    return end;
  }

  /** The $(…) and `…` the shell runs in `c[from, to)`, as command lines (a "…" span or an unquoted-delimiter heredoc body). */
  substitutions(from: number, to: number): string[] {
    const c = this.c, subs: string[] = [];
    for (let k = from; k < to; k++) {
      this.step();
      if (c[k] === '\\') k++;
      else if (c[k] === '$' && c[k + 1] === '(' && c[k + 2] !== '(') { const e = Math.min(this.closeParen(k + 2), to); subs.push(c.slice(k + 2, e - 1)); k = e - 1; }
      else if (c[k] === '`') { const e = Math.min(this.closeTick(k + 1), to); subs.push(c.slice(k + 1, e - 1)); k = e - 1; }
    }
    return subs;
  }
}

/** A quoted span: offsets into the command, `end` exclusive. `subs`: the $(…) and `…` the shell runs inside "…". */
/** `line`: where its logical line starts. */
export interface Quoted { start: number; end: number; subs: string[]; line?: number }

/** The quoted span that opens at `i` ($'…', '…' or "…" with its substitutions), or null. */
export function quotedAt(s: Scan, i: number): Quoted | null {
  const c = s.c;
  if (c[i] === '$' && c[i + 1] === "'") return { start: i, end: s.closeAnsiC(i + 2), subs: [] };
  if (c[i] === "'") { const e = c.indexOf("'", i + 1); return { start: i, end: e < 0 ? c.length : e + 1, subs: [] }; }
  if (c[i] !== '"') return null;
  const end = s.closeDouble(i);
  return { start: i, end, subs: s.substitutions(i + 1, end - 1) };
}

/** Compound commands, counted as groups: a writer inside one is code, since `fi | sh` reads what it prints. */
const OPENS = new Set(['if', 'for', 'while', 'until', 'select', 'case']), CLOSES = new Set(['fi', 'done', 'esac']);
/** A keyword's place: a command start, after a separator or another keyword (`then if`, `do while`). */
const KEYWORD_PLACE = /(?:^|[\n;&|(){}]|\b(?:then|do|else|elif|time)|!)[ \t]*$/;
/** The groups open at a point: `(`, a `{` word and the compound keywords, as a stack, so a `case` pattern's `)` closes
 *  nothing. A closer with nothing open to match breaks the count for good: past it every writer is code. */
export class Groups {
  private readonly open: string[] = [];
  private broken = false;
  get depth(): number { return this.open.length + (this.broken ? 1 : 0); }
  step(c: string, i: number): void {
    const ch = c[i];
    if (ch === '(') this.open.push('(');
    else if (ch === ')') { if (this.open.at(-1) !== 'case') this.close('('); } // `x)` in a case is a pattern
    else if (i > 0 && !/[\s;&|(){}]/.test(c[i - 1])) return; // not a word start
    else if ((ch === '{' || ch === '}') && /\s/.test(c[i + 1] ?? ' ')) { if (ch === '{') this.open.push('{'); else this.close('{'); }
    else {
      const w = /^[a-z]+/.exec(c.slice(i, i + 7))?.[0];
      if (!w || (!OPENS.has(w) && !CLOSES.has(w)) || /[\w-]/.test(c[i + w.length] ?? ' ') || !KEYWORD_PLACE.test(c.slice(Math.max(0, i - 12), i))) return;
      if (OPENS.has(w)) this.open.push(w === 'case' ? 'case' : 'kw');
      else this.close(w === 'esac' ? 'case' : 'kw');
    }
  }
  private close(kind: string): void { if (this.open.at(-1) === kind) this.open.pop(); else this.broken = true; }
}
