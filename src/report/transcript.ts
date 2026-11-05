import { createReadStream } from 'node:fs';

// Streaming reader for Claude Code session transcripts (JSONL, undocumented format, spec §3.2).
// Transcripts are untrusted: every field is type-checked, and a wrong or missing one gives unknown, never a pass.

export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface ToolUse { id: string; name: string; skill?: string; filePath?: string; command?: string; ask?: { options: number; recommended: boolean } }
type Base = { ts: number; side: boolean; version?: string; cwd?: string };
export type TRec = Base & (
  | { k: 'assistant'; key: string | null; model?: string; usage?: Usage; texts: string[]; tools: ToolUse[] }
  | { k: 'prompt'; text: string }
  | { k: 'result'; useId: string; isError: boolean; chars: number; text: string; permission?: { decision: string; source: string } }
  | { k: 'listing'; names: string[] }
  | { k: 'invoked'; names: string[] }
  | { k: 'instructions'; paths: string[]; reason: string | null }
  | { k: 'hook'; event: string; command: string; ms: number | null; timedOut: boolean; useId?: string }
  | { k: 'compact' }
  | { k: 'stop'; prevented: boolean | null }
  | { k: 'other'; type: string }
  | { k: 'bad'; why: 'json' | 'too-long' | 'shape' }
);

export const MAX_LINE = 16 * 1024 * 1024;
export const TESTED = { min: '2.1.286', max: '2.1.317' };
const TEXT_CAP = 64 * 1024; // result text kept for number matching; chars keeps the full length
// Record types no metric reads. A line holding `"type":"<x>"` unescaped is one of these, unless it also holds a used type's marker.
const UNUSED = ['queue-operation', 'file-history-snapshot', 'last-prompt', 'custom-title', 'agent-name', 'atis-latch', 'cost-state', 'mode', 'pr-link'];
const USED = ['assistant', 'user', 'attachment', 'system'].map((t) => `"type":"${t}"`);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown[]): string[] => v.filter((x): x is string => typeof x === 'string');
const NO_BASE: Base = { ts: NaN, side: false };

const usage = (u: Obj | undefined): Usage | undefined => {
  const [input, output, cacheWrite, cacheRead] = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map((f) => num(u?.[f]));
  return input === undefined || output === undefined || cacheWrite === undefined || cacheRead === undefined ? undefined : { input, output, cacheWrite, cacheRead };
};

const toolUse = (b: Obj): ToolUse | undefined => {
  const id = str(b.id), name = str(b.name), input = obj(b.input);
  if (id === undefined || name === undefined) return undefined;
  const t: ToolUse = { id, name };
  if (name === 'Skill' && str(input?.skill) !== undefined) t.skill = str(input?.skill);
  if (str(input?.file_path) !== undefined) t.filePath = str(input?.file_path);
  if (str(input?.command) !== undefined) t.command = str(input?.command);
  if (name === 'AskUserQuestion' && Array.isArray(input?.questions)) {
    const labels = input.questions.flatMap((q) => arr(obj(q)?.options).map((o) => str(obj(o)?.label) ?? ''));
    t.ask = { options: labels.length, recommended: labels.some((l) => l.includes('(Recommended)')) };
  }
  return t;
};

const assistantRec = (r: Obj) => {
  const m = obj(r.message), id = str(m?.id), req = str(r.requestId);
  const blocks = arr(m?.content).map(obj).filter((b): b is Obj => b !== undefined);
  const texts = strs(blocks.filter((b) => b.type === 'text').map((b) => b.text));
  const tools = blocks.filter((b) => b.type === 'tool_use').map(toolUse).filter((t): t is ToolUse => t !== undefined);
  return { k: 'assistant' as const, key: id !== undefined && req !== undefined ? `${id}|${req}` : null, model: str(m?.model), usage: usage(obj(m?.usage)), texts, tools };
};

const blockText = (c: unknown): string => (typeof c === 'string' ? c : strs(arr(c).map((b) => obj(b)?.text)).join('\n'));

const userRec = (r: Obj) => {
  const content = obj(r.message)?.content;
  if (typeof content === 'string') return { k: 'prompt' as const, text: content };
  if (!Array.isArray(content)) return undefined;
  // ponytail: one tool_result per user record is the observed shape; extra results in the same record are not read.
  const tr = content.map(obj).find((b) => b?.type === 'tool_result');
  if (tr === undefined) return { k: 'prompt' as const, text: blockText(content) };
  const useId = str(tr.tool_use_id);
  if (useId === undefined) return undefined;
  const full = blockText(tr.content), pd = obj(r.permissionDecision), decision = str(pd?.decision), source = str(pd?.source);
  return { k: 'result' as const, useId, isError: tr.is_error === true, chars: full.length, text: full.slice(0, TEXT_CAP), permission: decision !== undefined && source !== undefined ? { decision, source } : undefined };
};

const attachmentRec = (a: Obj | undefined) => {
  const t = str(a?.type);
  if (a === undefined || t === undefined) return undefined;
  if (t === 'skill_listing') return { k: 'listing' as const, names: strs(arr(a.names)) };
  if (t === 'invoked_skills') return { k: 'invoked' as const, names: strs(arr(a.skills).map((s) => obj(s)?.name)) };
  if (t === 'instructions') return { k: 'instructions' as const, paths: strs(arr(a.files).map((f) => obj(f)?.path)), reason: str(a.reason) ?? null };
  if (t === 'hook_success' || t === 'hook_cancelled') {
    return { k: 'hook' as const, event: str(a.hookEvent) ?? '', command: str(a.command) ?? '', ms: num(a.durationMs) ?? null, timedOut: a.timedOut === true, useId: str(a.toolUseID) };
  }
  return { k: 'other' as const, type: `attachment:${t}` };
};

const systemRec = (r: Obj) => {
  if (r.subtype === 'compact_boundary') return { k: 'compact' as const };
  if (r.subtype === 'stop_hook_summary') return { k: 'stop' as const, prevented: typeof r.preventedContinuation === 'boolean' ? r.preventedContinuation : null };
  return { k: 'other' as const, type: `system:${str(r.subtype) ?? '?'}` };
};

export function parseLine(line: string): TRec {
  const unused = UNUSED.find((t) => line.includes(`"type":"${t}"`));
  if (unused !== undefined && !USED.some((m) => line.includes(m))) return { ...NO_BASE, k: 'other', type: unused };
  let r: Obj | undefined;
  try {
    r = obj(JSON.parse(line));
  } catch {
    return { ...NO_BASE, k: 'bad', why: 'json' };
  }
  const type = str(r?.type);
  if (r === undefined || type === undefined) return { ...NO_BASE, k: 'bad', why: 'shape' };
  const ts = str(r.timestamp), base: Base = { ts: ts === undefined ? NaN : Date.parse(ts), side: r.isSidechain === true, version: str(r.version), cwd: str(r.cwd) };
  const body =
    type === 'assistant' ? assistantRec(r)
    : type === 'user' ? userRec(r)
    : type === 'attachment' ? attachmentRec(obj(r.attachment))
    : type === 'system' ? systemRec(r)
    : { k: 'other' as const, type };
  return body === undefined ? { ...base, k: 'bad', why: 'shape' } : { ...base, ...body };
}

export interface ReadStats { lines: number; bad: number; tooLong: number; versions: Set<string>; types: Record<string, number> }

const RAW: Record<string, string> = { assistant: 'assistant', prompt: 'user', result: 'user', listing: 'attachment', invoked: 'attachment', instructions: 'attachment', hook: 'attachment', compact: 'system', stop: 'system' };

/** Streams one transcript line by line. A line over MAX_LINE is discarded up to its newline without buffering it. */
export async function streamTranscript(path: string, visit: (r: TRec) => void, opts: { sinceMs?: number; side?: boolean } = {}): Promise<ReadStats> {
  const stats: ReadStats = { lines: 0, bad: 0, tooLong: 0, versions: new Set(), types: {} };
  const emit = (r: TRec) => {
    stats.lines++;
    if (r.k === 'bad') {
      stats.bad++;
      if (r.why === 'too-long') stats.tooLong++;
    } else if (opts.sinceMs !== undefined && r.ts < opts.sinceMs) return;
    else {
      const t = r.k === 'other' ? r.type.split(':')[0]! : RAW[r.k]!;
      stats.types[t] = (stats.types[t] ?? 0) + 1;
      if (r.version !== undefined) stats.versions.add(r.version);
    }
    visit(opts.side ? { ...r, side: true } : r);
  };
  const finish = (bufs: Buffer[]) => {
    const line = Buffer.concat(bufs).toString('utf8').replace(/\r$/, '');
    if (line.trim() !== '') emit(parseLine(line));
  };
  let pending: Buffer[] = [], size = 0, skipping = false;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
    let at = 0;
    for (let nl = chunk.indexOf(10, at); ; nl = chunk.indexOf(10, at)) {
      const end = nl === -1 ? chunk.length : nl;
      if (!skipping && size + end - at > MAX_LINE) {
        skipping = true;
        pending = [];
      }
      if (!skipping) {
        pending.push(chunk.subarray(at, end));
        size += end - at;
      }
      if (nl === -1) break;
      if (skipping) emit({ ...NO_BASE, k: 'bad', why: 'too-long' });
      else finish(pending);
      pending = [];
      size = 0;
      skipping = false;
      at = nl + 1;
    }
  }
  if (skipping) emit({ ...NO_BASE, k: 'bad', why: 'too-long' });
  else finish(pending);
  return stats;
}
