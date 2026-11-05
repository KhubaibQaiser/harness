import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(ts[0]!.dropped).toEqual({ texts: 0, tools: 700, results: 0 });
  });
});

describe('runSession subagents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-sub-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // writeSession stamps record i at T0 + i seconds, so the timeline below is fixed.
  it('puts a subagent tool call into the turn open at its timestamp, and drops one outside every turn', async () => {
    const T0 = Date.parse('2026-11-01T00:00:00.000Z');
    const at = (sec: number, r: object) => ({ ...r, timestamp: new Date(T0 + sec * 1000).toISOString() });
    const main = writeSession(dir, 's2', [prompt('a'), assistant(), assistant(), prompt('b'), assistant()]);
    mkdirSync(join(dir, 's2', 'subagents'), { recursive: true });
    const sub = [at(-5, use('early')), at(1.5, use('mid')), at(1.6, toolResult('mid')), at(3.5, use('late'))].map((r) => JSON.stringify({ isSidechain: true, ...r })).join('\n') + '\n';
    writeFileSync(join(dir, 's2', 'subagents', 'agent-z.jsonl'), sub);
    const got: Turn[] = [];
    const acc: Acc<null> = { turn: (_s, t) => got.push(t), result: () => null };
    await runSession({ main, subagents: [join(dir, 's2', 'subagents', 'agent-z.jsonl')] }, 's2', [acc], 0);
    expect(got.map((t) => t.tools.map((x) => x.id))).toEqual([['mid'], ['late']]);
    expect(got[0]!.subResults.has('mid')).toBe(true);
    expect(got[0]!.results.has('mid')).toBe(false);
  });
});

describe('runSession subagent placement edges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-edge-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const T0 = Date.parse('2026-11-01T00:00:00.000Z');
  const sub = (name: string, recs: object[]) => {
    mkdirSync(join(dir, name, 'subagents'), { recursive: true });
    const f = join(dir, name, 'subagents', 'agent-e.jsonl');
    writeFileSync(f, recs.map((r) => JSON.stringify({ isSidechain: true, ...r })).join('\n') + '\n');
    return f;
  };
  const run = async (id: string, mainRecs: object[], subRecs: object[]) => {
    const main = writeSession(dir, id, mainRecs);
    const got: Turn[] = [];
    const stats = await runSession({ main, subagents: [sub(id, subRecs)] }, id, [{ turn: (_s, t) => got.push(t), result: () => null } as Acc<null>], 0);
    return { got, stats };
  };
  const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();
  it('gives a call at exactly a prompt time to the turn that prompt starts', async () => {
    const { got } = await run('e1', [prompt('a'), assistant(), prompt('b')], [{ ...use('tie'), timestamp: iso(2) }]);
    expect(got.map((t) => t.tools.map((x) => x.id))).toEqual([[], ['tie']]);
  });
  it('leaves a timeless subagent call out of every turn; the reader counts it in noTime', async () => {
    const { got, stats } = await run('e2', [prompt('a'), assistant()], [use('nt')]);
    expect(got[0]!.tools).toEqual([]);
    expect(stats.noTime).toBe(1);
  });
  it('never puts a timeless main prompt or subagent call in the wrong turn', async () => {
    const main = writeSession(dir, 'e3', [prompt('a'), assistant(), prompt('b'), assistant(), prompt('c')]);
    const lines = readFileSync(main, 'utf8').split('\n');
    lines[2] = lines[2]!.replace(/"timestamp":"[^"]*"/, '"timestamp":"bad"'); // prompt b has no time: the reader drops it
    writeFileSync(main, lines.join('\n'));
    const got: Turn[] = [];
    const stats = await runSession({ main, subagents: [sub('e3', [{ ...use('q'), timestamp: iso(2.5) }, use('nt')])] }, 'e3', [{ turn: (_s: unknown, t: Turn) => got.push(t), result: () => null } as Acc<null>], 0);
    expect(got.map((t) => t.tools.map((x) => x.id))).toEqual([['q'], []]); // q by time into the open turn; the timeless one nowhere
    expect(stats.noTime).toBe(2);
    expect(stats.unplaced).toBe(0);
  });
  it('bounds what a summary keeps: 50 tools per record, 20000 in all, the rest in subDropped', async () => {
    const many = (n: number) => assistant({ content: Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `m${i}`, name: 'Bash', input: {} })) });
    const { got, stats } = await run('e4', [prompt('a')], [{ ...many(80), timestamp: iso(1) }]);
    expect(got[0]!.tools).toHaveLength(50);
    expect(stats.subDropped).toBe(30);
    const recs = Array.from({ length: 500 }, (_, i) => ({ ...many(50), timestamp: iso(1 + i / 1000) }));
    const big = await run('e5', [prompt('a')], recs);
    expect(big.got[0]!.tools).toHaveLength(500); // the turn's own cap
    expect(big.got[0]!.dropped.tools).toBe(19500);
    expect(big.stats.subDropped).toBe(5000);
  });
});

describe('runSession subagent cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'turns-cap-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  it('counts subagent records left out past the cap', async () => {
    const main = writeSession(dir, 's3', [prompt('a'), assistant()], { subagents: { q: Array.from({ length: 5003 }, (_, i) => use(`u${i}`)) } });
    let seen = -1;
    const acc: Acc<null> = { endSession: (s) => (seen = s.subDropped ?? -1), result: () => null };
    const stats = await runSession({ main, subagents: [join(dir, 's3', 'subagents', 'agent-q.jsonl')] }, 's3', [acc], 0);
    expect([stats.subDropped, seen]).toEqual([3, 3]);
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
