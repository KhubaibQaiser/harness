import { isAnyTestFile } from '../core/paths.js';
import { bucketOf, type Acc, type Bucket, type SessionCtx } from './acc.js';
import type { ToolUse } from './transcript.js';
import type { Turn } from './turns.js';

// Judgement rules (spec §4.2): heuristics find "needs a look" windows. Never a score or a pass/fail (owner U-judgement, docs/research/2026-11-05-judge-fit.md).
// No window never means "followed". Quoted turns are untrusted: matched by regex only, never interpreted.
// Windows hold quotes, session ids and days: local HTML only. The export takes counts only (COUNT_FIELDS), never `windows` (owner Q9, spec §6.4).

export type WindowRule = 'ask-first' | 'no-invented-data' | 'fix-everything' | 'readme-per-pr' | 'paid-ok' | 'plain-communication' | 'tdd';
const RULES: WindowRule[] = ['ask-first', 'no-invented-data', 'fix-everything', 'readme-per-pr', 'paid-ok', 'plain-communication', 'tdd'];

/** Spec §4.2, verbatim. */
export const RX = {
  choice: /\b(option [a-c1-3]\b|alternatively|we could|i('ll| will) go with|i chose|i decided|decided to|instead of)\b/i,
  number: /\b\d[\d,.]*\s?(%|ms|s\b|kb|mb|gb|tokens?|x\b|\$)|\$\d/i,
  estimateLabel: /estimate|approx|~|about|unverified|roughly/i,
  findingsHead: /\b(found|issues?|findings?|problems?|bugs?)\b/i,
  listLine: /^\s*([-*]|\d+\.)\s/im,
  notFixed: /\b(not fixed|left as is|skipp(ed|ing)|follow[- ]up|later|out of scope|didn't fix)\b/i,
  paid: /\b(claude\s+(-p|--print|plugin\s+eval)|gh\s+workflow\s+run|git\s+push)\b/i,
  approval: /\b(yes|ok|okay|go ahead|approve[d]?|do it|push|run it)\b/i,
};

/** `control`: a quoted part holds a control or bidi character (raw here; the HTML escapes it). */
export interface Window { rule: WindowRule; session: string; date: string; turn: number; prompt: string; texts: string; tools: string[]; control?: true }
/** Rules that read main-thread records only (readme-per-pr: edits are main-thread); subagent work is counted in `notes.sideRecords`, not judged. */
export const MAIN_THREAD_ONLY: WindowRule[] = ['ask-first', 'fix-everything', 'no-invented-data', 'plain-communication', 'readme-per-pr'];

type Split = { turns: number; windows: number };
export interface WindowsResult {
  byRule: Record<WindowRule, { windows: Window[]; total: number; counters: Record<string, number>; byBucket: Record<Bucket, Split>; byCompact: { pre: Split; post: Split } }>;
  unknown: number;
  /** `sideRecords`/`sideBad`: subagent records (and bad lines among them) the main-thread-only rules can't place. `beforeFirstPrompt`: main records outside any turn. */
  notes: { sideRecords: number; sideBad: number; beforeFirstPrompt: number };
}
/** The only fields an export may take: per rule, and at the top. Allowlist; everything else (windows above all) stays local. */
export const COUNT_FIELDS = { rule: ['total', 'counters', 'byBucket', 'byCompact'], top: ['unknown', 'notes'] } as const;

const PART = 600; // spec §4.2 (estimate)
// ponytail: not in spec §4.2; bounds a hostile turn (thousands of numbers against 500 results of 64 KB). Counted as numbersSkipped and textsCut.
const LAST_CAP = 64 * 1024, NUMBERS_CAP = 20;
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// ponytail: fixed source extensions (misses Go, Rust...); the red-first gate's config `paths` aren't available here.
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/; // C0/C1 but tab, LF, CR; bidi; zero-width
const NUMBER_G = new RegExp(RX.number.source, 'gi');
const SENTENCE = /[.!?]+(?:\s|$)/g;
const COUNTERS: Record<WindowRule, string[]> = {
  'ask-first': ['asks', 'asksWith2Options', 'asksWithRecommendation'],
  'no-invented-data': ['numbers', 'numbersInResults', 'numbersLabelled', 'numbersSkipped', 'textsCut'],
  'fix-everything': ['findingsTurns', 'editsAfter'],
  'readme-per-pr': ['prCreates', 'prCreatesWithReadme'],
  'paid-ok': ['paidCommands', 'paidWithApproval'],
  'plain-communication': ['avg0-15', 'avg16-25', 'avg26-35', 'avg36+'],
  tdd: ['bothKinds'],
};

const bash = (t: ToolUse, re: RegExp) => t.name === 'Bash' && t.command !== undefined && re.test(t.command);
const changes = (t: ToolUse) => EDITS.has(t.name) || bash(t, /\bgit\s+commit\b/);
const hasFindings = (text: string) => {
  const lines = text.split('\n');
  return lines.some((l, i) => RX.findingsHead.test(l) && lines.slice(i + 1, i + 6).filter((x) => RX.listLine.test(x)).length >= 2);
};
const sentenceAt = (s: string, i: number) => {
  let start = 0, end = s.length;
  for (const m of s.matchAll(SENTENCE)) {
    if (m.index + m[0].length <= i) start = m.index + m[0].length;
    else if (m.index >= i) { end = m.index; break; }
  }
  return s.slice(start, end);
};
/** Words per sentence, after fenced code and list lines are dropped (plan decision). */
const sentenceWords = (s: string) =>
  s.replace(/```[\s\S]*?(```|$)/g, ' ').split('\n').filter((l) => !RX.listLine.test(l)).join('\n')
    .split(/[.!?]+(?:\s|$)/).map((x) => x.split(/\s+/).filter(Boolean).length).filter((n) => n > 0);

const toolLines = (t: Turn) => {
  const out: string[] = [];
  let used = 0;
  for (const x of t.tools) {
    const r = t.results.get(x.id) ?? t.subResults.get(x.id);
    const l = `${x.name} (${r === undefined ? 'no result' : r.isError ? 'error' : 'ok'})`.slice(0, PART);
    if (used + l.length > PART) break;
    used += l.length;
    out.push(l);
  }
  const more = t.tools.length + t.dropped.tools - out.length;
  return more > 0 ? [...out, `+${more} more`] : out;
};

/** `root`: the repo root; readme-per-pr resolves edits against it (a session may start in a subfolder). */
export function windowsAcc(opts: { tddGateOn: boolean; cap?: number; root: string }): Acc<WindowsResult> {
  const cap = opts.cap ?? 50;
  const split = () => ({ turns: 0, windows: 0 });
  const byRule = Object.fromEntries(RULES.map((r) => [r, {
    windows: [] as Window[], total: 0, counters: Object.fromEntries(COUNTERS[r].map((c) => [c, 0])),
    byBucket: { '1-10': split(), '11-30': split(), '31-100': split(), '100+': split() }, byCompact: { pre: split(), post: split() },
  }])) as WindowsResult['byRule'];
  type Kept = { w: Window; ts: number; seq: number };
  const kept = new Map<WindowRule, Kept[]>(RULES.map((r) => [r, []]));
  const notes = { sideRecords: 0, sideBad: 0, beforeFirstPrompt: 0 };
  let unknown = 0, seq = 0;
  // newest first: by the turn's prompt time, then by order seen; no time sorts oldest
  const time = (x: Kept) => (Number.isNaN(x.ts) ? -Infinity : x.ts);
  const newest = (a: Kept, b: Kept) => time(b) - time(a) || b.seq - a.seq;

  // per turn, from main-thread records in order (a Turn keeps texts and tools apart, so "an edit after the choice" needs the records)
  const fresh = () => ({ ts: NaN, bad: false, choice: false, findings: false, ask: false, editsAfter: 0, last: '', cut: 0, asks: 0, asks2: 0, asksRec: 0 });
  let cur = fresh();
  // per session
  let sessionUnknown = false, pr: { calls: number; w?: Window; t?: Turn; ts: number } = { calls: 0, ts: NaN };
  const root = opts.root.replace(/\\/g, '/').replace(/\/$/, '');

  const make = (rule: WindowRule, s: SessionCtx, t: Turn): Window => {
    const w: Window = { rule, session: s.id, date: t.date, turn: t.index, prompt: t.prompt.slice(0, PART), texts: t.texts.join('\n\n').slice(0, PART), tools: toolLines(t) };
    if ([w.prompt, w.texts, ...w.tools].some((p) => CONTROL.test(p))) w.control = true;
    return w;
  };
  const open = (rule: WindowRule, s: SessionCtx, t: Turn, ts: number, w = make(rule, s, t)) => {
    const o = byRule[rule];
    o.total++; // counts past the cap too: total - windows.length is the overflow
    o.byBucket[bucketOf(t.index)].windows++;
    o.byCompact[t.afterCompact ? 'post' : 'pre'].windows++;
    const k = kept.get(rule)!;
    k.push({ w, ts, seq: seq++ });
    if (k.length > cap) k.sort(newest).splice(cap);
  };

  return {
    rec(s, r) {
      // subagent records reach rec after the main thread, so they can't be placed in a turn here: counted, not judged
      if (r.side) return void (notes.sideRecords++, r.k === 'bad' && notes.sideBad++);
      if (s.turns === 0) return void notes.beforeFirstPrompt++;
      if (r.k === 'prompt') cur.ts = r.ts;
      if (r.k === 'bad') cur.bad = true;
      if (r.k !== 'assistant') return;
      for (const x of r.texts) {
        if (RX.choice.test(x)) cur.choice = true;
        if (hasFindings(x)) cur.findings = true;
        if (x.length > LAST_CAP) cur.cut++;
        cur.last = x.slice(0, LAST_CAP);
      }
      for (const t of r.tools) {
        if (t.malformed) continue; // unknown: the turn is dropped in `turn`
        if (t.name === 'AskUserQuestion') {
          cur.choice = false;
          cur.asks++;
          if ((t.ask?.options ?? 0) >= 2) cur.asks2++;
          if (t.ask?.recommended) cur.asksRec++;
        } else if (changes(t)) {
          if (cur.choice) cur.ask = true;
          if (cur.findings) cur.editsAfter++;
        }
      }
    },
    turn(s, t) {
      const c = cur;
      cur = fresh();
      if (c.bad || t.tools.some((x) => x.malformed)) {
        unknown++;
        sessionUnknown = true;
        return;
      }
      for (const r of RULES) {
        byRule[r].byBucket[bucketOf(t.index)].turns++;
        byRule[r].byCompact[t.afterCompact ? 'post' : 'pre'].turns++;
      }
      const a = byRule['ask-first'].counters;
      a.asks! += c.asks; a.asksWith2Options! += c.asks2; a.asksWithRecommendation! += c.asksRec;
      if (c.ask) open('ask-first', s, t, c.ts);

      const nd = byRule['no-invented-data'].counters, results = [...t.results.values(), ...t.subResults.values()];
      let invented = false;
      const found = [...c.last.matchAll(NUMBER_G)];
      nd.numbersSkipped! += Math.max(0, found.length - NUMBERS_CAP);
      nd.textsCut! += c.cut;
      for (const m of found.slice(0, NUMBERS_CAP)) {
        nd.numbers!++;
        const n = /\d[\d,.]*\d|\d/.exec(m[0])![0];
        if (results.some((x) => x.text.includes(n))) nd.numbersInResults!++;
        else if (RX.estimateLabel.test(sentenceAt(c.last, m.index))) nd.numbersLabelled!++;
        else invented = true;
      }
      if (invented) open('no-invented-data', s, t, c.ts);

      if (c.findings) {
        const f = byRule['fix-everything'].counters;
        f.findingsTurns!++;
        f.editsAfter! += c.editsAfter;
        if (RX.notFixed.test(c.last)) open('fix-everything', s, t, c.ts);
      }

      const prs = t.tools.filter((x) => bash(x, /\bgh\s+pr\s+create\b/)).length;
      if (prs > 0) pr = { calls: pr.calls + prs, w: make('readme-per-pr', s, t), t: { ...t, results: new Map(), subResults: new Map() }, ts: c.ts };

      const paid = t.tools.filter((x) => bash(x, RX.paid)).length, p = byRule['paid-ok'].counters;
      p.paidCommands! += paid;
      if (paid > 0 && RX.approval.test(t.prompt)) p.paidWithApproval! += paid;
      else if (paid > 0) open('paid-ok', s, t, c.ts);

      const ws = sentenceWords(c.last);
      if (ws.length > 0) {
        const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
        byRule['plain-communication'].counters[avg <= 15 ? 'avg0-15' : avg <= 25 ? 'avg16-25' : avg <= 35 ? 'avg26-35' : 'avg36+']!++;
        if (avg > 25 || ws.filter((n) => n > 35).length / ws.length > 0.2) open('plain-communication', s, t, c.ts);
      }

      const kinds = t.tools.filter((x) => EDITS.has(x.name) && x.filePath !== undefined).map((x) => x.filePath!.replace(/\\/g, '/'));
      const firstTest = kinds.findIndex(isAnyTestFile), firstSrc = kinds.findIndex((f) => !isAnyTestFile(f) && CODE.test(f));
      if (firstTest >= 0 && firstSrc >= 0) {
        byRule.tdd.counters.bothKinds!++;
        if (!opts.tddGateOn && firstSrc < firstTest) open('tdd', s, t, c.ts);
      }
    },
    endSession(s) {
      // readme-per-pr is a session rule: decided once every edit is known
      const rel = s.edited.map((f) => f.replace(/\\/g, '/')).map((f) => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f));
      const readme = rel.includes('README.md'), code = rel.some((f) => /^(src|skills)\//.test(f));
      const c = byRule['readme-per-pr'].counters;
      c.prCreates! += pr.calls;
      if (readme) c.prCreatesWithReadme! += pr.calls;
      if (pr.w && pr.t && code && !readme) sessionUnknown ? unknown++ : open('readme-per-pr', s, pr.t, pr.ts, pr.w);
      cur = fresh();
      sessionUnknown = false;
      pr = { calls: 0, ts: NaN };
    },
    result() {
      for (const r of RULES) byRule[r].windows = kept.get(r)!.sort(newest).map((x) => x.w);
      return { byRule, unknown, notes };
    },
  };
}
