import { describe, expect, it } from 'vitest';
import type { SessionCtx } from '../../src/report/acc.js';
import { alwaysLoaded, usageAcc } from '../../src/report/metrics/usage.js';
import { parseRecords, type TRec } from '../../src/report/transcript.js';
import { assistant, attachment, system, toolResult } from '../fixtures/transcripts/make.js';

const recs = (...rs: object[]): TRec[] => rs.flatMap((r) => parseRecords(JSON.stringify({ timestamp: '2026-11-01T00:00:00.000Z', ...r })));
const u = (input: number, cw: number, cr: number, out: number) => ({ input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out });
const ctx = (id = 's1'): SessionCtx => ({ id, turns: 0, compactions: 0, edited: [] });
const run = (rs: TRec[], id = 's1') => {
  const a = usageAcc(), s = ctx(id);
  rs.forEach((r) => a.rec!(s, r));
  a.endSession!(s);
  return a.result();
};

describe('usageAcc', () => {
  it('keeps the four numbers separate', () => {
    const r = run(recs(assistant({ usage: u(10, 100, 1000, 5) })));
    expect(r.total).toEqual({ input: 10, cacheWrite: 100, cacheRead: 1000, output: 5 });
    expect(r.responses).toBe(1);
  });
  it('counts a repeated key once and a null key as unknown', () => {
    const a = assistant({ id: 'm1', requestId: 'r1', usage: u(1, 0, 0, 1) });
    const r = run(recs(a, a, { type: 'assistant', message: { content: [], usage: u(2, 0, 0, 0) } }));
    expect(r.responses).toBe(2);
    expect(r.unknown).toBe(1);
    expect(r.total.input).toBe(3);
  });
  it('treats a response with no usable usage as unknown, not zero', () => {
    const r = run(recs(assistant({ usage: { input_tokens: 'x' } })));
    expect(r).toMatchObject({ responses: 0, unknown: 1 });
  });
  it('takes the peak as the largest input + cache write + cache read', () => {
    const r = run(recs(assistant({ usage: u(10, 20, 30, 999) }), assistant({ usage: u(1, 2, 3, 0) })));
    expect(r.sessions[0]).toMatchObject({ id: 's1', peak: 60, responses: 2 });
  });
  it('sends subagent usage to sub and groups by day and model', () => {
    const rs = [...recs(assistant({ usage: u(1, 0, 0, 0), model: 'm-a' })), ...recs(assistant({ usage: u(5, 0, 0, 0), model: 'm-b' })).map((r) => ({ ...r, side: true }))];
    const r = run(rs);
    expect([r.main.input, r.sub.input, r.total.input]).toEqual([1, 5, 6]);
    expect(r.byDay['2026-11-01']!.input).toBe(6);
    expect(r.byModel['m-b']!.input).toBe(5);
  });
  it('reads loads from instructions records', () => {
    const ins = (path: string, reason?: string) => attachment('instructions', { files: [{ path }], ...(reason ? { reason } : {}) });
    const a = usageAcc();
    const s1 = ctx('s1'), s2 = ctx('s2'), s3 = ctx('s3');
    for (const r of recs(ins('/repo/AGENTS.md'), ins('/repo/CLAUDE.md'), system('compact_boundary'), ins('/repo/AGENTS.md', 'compaction'))) a.rec!(s1, r);
    a.endSession!(s1);
    for (const r of recs(assistant())) a.rec!(s2, r);
    a.endSession!(s2);
    for (const r of recs(system('compact_boundary'))) a.rec!(s3, r);
    a.endSession!(s3);
    expect(a.result().loads).toEqual({ sessions: 3, agentsMd: 1, claudeMd: 1, unknown: 2, compactions: 2, reloaded: 1 });
  });
  it('sums result chars by the name of the tool with that id', () => {
    const use = (id: string, name: string) => assistant({ content: [{ type: 'tool_use', id, name, input: {} }] });
    const r = run(recs(use('a', 'Bash'), use('b', 'Read'), toolResult('a', { content: 'xxxx' }), toolResult('b', { content: 'yy' }), toolResult('a', { content: 'zz' }), toolResult('zz', { content: 'q' })));
    expect(r.toolChars).toEqual({ Bash: 6, Read: 2 });
  });
});

describe('alwaysLoaded', () => {
  it('lists catalog items plus AGENTS.md and CLAUDE.md estimates', () => {
    const rows = alwaysLoaded('/nonexistent-root', { templates: '/nonexistent-t', plugin: '/nonexistent-p' });
    expect(rows.map((x) => x.id)).toEqual(expect.arrayContaining(['harness-plugin', 'AGENTS.md', 'CLAUDE.md']));
  });
});
