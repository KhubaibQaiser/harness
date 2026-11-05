import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bucketOf, type Acc } from '../../src/report/acc.js';
import { parseRecords, type TRec } from '../../src/report/transcript.js';
import { runSession, turnSplitter, type Turn } from '../../src/report/turns.js';
import { assistant, prompt, system, toolResult, writeSession } from '../fixtures/transcripts/make.js';

const recs = (...rs: object[]): TRec[] => rs.flatMap((r) => parseRecords(JSON.stringify({ timestamp: '2026-11-01T00:00:00.000Z', ...r })));
const split = (rs: TRec[]) => {
  const turns: Turn[] = [];
  const s = turnSplitter((t) => turns.push(t));
  rs.forEach((r) => s.push(r));
  s.end();
  return turns;
};
const use = (id: string, name = 'Bash', input: object = {}) => assistant({ content: [{ type: 'tool_use', id, name, input }] });

describe('bucketOf', () => {
  it('buckets turn numbers', () => {
    expect([1, 10, 11, 30, 31, 100, 101].map(bucketOf)).toEqual(['1-10', '1-10', '11-30', '11-30', '31-100', '31-100', '100+']);
  });
});

describe('turnSplitter', () => {
  it('puts a tool result into the turn of its tool use and numbers turns from 1', () => {
    const ts = split(recs(prompt('a'), use('t1'), toolResult('t1'), prompt('b'), assistant()));
    expect(ts.map((t) => t.index)).toEqual([1, 2]);
    expect(ts[0]!.results.has('t1')).toBe(true);
    expect(ts[0]!.tools.map((t) => t.id)).toEqual(['t1']);
    expect(ts[1]!.results.size).toBe(0);
    expect(ts[0]!.date).toBe('2026-11-01');
  });
  it('sets afterCompact on the turns after a compact', () => {
    const ts = split(recs(prompt('a'), system('compact_boundary'), prompt('b'), prompt('c')));
    expect(ts.map((t) => t.afterCompact)).toEqual([false, true, true]);
  });
  it('lets subagent records join the open turn without starting one', () => {
    const rs = [...recs(prompt('a')), ...recs(prompt('sub task'), use('s1')).map((r) => ({ ...r, side: true }))];
    const ts = split(rs);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.tools.map((t) => t.id)).toEqual(['s1']);
  });
  it('caps what one turn keeps', () => {
    const ts = split(recs(prompt('a'), ...Array.from({ length: 1200 }, (_, i) => use(`t${i}`))));
    expect(ts[0]!.tools.length).toBe(500);
  });
});

describe('runSession', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('feeds accumulators with records, turns and the session end, and keeps context', async () => {
    const main = writeSession(dir, 's1', [prompt('a'), use('t1', 'Edit', { file_path: '/repo/a.ts' }), toolResult('t1'), system('compact_boundary'), prompt('b')], { subagents: { x: [assistant()] } });
    const log: string[] = [];
    const acc: Acc<string[]> = {
      rec: (s, r) => log.push(`rec:${r.k}${r.side ? ':side' : ''}:${s.turns}`),
      turn: (s, t) => log.push(`turn:${t.index}:${s.compactions}`),
      endSession: (s) => log.push(`end:${s.id}:${s.turns}:${s.compactions}:${s.edited.join()}`),
      result: () => log,
    };
    const stats = await runSession({ main, subagents: [`${dir}/s1/subagents/agent-x.jsonl`] }, 's1', [acc], 0);
    expect(stats.lines).toBe(6);
    expect(log.at(-1)).toBe('end:s1:2:1:/repo/a.ts');
    expect(log).toContain('rec:assistant:side:2');
    expect(log.filter((l) => l.startsWith('turn:'))).toEqual(['turn:1:1', 'turn:2:1']);
  });
});
