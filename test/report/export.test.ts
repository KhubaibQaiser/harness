import { describe, expect, it } from 'vitest';
import { buildExport, exportProblems, type Known } from '../../src/report/export.js';
import type { ReportData } from '../../src/report/html.js';
import type { WindowRule } from '../../src/report/windows.js';
import type { SkillRow } from '../../src/report/metrics/skills.js';

const RULES: WindowRule[] = ['ask-first', 'no-invented-data', 'fix-everything', 'readme-per-pr', 'paid-ok', 'plain-communication', 'tdd'];
const known: Known = { ids: new Set(['tdd-skill', 'agents-block', 'secrets:deny', ...RULES]) };
const U = (n: number) => ({ input: n, output: n + 1, cacheWrite: n + 2, cacheRead: n + 3 });
const sp = { turns: 1, windows: 1 };
const bk = { r: 1, i: 1 };
const skill = (name: string): SkillRow => ({
  name, label: 'paths', listedIn: 5, sessionsWithListing: 5, relevantIn: 8, invokedRelevant: 4, invokedOther: 1, typedOrCarried: 0, sessions: 10, dropped: false, unknown: 0, undercounted: false, splitUnplaced: 0, duplicates: 0,
  byBucket: { '1-10': bk, '11-30': bk, '31-100': bk, '100+': bk }, byCompact: { pre: bk, post: bk },
});
const L = 'LEAK_CANARY_';
const hostile = (): ReportData => ({
  meta: { generated: '2026-11-05T10:00:00Z', days: 14, harness: '0.2.0', claudeVersions: ['2.1.0', `${L}ver /Users/x`], untested: [`${L}untested`], sessions: { scanned: 3, skipped: { [`${L}reason /Users/x`]: 2 }, unknown: 1 } },
  usage: {
    total: U(10), main: U(8), sub: U(2),
    byDay: { '2026-11-04': U(5), '2026-11-05': U(7), [`${L}day`]: U(1) },
    byModel: { 'claude-opus-4.5': U(5), '<synthetic>': U(3), [`${L}model`]: U(2) },
    sessions: [{ id: `${L}session-id`, usage: U(1), responses: 1, compactions: 0, peak: 1 }], responses: 4, unknown: 0,
    loads: { sessions: 3, agentsMd: 2, claudeMd: 1, unknown: 0, compactions: 1, reloaded: 1 }, toolChars: { [`${L}tool`]: 4 },
  },
  always: [{ id: 'agents-block', tokens: 120 }, { id: `${L}always`, tokens: 5 }],
  skills: [skill('tdd-skill'), skill('my-secret-skill'), skill(`${L}skill`)],
  windows: {
    byRule: Object.fromEntries(RULES.map((r) => [r, {
      windows: [{ rule: r, session: `${L}sess`, date: '2026-11-05', turn: 1, prompt: `${L}prompt /Users/x/repo`, texts: `${L}quote feature/secret-branch`, tools: [`${L}tool`] }],
      total: 1, counters: { asks: 2 }, byBucket: { '1-10': sp, '11-30': sp, '31-100': sp, '100+': sp }, byCompact: { pre: sp, post: sp },
    }])) as unknown as ReportData['windows']['byRule'],
    unknown: 0, notes: { sideRecords: 3, sideBad: 2, beforeFirstPrompt: 1 },
  },
  gates: {
    tally: { 'secrets:deny': 2, [`${L}check`]: 1 }, overrides: { [`${L}ov`]: 1 },
    falseBlocks: [{ signal: 'override', check: `${L}fb`, session: `${L}fbs`, date: '2026-11-05', fuzzy: false, quote: `${L}fbq /Users/x` }],
    latency: [{ source: 'timing', event: 'PreToolUse', n: 5, p50: 10, p95: 30, max: 40, timeouts: 0 }, { source: 'timing', event: `${L}event`, n: 1, p50: 1, p95: 1, max: 1, timeouts: 0 }],
    stopSteps: [{ step: `${L}step`, runs: 1, blocks: 0, flakes: 0, p50: 1, p95: 1 }],
    hallucination: { typecheckBlocks: 1, testBlocks: 2, registryChecks: 3, registryDenies: 4 },
    notes: { badEvents: 0, badTiming: 0, noTime: 0, falseBlocksCut: 0, denyUnlinked: 0, unknownTools: 0, truncatedTurns: 0, samplesCut: 0, keysCut: 0, noTimingLog: true },
  },
});

describe('buildExport', () => {
  it('carries no free text, path, quote, branch, session id or private skill name', () => {
    const out = buildExport(hostile(), known);
    const s = JSON.stringify(out);
    for (const bad of [L, '/Users', 'secret-branch', 'my-secret-skill', 'LEAK']) expect(s).not.toContain(bad);
    expect(exportProblems(out, known)).toEqual([]);
    const skills = out.skills as { id: string; listedIn: number }[];
    expect(skills.map((x) => x.id).sort()).toEqual(['other', 'tdd-skill']);
    expect(skills.find((x) => x.id === 'other')!.listedIn).toBe(10);
  });
  it('counts a synthetic model under other and passes the check', () => {
    const out = buildExport(hostile(), known);
    const models = out.models as { id: string; input: number }[];
    expect(models.find((m) => m.id === 'other')!.input).toBe(5);
    expect(models.map((m) => m.id)).toContain('claude-opus-4.5');
    expect(exportProblems(out, known)).toEqual([]);
  });
  it('buckets weeks as ISO weeks and the date has no time', () => {
    const out = buildExport(hostile(), known);
    for (const w of out.weekly as { week: string }[]) expect(w.week).toMatch(/^(\d{4}-W\d{2}|other)$/);
    expect(out.generated_on).toBe('2026-11-05');
    expect(out.schema).toBe(1);
  });
});

describe('exportProblems', () => {
  it('names the path of an injected string, never its value', () => {
    const p = exportProblems({ schema: 1, skills: [{ id: '/Users/x' }] }, known);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain('skills[0].id');
    expect(p[0]).not.toContain('/Users/x');
  });
  it('rejects a version with a trailing path', () => {
    expect(exportProblems({ harness: '1.2.3/Users/x' }, known)).toHaveLength(1);
  });
});
