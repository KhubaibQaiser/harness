import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { contextSet } from '../../src/budget/summary.js';
import { loadConfig } from '../../src/core/config.js';
import { describe, expect, it } from 'vitest';
import type { SessionCtx } from '../../src/report/acc.js';
import { alwaysLoaded, alwaysLoadedSafe, usageAcc } from '../../src/report/metrics/usage.js';
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

describe('usageAcc bounds and main-thread rules', () => {
  const side = (rs: TRec[]) => rs.map((r) => ({ ...r, side: true }));
  it('folds models, tools and days past the cap into other, and a missing time into unknown', () => {
    const rs = Array.from({ length: 80 }, (_, i) => assistant({ model: `m${i}`, content: [{ type: 'tool_use', id: `t${i}`, name: `Tool${i}`, input: {} }] }));
    const r = run([...recs(...rs, ...rs.map((_, i) => toolResult(`t${i}`, { content: 'ab' }))), ...parseRecords(JSON.stringify(assistant()))]);
    expect(Object.keys(r.byModel).length).toBeLessThanOrEqual(65);
    expect(r.byModel['other']!.input).toBeGreaterThan(0);
    expect(Object.keys(r.toolChars).length).toBeLessThanOrEqual(65);
    expect(r.toolChars['other']).toBeGreaterThan(0);
    expect(r.byDay['unknown']!.input).toBe(10);
  });
  it('folds days past the cap into other', () => {
    const rs = Array.from({ length: 410 }, (_, i) => parseRecords(JSON.stringify({ timestamp: new Date(Date.parse('2024-01-01') + i * 86_400_000).toISOString(), ...assistant() }))[0]!);
    const r = run(rs);
    expect(Object.keys(r.byDay).length).toBe(401);
    expect(r.byDay['other']!.input).toBe(100);
  });
  it('stops remembering keys past the dedup cap without growing', () => {
    const a = usageAcc(), s = ctx();
    for (let i = 0; i < 500_100; i++) a.rec!(s, { ts: 0, side: false, k: 'assistant', key: `k${i}`, texts: [], tools: [], usage: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 } });
    a.endSession!(s);
    expect(a.result().responses).toBe(500_100);
  });
  it('ignores subagent instructions and compactions for loads, and subagent responses for peak', () => {
    const rs = [...recs(assistant({ usage: u(1, 1, 1, 0) })), ...side(recs(attachment('instructions', { files: [{ path: '/r/AGENTS.md' }] }), system('compact_boundary'), assistant({ usage: u(50, 50, 50, 0) })))];
    const r = run(rs);
    expect(r.loads).toMatchObject({ agentsMd: 0, unknown: 1, compactions: 0 });
    expect(r.sessions[0]).toMatchObject({ peak: 3, compactions: 0, responses: 2 });
  });
});

describe('alwaysLoaded', () => {
  it('returns no rows and a path-free note when the manifest is corrupt', () => {
    const root = mkdtempSync(join(tmpdir(), 'al-'));
    mkdirSync(join(root, '.harness'));
    writeFileSync(join(root, '.harness/manifest.json'), '{not json');
    const r = alwaysLoadedSafe(root, { templates: '/nonexistent-t', plugin: '/nonexistent-p' });
    rmSync(root, { recursive: true });
    expect(r.rows).toEqual([]);
    expect(r.note).toMatch(/^always-loaded sources not measured: /);
    expect(r.note).not.toContain(root);
    expect(r.note).not.toContain('manifest.json');
  });
  const dirs = { templates: '/nonexistent-t', plugin: '/nonexistent-p' };
  const repo = (files: Record<string, string | null>) => {
    const root = mkdtempSync(join(tmpdir(), 'al-'));
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      if (t === null) mkdirSync(join(root, f)); else writeFileSync(join(root, f), t);
    }
    return root;
  };
  it('counts an unreadable AGENTS.md (a directory) as 0 instead of throwing', () => {
    const root = repo({ 'AGENTS.md': null, 'CLAUDE.md': 'x'.repeat(40) });
    const rows = alwaysLoaded(root, dirs), total = contextSet(root, loadConfig(root).config, dirs).total;
    rmSync(root, { recursive: true });
    expect(rows.find((x) => x.id === 'AGENTS.md')?.tokens ?? 0).toBe(0);
    expect(rows.find((x) => x.id === 'CLAUDE.md')?.tokens).toBe(10);
    expect(rows.reduce((n, x) => n + (x.tokens ?? 0), 0)).toBe(total);
  });
  it('is one row per source: the harness block once, sum equals the context set total', () => {
    const root = repo({ 'AGENTS.md': 'plain notes '.repeat(20), '.claude/rules/private.md': 'rule text '.repeat(10) });
    const rows = alwaysLoaded(root, dirs);
    const set = contextSet(root, loadConfig(root).config, dirs);
    rmSync(root, { recursive: true });
    expect(rows).toEqual(set.always.map((e) => ({ id: e.label, tokens: e.tokens, owner: e.owner })));
    expect(rows.reduce((n, x) => n + (x.tokens ?? 0), 0)).toBe(set.total);
    expect(rows.filter((x) => x.id === 'AGENTS.md')).toHaveLength(1);
    expect(rows.length).toBe(new Set(rows.map((x) => x.id)).size);
  });
});
