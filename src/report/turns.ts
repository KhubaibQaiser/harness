import type { Acc, SessionCtx } from './acc.js';
import { streamTranscript, type ReadStats, type ToolUse, type TRec } from './transcript.js';

type Result = Extract<TRec, { k: 'result' }>;
export interface Turn { index: number; prompt: string; texts: string[]; tools: ToolUse[]; results: Map<string, Result>; afterCompact: boolean; date: string; dropped: { texts: number; tools: number; results: number } }

// A hostile session can hold any number of tool calls in one turn: keep this many of each (results hold up to 64 KB of text).
// `dropped` counts what the cap left out, so a metric can say "truncated" instead of under-reporting.
const TURN_CAP = 500, PROMPT_CAP = 600, EDIT_CAP = 1000, SUB_CAP = 5000;
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const day = (ts: number) => (Number.isNaN(ts) ? 'unknown' : new Date(ts).toISOString().slice(0, 10));

/** A turn runs from a prompt to the next prompt. A subagent's records join the open turn; its prompt starts none. */
export function turnSplitter(onTurn: (t: Turn) => void): { push(r: TRec): void; end(): void } {
  let cur: Turn | undefined, compacted = false, index = 0;
  const close = () => {
    if (cur) onTurn(cur);
    cur = undefined;
  };
  const room = (n: number) => n < TURN_CAP;
  return {
    push(r) {
      if (r.k === 'compact') compacted = true;
      else if (r.k === 'prompt' && !r.side) {
        close();
        cur = { index: ++index, prompt: r.text.slice(0, PROMPT_CAP), texts: [], tools: [], results: new Map(), afterCompact: compacted, date: day(r.ts), dropped: { texts: 0, tools: 0, results: 0 } };
      } else if (cur && r.k === 'assistant') {
        for (const t of r.texts) room(cur.texts.length) ? cur.texts.push(t.slice(0, PROMPT_CAP)) : cur.dropped.texts++;
        for (const t of r.tools) room(cur.tools.length) ? cur.tools.push(t) : cur.dropped.tools++;
      } else if (cur && r.k === 'result') room(cur.results.size) ? cur.results.set(r.useId, r) : cur.dropped.results++;
    },
    end: close,
  };
}

/** Subagent tool calls and results, kept (capped) so they can join the main turn open at their time. Texts and usage are not kept. */
async function subSummary(files: string[], sinceMs: number): Promise<{ kept: TRec[]; dropped: number }> {
  const kept: TRec[] = [];
  let dropped = 0;
  for (const f of files) {
    await streamTranscript(f, (r) => {
      if (Number.isNaN(r.ts)) return;
      const keep = r.k === 'assistant' ? r.tools.length > 0 : r.k === 'result';
      if (!keep) return;
      if (kept.length >= SUB_CAP) dropped++;
      else kept.push(r.k === 'assistant' ? { ...r, texts: [], usage: undefined } : { ...r, text: '' } as TRec);
    }, { sinceMs, side: true });
  }
  return { kept: kept.sort((a, b) => a.ts - b.ts), dropped }; // ponytail: one capped list; past SUB_CAP later subagent calls miss their turn
}

/**
 * Subagent tool calls join the main turn open at their timestamp (one outside every turn is dropped). Subagent files are read twice:
 * once for that summary, once for the accumulators' `rec`, which sees them after the main file.
 */
export async function runSession(files: { main: string; subagents: string[] }, id: string, accs: Acc<unknown>[], sinceMs: number): Promise<ReadStats & { subDropped: number }> {
  const s: SessionCtx = { id, turns: 0, compactions: 0, edited: [], subDropped: 0 };
  const edited = new Set<string>();
  const splitter = turnSplitter((t) => {
    accs.forEach((a) => a.turn?.(s, t));
  });
  const { kept: subs, dropped } = await subSummary(files.subagents, sinceMs);
  s.subDropped = dropped; // counted, never silent
  let next = 0;
  const joinUntil = (ts: number) => {
    for (; next < subs.length && subs[next]!.ts < ts; next++) if (s.turns > 0) splitter.push(subs[next]!);
  };
  const visit = (r: TRec) => {
    if (r.k === 'compact' && !r.side) s.compactions++;
    if (r.k === 'prompt' && !r.side) {
      joinUntil(r.ts); // a main prompt with no time cannot place anything: its turn gets none
      s.turns++;
    }
    if (r.k === 'assistant' && !r.side) {
      for (const t of r.tools) if (t.filePath !== undefined && EDITS.has(t.name) && edited.size < EDIT_CAP && !edited.has(t.filePath)) {
        edited.add(t.filePath);
        s.edited.push(t.filePath);
      }
    }
    if (!r.side) splitter.push(r);
    accs.forEach((a) => a.rec?.(s, r));
  };
  const total = await streamTranscript(files.main, visit, { sinceMs });
  joinUntil(Infinity);
  for (const f of files.subagents) {
    const st = await streamTranscript(f, visit, { sinceMs, side: true });
    total.lines += st.lines; total.bad += st.bad; total.tooLong += st.tooLong; total.noTime += st.noTime;
    st.versions.forEach((v) => total.versions.add(v));
    for (const [k, n] of Object.entries(st.types)) total.types[k] = (total.types[k] ?? 0) + n;
  }
  splitter.end();
  accs.forEach((a) => a.endSession?.(s));
  return { ...total, subDropped: dropped };
}
