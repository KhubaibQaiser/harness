import type { WindowRule, WindowsResult } from '../../src/report/windows.js';
import type { SkillRow } from '../../src/report/metrics/skills.js';
import type { ReportData } from '../../src/report/html.js';

export const U = (n: number) => ({ input: n, output: n + 1, cacheWrite: n + 2, cacheRead: n + 3 });
export const RULES: WindowRule[] = ['ask-first', 'no-invented-data', 'fix-everything', 'readme-per-pr', 'paid-ok', 'plain-communication', 'tdd'];
const split = { turns: 0, windows: 0 };
const buckets = { '1-10': split, '11-30': split, '31-100': split, '100+': split };
export const windows = (over: Partial<WindowsResult['byRule']['tdd']> = {}): WindowsResult => ({
  byRule: Object.fromEntries(RULES.map((r) => [r, { windows: [], total: 0, counters: {}, byBucket: buckets, byCompact: { pre: split, post: split }, ...(r === 'tdd' ? over : {}) }])) as WindowsResult['byRule'],
  unknown: 0, notes: { sideRecords: 3, sideBad: 2, beforeFirstPrompt: 1 },
});
const bk = { r: 0, i: 0 };
export const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  name: 'tdd-skill', label: 'paths', listedIn: 5, sessionsWithListing: 5, relevantIn: 8, invokedRelevant: 4, invokedOther: 0, typedOrCarried: 0, sessions: 10, dropped: false, unknown: 0, undercounted: false, splitUnplaced: 0, duplicates: 0,
  byBucket: { '1-10': bk, '11-30': bk, '31-100': bk, '100+': bk }, byCompact: { pre: bk, post: bk }, ...over,
});
export const data = (over: Partial<ReportData> = {}): ReportData => ({
  meta: { generated: '2026-11-05T10:00:00Z', days: 14, harness: '0.2.0', claudeVersions: ['2.1.0'], untested: [], sessions: { scanned: 3, skipped: { 'unsafe id': 1 }, unknown: 0 } },
  usage: { total: U(10), main: U(8), sub: U(2), byDay: { '2026-11-04': U(5), '2026-11-05': U(7) }, byModel: { 'claude-x': U(10) }, sessions: [{ id: 's1', usage: U(10), responses: 4, compactions: 1, peak: 99 }], responses: 4, unknown: 0, loads: { sessions: 3, agentsMd: 2, claudeMd: 1, unknown: 0, compactions: 1, reloaded: 1 }, toolChars: { Bash: 400 } },
  always: [{ id: 'agents-block', tokens: 120 }, { id: 'other', tokens: null }],
  skills: [skill()], windows: windows(),
  gates: { tally: { 'secrets:deny': 2 }, overrides: {}, falseBlocks: [], latency: [{ source: 'timing', event: 'PreToolUse', n: 5, p50: 10, p95: 30, max: 40, timeouts: 0 }], stopSteps: [], hallucination: { typecheckBlocks: 0, testBlocks: 0, registryChecks: 0, registryDenies: 0 }, notes: { badEvents: 0, badTiming: 0, noTime: 0, falseBlocksCut: 0, denyUnlinked: 0, unknownTools: 0, truncatedTurns: 0, samplesCut: 0, keysCut: 0, noTimingLog: true } },
  ...over,
});
