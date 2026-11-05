import { describe, expect, it } from 'vitest';
import { CSP, NO_SESSIONS, h, renderReport, type ReportData } from '../../src/report/html.js';
import type { WindowRule, WindowsResult } from '../../src/report/windows.js';
import type { SkillRow } from '../../src/report/metrics/skills.js';
import { hbars, stackedBars } from '../../src/report/svg.js';

const U = (n: number) => ({ input: n, output: n + 1, cacheWrite: n + 2, cacheRead: n + 3 });
const RULES: WindowRule[] = ['ask-first', 'no-invented-data', 'fix-everything', 'readme-per-pr', 'paid-ok', 'plain-communication', 'tdd'];
const split = { turns: 0, windows: 0 };
const buckets = { '1-10': split, '11-30': split, '31-100': split, '100+': split };
const windows = (over: Partial<WindowsResult['byRule']['tdd']> = {}): WindowsResult => ({
  byRule: Object.fromEntries(RULES.map((r) => [r, { windows: [], total: 0, counters: {}, byBucket: buckets, byCompact: { pre: split, post: split }, ...(r === 'tdd' ? over : {}) }])) as WindowsResult['byRule'],
  unknown: 0, notes: { sideRecords: 3, sideBad: 2, beforeFirstPrompt: 1 },
});
const bk = { r: 0, i: 0 };
const skill = (over: Partial<SkillRow> = {}): SkillRow => ({
  name: 'tdd-skill', label: 'paths', listedIn: 5, sessionsWithListing: 5, relevantIn: 8, invokedRelevant: 4, invokedOther: 0, typedOrCarried: 0, sessions: 10, dropped: false, unknown: 0, undercounted: false, splitUnplaced: 0, duplicates: 0,
  byBucket: { '1-10': bk, '11-30': bk, '31-100': bk, '100+': bk }, byCompact: { pre: bk, post: bk }, ...over,
});
const data = (over: Partial<ReportData> = {}): ReportData => ({
  meta: { generated: '2026-11-05T10:00:00Z', days: 14, harness: '0.2.0', claudeVersions: ['2.1.0'], untested: [], sessions: { scanned: 3, skipped: { 'unsafe id': 1 }, unknown: 0 } },
  usage: { total: U(10), main: U(8), sub: U(2), byDay: { '2026-11-04': U(5), '2026-11-05': U(7) }, byModel: { 'claude-x': U(10) }, sessions: [{ id: 's1', usage: U(10), responses: 4, compactions: 1, peak: 99 }], responses: 4, unknown: 0, loads: { sessions: 3, agentsMd: 2, claudeMd: 1, unknown: 0, compactions: 1, reloaded: 1 }, toolChars: { Bash: 400 } },
  always: [{ id: 'agents-block', tokens: 120 }, { id: 'other', tokens: null }],
  skills: [skill()], windows: windows(),
  gates: { tally: { 'secrets:deny': 2 }, overrides: {}, falseBlocks: [], latency: [{ source: 'timing', event: 'PreToolUse', n: 5, p50: 10, p95: 30, max: 40, timeouts: 0 }], stopSteps: [], hallucination: { typecheckBlocks: 0, testBlocks: 0, registryChecks: 0, registryDenies: 0 }, notes: { badEvents: 0, badTiming: 0, noTime: 0, falseBlocksCut: 0, denyUnlinked: 0, unknownTools: 0, truncatedTurns: 0, samplesCut: 0, keysCut: 0, noTimingLog: true } },
  ...over,
});
const method = (html: string) => html.slice(html.indexOf('id="method"'));

describe('renderReport', () => {
  it('has no script and no http outside Method; carries the CSP meta', () => {
    const html = renderReport(data());
    expect(html).not.toContain('<script');
    expect(html.slice(0, html.indexOf('id="method"'))).not.toMatch(/https?:/);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  });
  it('escapes hostile text, including hidden characters, in cells, titles and svg', () => {
    const bad = '<script>alert(1)</script>‮​';
    const html = renderReport(data({
      windows: windows({ total: 1, windows: [{ rule: 'tdd', session: bad, date: '2026-11-05', turn: 1, prompt: bad, texts: bad, tools: [bad] }] }),
      skills: [skill({ name: bad })],
    }));
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('\\u202e');
    expect(html).toContain('\\u200b');
    expect(html).not.toMatch(/[‮​]/);
    expect(h(`"'&`)).toBe('&quot;&#39;&amp;');
  });
  it('follows each svg with a table', () => {
    const html = renderReport(data());
    const parts = html.split('<svg').slice(1);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.slice(p.indexOf('</svg>'))).toMatch(/^<\/svg>\s*(<div class="scroll">)?<table/);
  });
  it('shows no relevant sessions, and counts only under n of 5', () => {
    expect(renderReport(data({ skills: [skill({ relevantIn: 0, invokedRelevant: 0 })] }))).toContain('no relevant sessions');
    const html = renderReport(data({ skills: [skill({ relevantIn: 4, invokedRelevant: 2 })] }));
    const row = html.slice(html.indexOf('tdd-skill'), html.indexOf('</tr>', html.indexOf('tdd-skill')));
    expect(row).toContain('2 of 4');
    expect(row).not.toContain('%');
    expect(renderReport(data())).toContain('50%');
  });
  it('shows NO_SESSIONS when none scanned', () => {
    const d = data(); d.meta.sessions.scanned = 0;
    expect(renderReport(d)).toContain(NO_SESSIONS);
    expect(renderReport(data())).not.toContain(NO_SESSIONS);
  });
  it('shows four token columns and the estimate label', () => {
    const html = renderReport(data());
    for (const c of ['Uncached input', 'Cache write', 'Cache read', 'Output']) expect(html).toContain(`<th>${c}</th>`);
    expect(html).toContain('estimate, characters / 4');
  });
  it('omits rules and evals sections when undefined, adds them when given', () => {
    const html = renderReport(data());
    expect(html).not.toContain('id="rules-matrix"');
    expect(html).not.toContain('id="evals"');
    const both = renderReport(data({ rules: { a: '<u>' }, evals: [1] }));
    expect(both).toContain('id="rules-matrix"');
    expect(both).toContain('id="evals"');
    expect(both).not.toContain('<u>');
  });
  it('has the banner and sections in order', () => {
    const html = renderReport(data());
    expect(html).toContain("Local report. Quoted turns come from your session transcripts. Don't share this file; use <code>--export</code> to share counts.");
    const ids = ['id="header"', 'id="summary"', 'id="skills"', 'id="rules"', 'id="tokens"', 'id="gates"', 'id="method"'].map((i) => html.indexOf(i));
    expect(ids.every((n) => n >= 0)).toBe(true);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
  it('shows data notes with counts', () => {
    const m = method(renderReport(data()));
    expect(m).toContain('Data notes');
    expect(m).toMatch(/sideRecords[^<]*3/);
    expect(m).toMatch(/sideBad[^<]*2/);
    expect(m).toMatch(/beforeFirstPrompt[^<]*1/);
  });
  it('lists windows in details without a judgement', () => {
    const html = renderReport(data({ windows: windows({ total: 1, windows: [{ rule: 'tdd', session: 's1', date: '2026-11-05', turn: 2, prompt: 'do it', texts: 'done', tools: ['Edit'] }] }) }));
    expect(html).toContain('<details');
    expect(html).toContain('needs a look');
  });
});

describe('svg', () => {
  it('escapes labels in bars', () => {
    expect(hbars([{ label: '<i>', value: 1, max: 2, note: '"x"' }])).not.toContain('<i>');
    expect(stackedBars([{ label: '<i>', parts: [1, 2] }], ['<a>', 'b'])).not.toContain('<a>');
  });
});
