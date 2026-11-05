import type { Acc, SessionCtx } from './acc.js';
import { streamTranscript, type ReadStats, type ToolUse, type TRec } from './transcript.js';

type Result = Extract<TRec, { k: 'result' }>;
export interface Turn { index: number; prompt: string; texts: string[]; tools: ToolUse[]; results: Map<string, Result>; afterCompact: boolean; date: string }

// A hostile session can hold any number of tool calls in one turn: keep this many of each (results hold up to 64 KB of text).
const TURN_CAP = 500, PROMPT_CAP = 600, EDIT_CAP = 1000;
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
        cur = { index: ++index, prompt: r.text.slice(0, PROMPT_CAP), texts: [], tools: [], results: new Map(), afterCompact: compacted, date: day(r.ts) };
      } else if (cur && r.k === 'assistant') {
        for (const t of r.texts) if (room(cur.texts.length)) cur.texts.push(t.slice(0, PROMPT_CAP));
        for (const t of r.tools) if (room(cur.tools.length)) cur.tools.push(t);
      } else if (cur && r.k === 'result' && room(cur.results.size)) cur.results.set(r.useId, r);
    },
    end: close,
  };
}

/** Main transcript first, then each subagent file. Subagent records reach the accumulators' `rec` but start no turn (ponytail: no time-merge with the main file, which would need both in memory). */
export async function runSession(files: { main: string; subagents: string[] }, id: string, accs: Acc<unknown>[], sinceMs: number): Promise<ReadStats> {
  const s: SessionCtx = { id, turns: 0, compactions: 0, edited: [] };
  const edited = new Set<string>();
  const splitter = turnSplitter((t) => {
    accs.forEach((a) => a.turn?.(s, t));
  });
  const visit = (r: TRec) => {
    if (r.k === 'compact') s.compactions++;
    if (r.k === 'prompt' && !r.side) s.turns++;
    if (r.k === 'assistant') for (const t of r.tools) if (t.filePath !== undefined && EDITS.has(t.name) && edited.size < EDIT_CAP) edited.add(t.filePath);
    s.edited = [...edited];
    if (!r.side) splitter.push(r);
    accs.forEach((a) => a.rec?.(s, r));
  };
  const total = await streamTranscript(files.main, visit, { sinceMs });
  for (const f of files.subagents) {
    const st = await streamTranscript(f, visit, { sinceMs, side: true });
    total.lines += st.lines; total.bad += st.bad; total.tooLong += st.tooLong; total.noTime += st.noTime;
    st.versions.forEach((v) => total.versions.add(v));
    for (const [k, n] of Object.entries(st.types)) total.types[k] = (total.types[k] ?? 0) + n;
  }
  splitter.end();
  accs.forEach((a) => a.endSession?.(s));
  return total;
}
