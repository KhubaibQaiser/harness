import { isAnyTestFile } from '../core/paths.js';
import { bucketOf, type Acc, type Bucket, type SessionCtx } from './acc.js';
import type { ToolUse } from './transcript.js';
import type { Turn } from './turns.js';

// Judgement rules (spec §4.2): heuristics find "needs a look" windows. Never a score or a pass/fail (owner U-judgement, docs/research/2026-11-05-judge-fit.md).
// No window never means "followed". Quoted turns are untrusted: matched by regex only, never interpreted.

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
/** Window fields that quote transcript text. Local HTML only: the export is counts only (owner Q9) and must drop them. */
export const QUOTED = ['prompt', 'texts', 'tools'] as const satisfies readonly (keyof Window)[];

type Split = { turns: number; windows: number };
export interface WindowsResult {
  byRule: Record<WindowRule, { windows: Window[]; total: number; counters: Record<string, number>; byBucket: Record<Bucket, Split>; byCompact: { pre: Split; post: Split } }>;
  unknown: number;
}

const PART = 600; // spec §4.2 (estimate)
const SESSION_CAP = 10; // windows per rule per session, newest kept (estimate): one long session can't fill the list
const LAST_CAP = 64 * 1024, NUMBERS_CAP = 20; // a hostile turn can hold thousands of numbers and 500 results of 64 KB
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const NUMBER_G = new RegExp(RX.number.source, 'gi');
const SENTENCE = /[.!?]+(?:\s|$)/g;
const COUNTERS: Record<WindowRule, string[]> = {
  'ask-first': ['asks', 'asksWith2Options', 'asksWithRecommendation'],
  'no-invented-data': ['numbers', 'numbersInResults', 'numbersLabelled'],
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

export function windowsAcc(opts: { tddGateOn: boolean; cap?: number }): Acc<WindowsResult> {
  const cap = opts.cap ?? 50;
  const split = () => ({ turns: 0, windows: 0 });
  const byRule = Object.fromEntries(RULES.map((r) => [r, {
    windows: [] as Window[], total: 0, counters: Object.fromEntries(COUNTERS[r].map((c) => [c, 0])),
    byBucket: { '1-10': split(), '11-30': split(), '31-100': split(), '100+': split() }, byCompact: { pre: split(), post: split() },
  }])) as WindowsResult['byRule'];
  const kept = new Map<WindowRule, { w: Window; seq: number }[]>(RULES.map((r) => [r, []]));
  let unknown = 0, seq = 0;
  // newest first: by date, then by order seen; an unknown date sorts oldest
  const newest = (a: { w: Window; seq: number }, b: { w: Window; seq: number }) => {
    const da = a.w.date === 'unknown' ? '' : a.w.date, db = b.w.date === 'unknown' ? '' : b.w.date;
    return da < db ? 1 : da > db ? -1 : b.seq - a.seq;
  };

  // per turn, from main-thread records in order (a Turn keeps texts and tools apart, so "an edit after the choice" needs the records)
  const fresh = () => ({ bad: false, choice: false, findings: false, ask: false, editsAfter: 0, last: '' });
  let cur = fresh();
  // per session
  let cwd: string | undefined, sessionUnknown = false, pr: { calls: number; w?: Window; t?: Turn } = { calls: 0 };
  let buf = new Map<WindowRule, { w: Window; seq: number }[]>();

  const make = (rule: WindowRule, s: SessionCtx, t: Turn): Window => {
    const w: Window = { rule, session: s.id, date: t.date, turn: t.index, prompt: t.prompt.slice(0, PART), texts: t.texts.join('\n\n').slice(0, PART), tools: toolLines(t) };
    if ([w.prompt, w.texts, ...w.tools].some((p) => CONTROL.test(p))) w.control = true;
    return w;
  };
  const open = (rule: WindowRule, s: SessionCtx, t: Turn, w = make(rule, s, t)) => {
    const o = byRule[rule];
    o.total++;
    o.byBucket[bucketOf(t.index)].windows++;
    o.byCompact[t.afterCompact ? 'post' : 'pre'].windows++;
    const b = buf.get(rule) ?? [];
    b.push({ w, seq: seq++ });
    if (b.length > SESSION_CAP) b.shift();
    buf.set(rule, b);
  };

  return {
    rec(_s, r) {
      if (r.side) return; // subagent records reach rec after the main thread, so they can't be placed in a turn here
      cwd ??= r.cwd;
      if (r.k === 'bad') cur.bad = true;
      if (r.k !== 'assistant') return;
      for (const x of r.texts) {
        if (RX.choice.test(x)) cur.choice = true;
        if (hasFindings(x)) cur.findings = true;
        cur.last = x.slice(0, LAST_CAP);
      }
      const c = byRule['ask-first'].counters;
      for (const t of r.tools) {
        if (t.malformed) continue; // unknown: the turn is dropped in `turn`
        if (t.name === 'AskUserQuestion') {
          cur.choice = false;
          c.asks!++;
          if ((t.ask?.options ?? 0) >= 2) c.asksWith2Options!++;
          if (t.ask?.recommended) c.asksWithRecommendation!++;
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
      if (c.ask) open('ask-first', s, t);

      const nd = byRule['no-invented-data'].counters, results = [...t.results.values(), ...t.subResults.values()];
      let invented = false;
      for (const m of [...c.last.matchAll(NUMBER_G)].slice(0, NUMBERS_CAP)) {
        nd.numbers!++;
        const n = /\d[\d,.]*\d|\d/.exec(m[0])![0];
        if (results.some((x) => x.text.includes(n))) nd.numbersInResults!++;
        else if (RX.estimateLabel.test(sentenceAt(c.last, m.index))) nd.numbersLabelled!++;
        else invented = true;
      }
      if (invented) open('no-invented-data', s, t);

      if (c.findings) {
        const f = byRule['fix-everything'].counters;
        f.findingsTurns!++;
        f.editsAfter! += c.editsAfter;
        if (RX.notFixed.test(c.last)) open('fix-everything', s, t);
      }

      const prs = t.tools.filter((x) => bash(x, /\bgh\s+pr\s+create\b/)).length;
      if (prs > 0) pr = { calls: pr.calls + prs, w: make('readme-per-pr', s, t), t: { ...t, results: new Map(), subResults: new Map() } };

      const paid = t.tools.filter((x) => bash(x, RX.paid)).length, p = byRule['paid-ok'].counters;
      p.paidCommands! += paid;
      if (paid > 0 && RX.approval.test(t.prompt)) p.paidWithApproval! += paid;
      else if (paid > 0) open('paid-ok', s, t);

      const ws = sentenceWords(c.last);
      if (ws.length > 0) {
        const avg = ws.reduce((a, b) => a + b, 0) / ws.length;
        byRule['plain-communication'].counters[avg <= 15 ? 'avg0-15' : avg <= 25 ? 'avg16-25' : avg <= 35 ? 'avg26-35' : 'avg36+']!++;
        if (avg > 25 || ws.filter((n) => n > 35).length / ws.length > 0.2) open('plain-communication', s, t);
      }

      const kinds = t.tools.filter((x) => EDITS.has(x.name) && x.filePath !== undefined).map((x) => x.filePath!.replace(/\\/g, '/'));
      const firstTest = kinds.findIndex(isAnyTestFile), firstSrc = kinds.findIndex((f) => !isAnyTestFile(f) && CODE.test(f));
      if (firstTest >= 0 && firstSrc >= 0) {
        byRule.tdd.counters.bothKinds!++;
        if (!opts.tddGateOn && firstSrc < firstTest) open('tdd', s, t);
      }
    },
    endSession(s) {
      // readme-per-pr is a session rule: decided once every edit is known
      const root = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
      const rel = s.edited.map((f) => f.replace(/\\/g, '/')).map((f) => (root !== undefined && f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f));
      const readme = rel.some((f) => f.split('/').pop() === 'README.md'), code = rel.some((f) => /^(src|skills)\//.test(f));
      const c = byRule['readme-per-pr'].counters;
      c.prCreates! += pr.calls;
      if (readme) c.prCreatesWithReadme! += pr.calls;
      if (pr.w && pr.t && code && !readme) sessionUnknown ? unknown++ : open('readme-per-pr', s, pr.t, pr.w);
      for (const [rule, b] of buf) {
        const k = kept.get(rule)!;
        k.push(...b);
        k.sort(newest).splice(cap);
      }
      cur = fresh();
      cwd = undefined;
      sessionUnknown = false;
      pr = { calls: 0 };
      buf = new Map();
    },
    result() {
      for (const r of RULES) byRule[r].windows = kept.get(r)!.sort(newest).map((x) => x.w);
      return { byRule, unknown };
    },
  };
}
