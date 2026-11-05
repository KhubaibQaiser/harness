import type { HarnessEvent } from '../../core/events.js';
import type { TimingLine } from '../../core/timing.js';
import { isShell } from '../../hooks/edit-target.js';
import { shellWriteTargets } from '../../checks/protect.js';
import type { Acc, SessionCtx } from '../acc.js';
import type { ToolUse, TRec } from '../transcript.js';
import type { Turn } from '../turns.js';

export type Signal = 'ask-approved' | 'deny-retry' | 'stop-flake' | 'gave-up' | 'override';
export interface FalseBlock { signal: Signal; check: string; session: string; date: string; turn?: number; fuzzy: boolean; step?: string; quote?: string }
export interface LatencyRow { source: 'timing' | 'transcript' | 'events'; event: string; outcome?: string; n: number; p50: number; p95: number; max: number; timeouts: number }
/** `notes` counts what the heuristics could not place or what a cap left out: nothing is dropped silently. */
/**
 * `notes.noTimingLog`: stopSteps p50 and p95 come only from the timing log, so they are null without one.
 * Known limit: a deny-retry is not excluded when the retry has a harness event without `use` (such as `allow-log`).
 */
export interface GatesResult {
  tally: Record<string, number>; overrides: Record<string, number>; falseBlocks: FalseBlock[]; latency: LatencyRow[];
  stopSteps: { step: string; runs: number; blocks: number; flakes: number; p50: number | null; p95: number | null }[];
  hallucination: { typecheckBlocks: number; testBlocks: number; registryChecks: number; registryDenies: number };
  notes: { badEvents: number; badTiming: number; noTime: number; falseBlocksCut: number; denyUnlinked: number; unknownTools: number /* malformed tool uses seen */; truncatedTurns: number; samplesCut: number; keysCut: number; noTimingLog: boolean };
}

const WINDOW_MS = 2000, MAX_FALSE = 500, MAX_KEYS = 64, MAX_TALLY = 500, MAX_SAMPLES = 50_000, MAX_IDS = 20_000, MIN_REASON = 10, QUOTE = 600;
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DISPATCH = '.harness/hooks/dispatch.mjs';
const day = (ms: number) => (Number.isNaN(ms) ? 'unknown' : new Date(ms).toISOString().slice(0, 10));
/** Nearest rank. */
const pct = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
/** The step a stop block names, parsed the way `harness stats` does. */
const stepOf = (reason = ''): string => (reason.startsWith('Diff coverage') || reason.startsWith('Coverage output') ? 'coverage' : reason.includes(' failed (attempt') ? reason.slice(0, reason.indexOf(' failed (attempt')) : 'other');
/** Same tool, same target: the file path, or for Bash the first two non-flag words plus the path-like arguments (so `git status` is not a retry of `git push`). */
const target = (t: ToolUse): string | undefined => {
  if (t.malformed) return undefined;
  if (t.name !== 'Bash') return t.filePath === undefined ? undefined : `${t.name}|${t.filePath}`;
  if (t.command === undefined) return undefined;
  const words = t.command.trim().split(/\s+/).filter((x) => !x.startsWith('-'));
  return `Bash|${words.slice(0, 2).join(' ')}|${words.filter((x) => /[/\\.]/.test(x)).join(' ')}`;
};

interface Ev { e: HarnessEvent; ms: number; done: boolean; fuzzy?: boolean; linked?: boolean }

export function gatesAcc(events: HarnessEvent[], timing: TimingLine[], sinceMs: number): Acc<GatesResult> {
  const notes: GatesResult['notes'] = { badEvents: 0, badTiming: 0, noTime: 0, falseBlocksCut: 0, denyUnlinked: 0, unknownTools: 0, truncatedTurns: 0, samplesCut: 0, keysCut: 0, noTimingLog: timing.length === 0 };
  const tally = Object.create(null) as Record<string, number>;
  let tallyKeys = 0;
  const overrides = { 'tdd paused': 0, 'multi-file approvals': 0, 'allow-log': 0 };
  const falseBlocks: FalseBlock[] = [];
  const flag = (f: FalseBlock) => (falseBlocks.length < MAX_FALSE ? void falseBlocks.push(f) : void notes.falseBlocksCut++);
  const steps = new Map<string, { runs: number; blocks: number; flakes: number; ms: number[] }>();
  const step = (name: string) => {
    const k = name.slice(0, MAX_KEYS);
    if (!steps.has(k) && steps.size >= MAX_KEYS) { notes.keysCut++; return steps.get('other') ?? steps.set('other', { runs: 0, blocks: 0, flakes: 0, ms: [] }).get('other')!; }
    return steps.get(k) ?? steps.set(k, { runs: 0, blocks: 0, flakes: 0, ms: [] }).get(k)!;
  };
  const groups = new Map<string, { source: LatencyRow['source']; event: string; outcome?: string; ms: number[]; timeouts: number }>();
  const sample = (source: LatencyRow['source'], event: string, outcome: string | undefined, ms: number | null, timedOut = false) => {
    const key = `${source}\0${event.slice(0, MAX_KEYS)}\0${outcome ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= MAX_TALLY) return void notes.keysCut++;
      groups.set(key, g = { source, event: event.slice(0, MAX_KEYS), outcome, ms: [], timeouts: 0 });
    }
    if (timedOut) g.timeouts++;
    if (ms === null) return;
    if (g.ms.length < MAX_SAMPLES) g.ms.push(ms);
    else notes.samplesCut++;
  };
  const hall = { typecheckBlocks: 0, testBlocks: 0, registryChecks: 0, registryDenies: 0 };

  // Event-only counts, and the indexes the transcript signals join against.
  const byUse = new Map<string, Ev>(); // ask and deny events that carry `use`
  const asks = new Map<string, Ev[]>(); // ask events without `use`, by session (fuzzy join)
  const denies = new Map<string, Ev[]>(); // deny events without `use`, by session (fuzzy join)
  const stopBlocks = new Map<string, Ev[]>();
  for (const e of events) {
    if (!e || typeof e.check !== 'string' || typeof e.decision !== 'string' || typeof e.session !== 'string') { notes.badEvents++; continue; }
    const ms = Date.parse(e.ts);
    if (Number.isNaN(ms)) { notes.noTime++; continue; }
    if (ms < sinceMs) continue;
    const key = `${e.check} ${e.decision}`.slice(0, 128);
    if (key in tally || tallyKeys < MAX_TALLY) { if (!(key in tally)) tallyKeys++; tally[key] = (tally[key] ?? 0) + 1; }
    else notes.keysCut++;
    const ev: Ev = { e, ms, done: false }, date = day(ms), base = { check: e.check, session: e.session, date };
    if (typeof e.ms === 'number' && Number.isFinite(e.ms) && e.ms >= 0) sample('events', e.check, e.decision, e.ms);
    const paused = e.check === 'tdd' && e.decision === 'paused', multi = e.check === 'multi-file' && (e.decision === 'approved' || e.decision === 'allow-log'), log = e.decision === 'allow-log';
    if (paused) overrides['tdd paused']++;
    if (multi) overrides['multi-file approvals']++;
    if (log) overrides['allow-log']++;
    if (paused || multi || log || (e.decision === 'harness-files-changed' && (e.reason ?? '').includes('.harness/config.yaml'))) flag({ signal: 'override', ...base, fuzzy: false });
    if (e.decision === 'stop-gave-up') flag({ signal: 'gave-up', ...base, fuzzy: false });
    if (e.check === 'dep-verify') { hall.registryChecks++; if (e.decision === 'deny') hall.registryDenies++; }
    if (e.check === 'stop' && e.decision === 'block') {
      const s = stepOf(e.reason);
      step(s).blocks++;
      if (s === 'typecheck') hall.typecheckBlocks++;
      if (s === 'test') hall.testBlocks++;
      (stopBlocks.get(e.session) ?? stopBlocks.set(e.session, []).get(e.session)!).push(ev);
    }
    if (e.decision === 'ask' || e.decision === 'deny') {
      if (typeof e.use === 'string' && byUse.size < MAX_IDS) byUse.set(e.use, ev);
      else (e.decision === 'ask' ? asks : denies).get(e.session)?.push(ev) ?? (e.decision === 'ask' ? asks : denies).set(e.session, [ev]);
    }
  }
  stopBlocks.forEach((l) => l.sort((a, b) => a.ms - b.ms));
  for (const t of timing) {
    const ms = Date.parse(t?.ts);
    if (!t || typeof t.event !== 'string' || typeof t.outcome !== 'string' || typeof t.ms !== 'number' || !Number.isFinite(t.ms) || t.ms < 0) { notes.badTiming++; continue; }
    if (Number.isNaN(ms)) { notes.noTime++; continue; }
    if (ms < sinceMs) continue;
    sample('timing', t.event, t.outcome, t.ms, t.outcome === 'timeout');
    if (t.event === 'Stop' && typeof t.step === 'string') { const s = step(t.step); s.runs++; if (s.ms.length < MAX_SAMPLES) s.ms.push(t.ms); else notes.samplesCut++; }
  }

  // Per-session transcript state.
  let id = '', toolTs = new Map<string, number>(), pending: Ev | undefined, edited = false, cursor = 0;
  const reset = (to: string) => { id = to; toolTs = new Map(); pending = undefined; edited = false; cursor = 0; };
  reset('');
  const ask = (r: Extract<TRec, { k: 'result' }>) => {
    let ev = byUse.get(r.useId), fuzzy = false;
    if (ev && (ev.e.decision !== 'ask' || ev.e.session !== id)) ev = undefined;
    if (!ev) {
      const at = toolTs.get(r.useId);
      if (at === undefined) return;
      for (const c of asks.get(id) ?? []) if (!c.done && Math.abs(c.ms - at) <= WINDOW_MS && (!ev || Math.abs(c.ms - at) < Math.abs(ev.ms - at))) ev = c;
      fuzzy = true;
    }
    if (!ev || ev.done) return;
    ev.done = true;
    flag({ signal: 'ask-approved', check: ev.e.check, session: id, date: day(ev.ms), fuzzy });
  };
  /** A deny with no `use`: the error result whose tool use is nearest in time, and whose text holds the start of the reason. Fuzzy. */
  const linkDeny = (r: Extract<TRec, { k: 'result' }>) => {
    const at = toolTs.get(r.useId);
    if (at === undefined || byUse.has(r.useId)) return;
    let best: Ev | undefined;
    for (const c of denies.get(id) ?? []) {
      const reason = (c.e.reason ?? '').trim().slice(0, 30);
      if (reason.length >= MIN_REASON && !c.linked && Math.abs(c.ms - at) <= WINDOW_MS && r.text.includes(reason) && (!best || Math.abs(c.ms - at) < Math.abs(best.ms - at))) best = c;
    }
    if (best && byUse.size < MAX_IDS) {
      best.linked = best.fuzzy = true;
      byUse.set(r.useId, best);
      // a `co` deny is a second deny on the same call: it shares this result with its twin
      for (const c of denies.get(id) ?? []) if (c.e.co && !c.linked && Math.abs(c.ms - best.ms) <= WINDOW_MS) c.linked = true;
    }
  };
  return {
    rec(s: SessionCtx, r: TRec) {
      if (s.id !== id) reset(s.id);
      if (r.k === 'result' && r.isError) linkDeny(r);
      if (r.k === 'assistant') {
        for (const t of r.tools) {
          if (t.malformed) continue;
          if (toolTs.size < MAX_IDS && !Number.isNaN(r.ts)) toolTs.set(t.id, r.ts);
          // ponytail: edits by a subagent arrive after the main file, so they never reset a flake
          if (EDITS.has(t.name) || (isShell(t.name) && t.command !== undefined && shellWriteTargets(t.command).length > 0)) edited = true;
        }
      } else if (r.k === 'result' && r.permission?.decision === 'accept' && (r.permission.source === 'user_temporary' || r.permission.source === 'user_permanent')) ask(r);
      else if (r.k === 'hook' && r.command.includes(DISPATCH)) {
        sample('transcript', r.event, undefined, r.ms, r.timedOut); // no duration: counted as a timeout if it was one, never as a 0 ms sample
      } else if (r.k === 'stop' && !r.side) {
        const blocks = stopBlocks.get(id) ?? [];
        while (cursor < blocks.length && blocks[cursor]!.ms < r.ts - WINDOW_MS) cursor++;
        const near = blocks[cursor] !== undefined && Math.abs(blocks[cursor]!.ms - r.ts) <= WINDOW_MS ? blocks[cursor] : undefined;
        if (near) { pending = near; edited = false; }
        else if (pending) {
          if (!edited) {
            const st = stepOf(pending.e.reason);
            step(st).flakes++;
            flag({ signal: 'stop-flake', check: 'stop', session: id, date: day(pending.ms), fuzzy: true, step: st });
          }
          pending = undefined;
        }
      }
    },
    turn(s: SessionCtx, t: Turn) {
      if (t.dropped.tools > 0 || t.dropped.results > 0) notes.truncatedTurns++;
      t.tools.forEach((d, i) => {
        if (d.malformed) return void notes.unknownTools++; // unknown, never an override or a retry
        const ev = byUse.get(d.id);
        if (!ev || ev.done || ev.e.decision !== 'deny' || ev.e.session !== s.id) return;
        const want = target(d);
        if (want === undefined) return;
        const retry = t.tools.slice(i + 1).find((x) => {
          if (x.malformed || target(x) !== want || byUse.has(x.id)) return false;
          const res = t.results.get(x.id) ?? t.subResults.get(x.id);
          return res !== undefined && !res.isError;
        });
        if (!retry) return;
        ev.done = true;
        flag({ signal: 'deny-retry', check: ev.e.check, session: s.id, date: t.date, turn: t.index, fuzzy: ev.fuzzy === true, quote: (ev.e.reason ?? t.results.get(d.id)?.text ?? '').slice(0, QUOTE) });
      });
    },
    result() {
      const latency = [...groups.values()].map((g): LatencyRow => {
        const m = [...g.ms].sort((a, b) => a - b);
        return { source: g.source, event: g.event, ...(g.outcome === undefined ? {} : { outcome: g.outcome }), n: m.length, p50: m.length ? pct(m, 50) : 0, p95: m.length ? pct(m, 95) : 0, max: m.length ? m[m.length - 1]! : 0, timeouts: g.timeouts };
      });
      const stopSteps = [...steps].map(([name, v]) => {
        const m = [...v.ms].sort((a, b) => a - b);
        return { step: name, runs: v.runs, blocks: v.blocks, flakes: v.flakes, p50: m.length ? pct(m, 50) : null, p95: m.length ? pct(m, 95) : null };
      });
      notes.denyUnlinked = [...denies.values()].flat().filter((d) => !d.linked).length; // set here so a link made later still counts
      return { tally, overrides, falseBlocks, latency, stopSteps, hallucination: hall, notes };
    },
  };
}
