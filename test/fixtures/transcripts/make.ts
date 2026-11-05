import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Synthetic Claude Code transcript records in the shapes of spec §3.2. Never copy a real transcript in here.
type Rec = Record<string, unknown>;
let n = 0;

export interface AssistantOpts { id?: string; requestId?: string; model?: string; usage?: unknown; content?: unknown; [top: string]: unknown }
export const assistant = (o: AssistantOpts = {}): Rec => {
  const usage0 = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 100 };
  const { id = `msg_${++n}`, requestId = `req_${n}`, model = 'claude-test-1', content = [{ type: 'text', text: 'ok' }], usage = usage0, ...top } = o;
  return { type: 'assistant', requestId, message: { id, type: 'message', role: 'assistant', model, content, usage }, ...top };
};

export const prompt = (text: string, o: Rec = {}): Rec => ({ type: 'user', message: { role: 'user', content: text }, ...o });

export interface ResultOpts { content?: unknown; isError?: boolean; permissionDecision?: unknown; [top: string]: unknown }
export const toolResult = (useId: string, o: ResultOpts = {}): Rec => {
  const { content = 'done', isError = false, ...top } = o;
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, is_error: isError, content }] }, ...top };
};

export const attachment = (type: string, fields: Rec, o: Rec = {}): Rec => ({ type: 'attachment', attachment: { type, ...fields }, ...o });

export const system = (subtype: string, fields: Rec = {}, o: Rec = {}): Rec => ({ type: 'system', subtype, ...fields, ...o });

const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const fill = (id: string, recs: object[], side: boolean) =>
  recs.map((r, i) => JSON.stringify({ sessionId: id, version: '2.1.317', cwd: '/repo', isSidechain: side, uuid: `u${i}`, timestamp: new Date(T0 + i * 1000).toISOString(), ...r })).join('\n') + '\n';

/** Writes `<dir>/<id>.jsonl` and any subagent files at `<dir>/<id>/subagents/agent-<k>.jsonl`; returns the main file path. */
export const writeSession = (dir: string, id: string, recs: object[], opts: { subagents?: Record<string, object[]> } = {}): string => {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, fill(id, recs, false));
  for (const [k, sub] of Object.entries(opts.subagents ?? {})) {
    mkdirSync(join(dir, id, 'subagents'), { recursive: true });
    writeFileSync(join(dir, id, 'subagents', `agent-${k}.jsonl`), fill(id, sub, true));
  }
  return file;
};
