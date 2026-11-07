import { contextSet } from '../../budget/summary.js';
import { loadConfig } from '../../core/config.js';
import type { Acc, SessionCtx } from '../acc.js';
import type { TRec, Usage } from '../transcript.js';

export interface UsageResult {
  total: Usage; main: Usage; sub: Usage; byDay: Record<string, Usage>; byModel: Record<string, Usage>;
  sessions: { id: string; usage: Usage; responses: number; compactions: number; peak: number }[];
  responses: number; unknown: number;
  loads: { sessions: number; agentsMd: number; claudeMd: number; unknown: number; compactions: number; reloaded: number };
  toolChars: Record<string, number>;
}

// Hostile input can hold any number of distinct model names, tool names, days and tool ids: bound each.
const MAX_KEYS = 64, MAX_DAYS = 400, MAX_IDS = 20_000, MAX_DEDUP = 500_000;
const zero = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const add = (a: Usage, b: Usage) => {
  a.input += b.input; a.output += b.output; a.cacheWrite += b.cacheWrite; a.cacheRead += b.cacheRead;
};
/** The entry for `key`, or the shared `other` entry once `max` keys exist. */
const slot = <T>(m: Record<string, T>, key: string, max: number, mk: () => T): T => {
  const k = key.slice(0, MAX_KEYS), name = k in m || Object.keys(m).length < max ? k : 'other';
  return (m[name] ??= mk());
};

export function usageAcc(): Acc<UsageResult> {
  const res: UsageResult = {
    total: zero(), main: zero(), sub: zero(), byDay: Object.create(null) as Record<string, Usage>, byModel: Object.create(null) as Record<string, Usage>, sessions: [],
    responses: 0, unknown: 0, loads: { sessions: 0, agentsMd: 0, claudeMd: 0, unknown: 0, compactions: 0, reloaded: 0 }, toolChars: Object.create(null) as Record<string, number>,
  };
  let id = '', seen = new Set<string>(), names = new Map<string, string>(), cur = zero(), responses = 0, peak = 0, compactions = 0, sawIns = false, agents = false, claude = false, compacted = false;
  const reset = (to: string) => {
    id = to; seen = new Set(); names = new Map(); cur = zero(); responses = 0; peak = 0; compactions = 0; sawIns = agents = claude = compacted = false;
  };
  reset('');
  const response = (r: Extract<TRec, { k: 'assistant' }>) => {
    if (r.key === null) res.unknown++;
    else if (seen.has(r.key)) return;
    else if (seen.size < MAX_DEDUP) seen.add(r.key); // ponytail: past the cap a repeat counts twice; fine below ~500k responses a session
    for (const t of r.tools) if (t.name !== '' && names.size < MAX_IDS) names.set(t.id, t.name);
    const u = r.usage;
    if (u === undefined) {
      if (r.key !== null) res.unknown++;
      return;
    }
    responses++; res.responses++;
    if (!r.side) peak = Math.max(peak, u.input + u.cacheWrite + u.cacheRead); // a subagent's context is its own
    add(cur, u); add(res.total, u); add(r.side ? res.sub : res.main, u);
    add(slot(res.byDay, Number.isNaN(r.ts) ? 'unknown' : new Date(r.ts).toISOString().slice(0, 10), MAX_DAYS, zero), u);
    add(slot(res.byModel, r.model ?? 'unknown', MAX_KEYS, zero), u);
  };
  return {
    rec(s: SessionCtx, r: TRec) {
      if (s.id !== id) reset(s.id);
      if (r.k === 'assistant') response(r);
      else if (r.k === 'result') {
        const n = names.get(r.useId);
        if (n !== undefined) {
          const k = n.slice(0, MAX_KEYS) in res.toolChars || Object.keys(res.toolChars).length < MAX_KEYS ? n.slice(0, MAX_KEYS) : 'other';
          res.toolChars[k] = (res.toolChars[k] ?? 0) + r.chars;
        }
      } else if (r.side) {
        // loads and compactions belong to the main thread
      } else if (r.k === 'compact') {
        compactions++; res.loads.compactions++; compacted = true;
      } else if (r.k === 'instructions') {
        sawIns = true;
        agents ||= r.paths.some((p) => p.endsWith('AGENTS.md'));
        claude ||= r.paths.some((p) => p.endsWith('CLAUDE.md'));
        if (compacted && r.reason === 'compaction') res.loads.reloaded++;
        compacted = false;
      }
    },
    endSession(s: SessionCtx) {
      if (s.id !== id) reset(s.id);
      const l = res.loads;
      l.sessions++; l.agentsMd += +agents; l.claudeMd += +claude; l.unknown += +!sawIns;
      res.sessions.push({ id: s.id, usage: cur, responses, compactions, peak });
      reset('');
    },
    result: () => res,
  };
}

/** The always-loaded rows, one per source, from the offline context set (estimate). */
export function alwaysLoaded(root: string, dirs: { templates: string; plugin: string }): { id: string; tokens: number | null }[] {
  return contextSet(root, loadConfig(root).config, dirs).always.map(({ label, tokens }) => ({ id: label, tokens }));
}
