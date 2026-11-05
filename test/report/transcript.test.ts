import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { MAX_LINE, type TRec, parseLine, parseRecords, streamTranscript } from '../../src/report/transcript.js';
import { assistant, attachment, prompt, system, toolResult, writeSession } from '../fixtures/transcripts/make.js';

const p = (r: object) => parseLine(JSON.stringify({ timestamp: '2026-11-01T00:00:00.000Z', version: '2.1.317', cwd: '/repo', ...r }));
const tool = (name: string, input: object) => assistant({ content: [{ type: 'tool_use', id: 't1', name, input }] });
const read = async (file: string, opts?: { sinceMs?: number; side?: boolean }) => {
  const recs: TRec[] = [];
  const stats = await streamTranscript(file, (r) => recs.push(r), opts);
  return { recs, stats };
};
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'tr-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const lines = (recs: object[]) => {
  const f = join(tmp(), 'x.jsonl');
  writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};

describe('parseLine maps spec §3.2 rows', () => {
  it('assistant: key, model, usage, texts and tools', () => {
    const r = p(assistant({ id: 'm1', requestId: 'r1', model: 'claude-x', isSidechain: true, content: [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: 'no' }] }));
    expect(r).toEqual({ k: 'assistant', ts: Date.parse('2026-11-01T00:00:00.000Z'), side: true, version: '2.1.317', cwd: '/repo', key: JSON.stringify(['m1', 'r1']), model: 'claude-x', usage: { input: 10, output: 5, cacheWrite: 2, cacheRead: 100 }, texts: ['hi'], tools: [] });
    const { requestId: _, ...noReq } = assistant();
    expect(p(noReq)).toMatchObject({ key: null });
  });
  it('Skill, Edit, Bash tool_use fields', () => {
    expect(p(tool('Skill', { skill: 'tdd' }))).toMatchObject({ tools: [{ id: 't1', name: 'Skill', skill: 'tdd' }] });
    expect(p(tool('Edit', { file_path: '/repo/a.ts' }))).toMatchObject({ tools: [{ name: 'Edit', filePath: '/repo/a.ts' }] });
    expect(p(tool('Bash', { command: 'pnpm test' }))).toMatchObject({ tools: [{ name: 'Bash', command: 'pnpm test' }] });
  });
  it('AskUserQuestion counts options and spots (Recommended)', () => {
    const options = [{ label: 'Use X (Recommended)' }, { label: 'Use Y' }, { label: 'Use Z' }];
    expect(p(tool('AskUserQuestion', { questions: [{ question: 'q', options }] }))).toMatchObject({ tools: [{ ask: { options: 3, recommended: true } }] });
    expect(p(tool('AskUserQuestion', { questions: [{ options: options.slice(1) }] }))).toMatchObject({ tools: [{ ask: { options: 2, recommended: false } }] });
    // Spec §4.2: /recommend/i on a label or a description; options per question (the largest), never summed.
    expect(p(tool('AskUserQuestion', { questions: [{ options: [{ label: 'A', description: 'I recommend this' }, { label: 'B' }] }] }))).toMatchObject({ tools: [{ ask: { options: 2, recommended: true } }] });
    expect(p(tool('AskUserQuestion', { questions: [{ options: [{ label: 'A (recommended)' }] }] }))).toMatchObject({ tools: [{ ask: { recommended: true } }] });
    expect(p(tool('AskUserQuestion', { questions: [{ options: [{ label: 'A' }] }, { options: [{ label: 'B' }] }] }))).toMatchObject({ tools: [{ ask: { options: 1 } }] });
  });
  it('a tool_use with no usable id or name is kept and marked malformed, not dropped', () => {
    const r = p(assistant({ content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }, { type: 'tool_use', id: 't2', input: {} }, { type: 'tool_use', id: 't3', name: 'Read', input: {} }] }));
    expect(r).toMatchObject({ tools: [{ id: '', name: 'Bash', command: 'git push', malformed: true }, { id: 't2', name: '', malformed: true }, { id: 't3', name: 'Read' }] });
    expect(r.k === 'assistant' && r.tools[2]!.malformed).toBeUndefined();
  });
  it('the de-dup key cannot collide across the separator', () => {
    expect(p(assistant({ id: 'a|b', requestId: 'c' }))).not.toMatchObject({ key: (p(assistant({ id: 'a', requestId: 'b|c' })) as { key: string }).key });
  });
  it('isMeta user records are other, not prompts', () => {
    expect(p(prompt('injected skill body', { isMeta: true }))).toMatchObject({ k: 'other', type: 'meta' });
    expect(p(prompt('real', { isMeta: false }))).toMatchObject({ k: 'prompt' });
  });
  it('user: string content is a prompt, tool_result blocks are a result', () => {
    expect(p(prompt('do it'))).toMatchObject({ k: 'prompt', text: 'do it' });
    const perm = { decision: 'reject', source: 'hook' };
    expect(p(toolResult('t1', { isError: true, content: [{ type: 'text', text: 'abc' }], permissionDecision: perm }))).toMatchObject({ k: 'result', useId: 't1', isError: true, chars: 3, text: 'abc', permission: perm });
    const big = p(toolResult('t2', { content: 'x'.repeat(100_000) }));
    expect(big).toMatchObject({ k: 'result', chars: 100_000, permission: undefined });
    expect(big.k === 'result' && big.text.length).toBe(64 * 1024);
  });
  it('every tool_result block in one user record is its own result', () => {
    const two = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }, { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'yy' }] } };
    const recs = parseRecords(JSON.stringify(two));
    expect(recs).toEqual([expect.objectContaining({ k: 'result', useId: 'a', isError: false, chars: 1 }), expect.objectContaining({ k: 'result', useId: 'b', isError: true, chars: 2 })]);
    expect(parseLine(JSON.stringify(two))).toMatchObject({ useId: 'a' });
  });
  it('attachments', () => {
    expect(p(attachment('skill_listing', { names: ['a', 'b'], skillCount: 2 }))).toMatchObject({ k: 'listing', names: ['a', 'b'] });
    expect(p(attachment('invoked_skills', { skills: [{ name: 'a' }] }))).toMatchObject({ k: 'invoked', names: ['a'] });
    expect(p(attachment('instructions', { files: [{ path: 'AGENTS.md' }], reason: 'compaction' }))).toMatchObject({ k: 'instructions', paths: ['AGENTS.md'], reason: 'compaction' });
    expect(p(attachment('instructions', { files: [] }))).toMatchObject({ reason: null });
    expect(p(attachment('hook_success', { hookEvent: 'PreToolUse', command: 'node .harness/hooks/dispatch.mjs', durationMs: 42, exitCode: 0, toolUseID: 't1' })))
      .toEqual(expect.objectContaining({ k: 'hook', event: 'PreToolUse', command: 'node .harness/hooks/dispatch.mjs', ms: 42, timedOut: false, useId: 't1' }));
    expect(p(attachment('hook_cancelled', { hookEvent: 'Stop', command: 'x', durationMs: 'slow', timedOut: true, timeoutMs: 60000 }))).toMatchObject({ k: 'hook', ms: null, timedOut: true });
    expect(p(attachment('nested_memory', { content: 'secret' }))).toMatchObject({ k: 'other', type: 'attachment:nested_memory' });
  });
  it('system records', () => {
    expect(p(system('compact_boundary'))).toMatchObject({ k: 'compact' });
    expect(p(system('stop_hook_summary', { preventedContinuation: true }))).toMatchObject({ k: 'stop', prevented: true });
    expect(p(system('stop_hook_summary'))).toMatchObject({ k: 'stop', prevented: null });
  });
  it('unused types are other without parsing, unknown types are other', () => {
    expect(parseLine('{"type":"file-history-snapshot","snapshot":{ not json')).toMatchObject({ k: 'other', type: 'file-history-snapshot' });
    expect(p({ type: 'brand-new' })).toMatchObject({ k: 'other', type: 'brand-new' });
    // A used record that merely mentions an unused type is still parsed for what it is.
    expect(p(tool('Bash', { command: 'echo {"type":"mode"}' }))).toMatchObject({ k: 'assistant' });
  });
  it('unknown, not pass: wrong types never throw and never invent values', () => {
    expect(p(assistant({ usage: { input_tokens: 3, output_tokens: 4 } }))).toMatchObject({ usage: { input: 3, output: 4, cacheWrite: 0, cacheRead: 0 } });
    expect(p(assistant({ usage: { input_tokens: 3 } }))).toMatchObject({ usage: undefined });
    expect(p(assistant({ usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: null, cache_read_input_tokens: null } }))).toMatchObject({ usage: { cacheWrite: 0, cacheRead: 0 } });
    expect(p(assistant({ usage: { input_tokens: -1, output_tokens: 4 } }))).toMatchObject({ usage: undefined });
    expect(p(assistant({ usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 'x' } }))).toMatchObject({ usage: undefined });
    expect(p(assistant({ usage: { input_tokens: '10', output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }))).toMatchObject({ k: 'assistant', usage: undefined });
    const noContent = p({ type: 'assistant', message: { id: 'm', model: 3 } });
    expect(noContent).toMatchObject({ k: 'assistant', texts: [], tools: [], model: undefined, key: null });
    expect(p({ type: 'assistant', message: { content: [null, 7, { type: 'tool_use', name: 5 }] } })).toMatchObject({ texts: [], tools: [{ id: '', name: '', malformed: true }] });
    expect(parseLine('{"type":"user"}')).toMatchObject({ k: 'bad', why: 'shape' });
    expect(parseLine('[1,2]')).toMatchObject({ k: 'bad', why: 'shape' });
    expect(parseLine('{"type":')).toMatchObject({ k: 'bad', why: 'json', ts: NaN });
    expect(p({ type: 'user', timestamp: 7, message: { content: 'x' } })).toMatchObject({ ts: NaN });
  });
});

describe('streamTranscript', () => {
  it('a half-written last line is bad, every earlier record is read (review focus 1)', async () => {
    const file = writeSession(tmp(), 's1', [prompt('a'), assistant(), toolResult('t1')]);
    appendFileSync(file, '{"type":"assistant","message":{"id":"m');
    const { recs, stats } = await read(file);
    expect(recs.map((r) => r.k)).toEqual(['prompt', 'assistant', 'result', 'bad']);
    expect(stats).toMatchObject({ lines: 4, bad: 1, tooLong: 0, types: { user: 2, assistant: 1 } });
    const f2 = writeSession(tmp(), 's4', [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }, { type: 'tool_result', tool_use_id: 'b' }] } }]);
    const two = await read(f2, { side: true });
    expect(two.recs.map((r) => r.k === 'result' && r.side && r.useId)).toEqual(['a', 'b']);
    expect(two.stats).toMatchObject({ lines: 1, types: { user: 1 } });
  });
  it('drops a line over MAX_LINE and parses the next one', async () => {
    const file = join(tmp(), 'big.jsonl');
    writeFileSync(file, JSON.stringify(prompt('a')) + '\n{"type":"user","message":{"content":"' + 'x'.repeat(17 * 1024 * 1024) + '"}}\r\n' + JSON.stringify(prompt('b')) + '\r\n\n');
    expect(17 * 1024 * 1024).toBeGreaterThan(MAX_LINE);
    const { recs, stats } = await read(file);
    expect(recs).toEqual([expect.objectContaining({ k: 'prompt', text: 'a' }), expect.objectContaining({ k: 'bad', why: 'too-long' }), expect.objectContaining({ k: 'prompt', text: 'b' })]);
    expect(stats).toMatchObject({ lines: 3, bad: 1, tooLong: 1 });
  });
  it('prototype-named types are counted as plain keys', async () => {
    const { stats } = await read(lines([{ type: 'constructor' }, { type: '__proto__' }, { type: 'toString' }, { type: 'toString' }]));
    expect(Object.entries(stats.types).sort()).toEqual([['__proto__', 1], ['constructor', 1], ['toString', 2]]);
    expect(Object.getPrototypeOf(stats.types)).toBeNull();
  });
  it('hostile versions and types stay bounded', async () => {
    const recs = Array.from({ length: 200 }, (_, i) => ({ type: `t${i}`.padEnd(100_000, 'x'), version: `${i}`.padEnd(100_000, 'v') }));
    const { stats } = await read(lines(recs));
    expect(stats.versions.size).toBeLessThanOrEqual(32);
    expect(Object.keys(stats.types).length).toBeLessThanOrEqual(64);
    expect([...stats.versions, ...Object.keys(stats.types)].every((v) => v.length <= 64)).toBe(true);
    expect(stats.versions.has('other') && stats.types.other).toBeGreaterThan(0);
    expect(Object.values(stats.types).reduce((a, b) => a + b, 0)).toBe(200);
  });
  it('a huge AskUserQuestion line neither throws nor rejects the stream', async () => {
    const questions = Array.from({ length: 300_000 }, () => ({ options: [{ label: 'a' }] }));
    questions[10]!.options.push({ label: 'b' }, { label: 'c (recommended)' });
    const { recs, stats } = await read(lines([assistant({ content: [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { questions } }] }), prompt('next')]));
    expect(recs).toEqual([expect.objectContaining({ tools: [expect.objectContaining({ ask: { options: 3, recommended: true } })] }), expect.objectContaining({ k: 'prompt' })]);
    expect(stats.bad).toBe(0);
  });
  it('an unexpected throw while extracting one line gives bad/shape and the stream goes on', async () => {
    const spy = vi.spyOn(Date, 'parse').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    try {
      const { recs, stats } = await read(lines([prompt('a', { timestamp: '2026-11-01T00:00:00.000Z' }), prompt('b', { timestamp: '2026-11-01T00:00:01.000Z' })]));
      expect(recs).toEqual([expect.objectContaining({ k: 'bad', why: 'shape' }), expect.objectContaining({ k: 'prompt', text: 'b' })]);
      expect(stats.bad).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('a leading BOM is stripped', async () => {
    const f = join(tmp(), 'bom.jsonl');
    writeFileSync(f, '\uFEFF' + JSON.stringify(prompt('a')) + '\n');
    expect((await read(f)).recs).toEqual([expect.objectContaining({ k: 'prompt' })]);
  });
  it('records with no timestamp are left out of a sinceMs window and counted', async () => {
    const f = lines([{ type: 'user', message: { content: 'no time' } }, { type: 'mode', mode: 'x' }, { ...prompt('in'), timestamp: '2026-11-01T00:00:00.000Z' }]);
    const { recs, stats } = await read(f, { sinceMs: 0 });
    expect(recs.map((r) => r.k)).toEqual(['prompt']);
    expect(stats.noTime).toBe(2);
    expect((await read(f)).stats.noTime).toBe(0);
  });
  it('collects versions, counts types, applies sinceMs and side', async () => {
    const dir = tmp();
    const file = writeSession(dir, 's2', [prompt('old', { timestamp: '2026-10-01T00:00:00.000Z' }), prompt('new', { version: '2.1.400' }), { type: 'queue-operation' }]);
    const all = await read(file);
    expect([...all.stats.versions].sort()).toEqual(['2.1.317', '2.1.400']);
    expect(all.stats.types).toEqual({ user: 2, 'queue-operation': 1 });
    const since = await read(file, { sinceMs: Date.parse('2026-10-15T00:00:00.000Z') });
    expect(since.recs.filter((r) => r.k === 'prompt').map((r) => r.k === 'prompt' && r.text)).toEqual(['new']);
    writeSession(dir, 's3', [], { subagents: { a1: [prompt('sub')] } });
    const sub = await read(join(dir, 's3', 'subagents', 'agent-a1.jsonl'), { side: true });
    expect(sub.recs).toEqual([expect.objectContaining({ k: 'prompt', side: true })]);
  });
});
