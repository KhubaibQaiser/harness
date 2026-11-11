import { describe, expect, it } from 'vitest';
import { CSP, NO_SESSIONS, h, renderReport, type ReportData } from '../../src/report/html.js';
import { hbars, stackedBars } from '../../src/report/svg.js';

import { U, data, skill, windows } from './html-data.js';
const EV = { date: '2026-11-05', model: 'claude-x', kind: 'rules' as const, cases: [], deltaByRule: {}, costUsd: null, runs: 0, partial: false };
const method = (html: string) => html.slice(html.indexOf('id="method"'));

describe('renderReport', () => {
  it('has no script and no http outside Method; carries the CSP meta', () => {
    const html = renderReport(data());
    expect(html).not.toContain('<script');
    expect(html.slice(0, html.indexOf('id="method"'))).not.toMatch(/https?:/);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  });
  it('pairs each svg with the table right after it, with the same numbers', () => {
    const html = renderReport(data({ windows: windows(), gates: { ...data().gates, stopSteps: [] } }));
    const parts = html.split('<svg').slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of parts) {
      const [svg, rest] = [p.slice(0, p.indexOf('</svg>')), p.slice(p.indexOf('</svg>'))];
      expect(rest.startsWith('</svg><div class="scroll"><table')).toBe(true);
      const tbl = rest.slice(0, rest.indexOf('</table>'));
      const nums = [...svg.matchAll(/<title>[^<]*<\/title>/g)].flatMap((m) => (m[0].split(': ').pop() ?? '').match(/\d+/g) ?? []);
      expect(nums.length).toBeGreaterThan(0);
      for (const num of nums) expect(tbl).toContain(`<td>${num}</td>`);
    }
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
    const both = renderReport(data({ rules: [{ def: { id: 'tdd', kind: 'mechanical', checks: [], on: () => true, bypasses: ['<u>'] }, enforced: 'yes', fires: 0, denies: 0, asks: 0, blocks: 0, probableFalse: 0, windows: 0 }], evals: [EV] }));
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

const HOSTILE = ['"><img src=x onerror=alert(1)>', '</style>', 'javascript:alert(1)', '<script>', '\u202e', '\u200b'].join(' ');
const hostileData = (): ReportData => {
  const H = HOSTILE, d = data();
  const w = windows({ total: 1, windows: [{ rule: 'tdd', session: H, date: H, turn: 1, prompt: H, texts: H, tools: [H] }], counters: { [H]: 1 } });
  return {
    ...d, windows: w, always: [{ id: H, tokens: 1 }], skills: [skill({ name: H })], rules: [{ def: { id: 'tdd', kind: 'mechanical', checks: [H], on: () => true, bypasses: [H] }, enforced: 'yes', fires: 0, denies: 0, asks: 0, blocks: 0, probableFalse: 0, windows: 0 }], evals: [{ ...EV, model: H, date: H, cases: [{ name: H, mean: 1, passK: true, variant: H }] }],
    meta: { ...d.meta, harness: H, generated: H, claudeVersions: [H], untested: [H], sessions: { scanned: 2, skipped: { [H]: 1 }, unknown: 0 } },
    usage: { ...d.usage, byDay: { [H]: U(1) }, byModel: { [H]: U(2) }, toolChars: { [H]: 40 }, sessions: [{ id: H, usage: U(3), responses: 1, compactions: 0, peak: 5 }] },
    gates: {
      ...d.gates, tally: { [H]: 1 }, overrides: { [H]: 1 },
      falseBlocks: [{ signal: 'deny-retry', check: H, session: H, date: H, quote: H, fuzzy: false }],
      latency: [{ source: 'timing', event: H, outcome: H, n: 5, p50: 1, p95: 2, max: 3, timeouts: 0 }],
      stopSteps: [{ step: H, runs: 6, blocks: 3, flakes: 0, p50: 1, p95: 2 }],
    },
  };
};
describe('hostile strings', () => {
  const html = renderReport(hostileData());
  it('leaves no raw markup, handler, or hidden character from any string field', () => {
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/"\s*onerror=/);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/[\u202e\u200b]/);
    expect(html).not.toMatch(/<[^>]*\b(href|src)=/);
  });
  it('shows the escaped forms', () => {
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;/style&gt;');
    expect(html).toContain('\\u202e');
    expect(html).toContain('\\u200b');
  });
});

describe('fix round 1', () => {
  const step = (runs: number, blocks: number) => ({ step: 'typecheck', runs, blocks, flakes: 0, p50: null, p95: null });
  const withSteps = (steps: ReturnType<typeof step>[]) => renderReport(data({ gates: { ...data().gates, stopSteps: steps } }));
  it('stop steps show a fail rate, counts only under 5 runs', () => {
    expect(withSteps([step(10, 5)])).toContain('<td>50% (5 of 10)</td>');
    const small = withSteps([step(4, 1)]);
    expect(small).toContain('<td>1 of 4</td>');
    expect(small).not.toContain('25%');
  });
  it('ranks sessions by peak, not by the sum of the four parts', () => {
    const big = { id: 'big-sum', usage: U(1000), responses: 1, compactions: 0, peak: 1 };
    const peaky = { id: 'peaky', usage: U(1), responses: 1, compactions: 0, peak: 900 };
    const d = data(); d.usage.sessions = [big, peaky];
    const html = renderReport(d);
    expect(html.indexOf('peaky')).toBeLessThan(html.indexOf('big-sum'));
    expect(html).toContain('by peak context');
  });
  it('lays out the legend without overlap', () => {
    const svg = stackedBars([{ label: 'a', parts: [1, 1, 1, 1] }], ['Uncached input', 'Cache write', 'Cache read', 'Output']);
    const xs = [...svg.matchAll(/<rect x="(\d+)" y="\d+" width="10" height="10"/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(130);
    expect(Number(/viewBox="0 0 (\d+)/.exec(svg)![1])).toBeGreaterThanOrEqual(xs[3]! + 130);
  });
  it('cuts labels by code point and names charts', () => {
    const svg = hbars([{ label: `${'a'.repeat(25)}\u{1F600}tail`, value: 1, max: 1 }], 'My chart');
    expect(svg).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(svg).toContain('aria-label="My chart"');
    expect(renderReport(data())).toContain('aria-label="Hook latency p50 and p95"');
  });
  it('takes the hook p95 tile from timing-log rows only, and says unknown without them', () => {
    const base = data().gates;
    const lat = (latency: ReportData['gates']['latency']) => {
      const html = renderReport(data({ gates: { ...base, latency } }));
      return html.slice(html.indexOf('Harness hook p95'), html.indexOf('</div>', html.indexOf('Harness hook p95')));
    };
    const tr = { source: 'transcript' as const, event: 'PreToolUse', n: 3, p50: 400, p95: 900, max: 900, timeouts: 0 };
    const tm = { source: 'timing' as const, event: 'PreToolUse', outcome: 'allow', n: 5, p50: 10, p95: 30, max: 40, timeouts: 0 };
    const timeoutOnly = { source: 'timing' as const, event: 'Stop', outcome: 'timeout', n: 0, p50: 0, p95: 0, max: 0, timeouts: 2 };
    expect(lat([tr, tm])).toContain('<b>30 ms</b>');
    expect(lat([tr, tm])).toContain('dispatcher module start to the decision, before the stdout write; Node startup is not included');
    expect(lat([tr, timeoutOnly])).toContain('<b>unknown (no timing log)</b>');
    expect(lat([tr])).not.toContain('900');
  });
  it('says what the timing-log latency measures', () => {
    expect(renderReport(data())).toContain('from dispatcher module start to the decision, before the stdout write; Node startup is not included');
  });
  it('draws p50 and p95 bars, keeps the two note lists apart, and words the rules note plainly', () => {
    const html = renderReport(data());
    expect(html).toContain('PreToolUse p50');
    expect(html).toContain('PreToolUse p95');
    expect(html).toContain('<h4>Transcripts</h4>');
    expect(html).toContain('<h4>Harness events and timing</h4>');
    expect(html).not.toContain('no window never');
    expect(html).toContain('AGENTS.md in 2 of 3');
    expect(html).toContain('<td>1-10</td>');
  });
});

describe('fix round 2', () => {
  it('cuts the day label by code point', () => {
    const svg = stackedBars([{ label: 'ab\u{1F600}\u{1F600}\u{1F600}', parts: [1] }], ['x']);
    expect(svg).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(svg).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
  it('names the skills chart', () => {
    expect(renderReport(data())).toContain('aria-label="Skills invoked when relevant"');
  });
  it('states what the token and ranking notes mean', () => {
    const html = renderReport(data());
    expect(html).not.toContain('never added together');
    expect(html).toContain('The four parts are shown separately.');
    expect(html).toContain('main thread only');
    expect(html).toContain('not output');
  });
});

describe('svg', () => {
  it('escapes labels in bars', () => {
    expect(hbars([{ label: '<i>', value: 1, max: 2, note: '"x"' }])).not.toContain('<i>');
    expect(stackedBars([{ label: '<i>', parts: [1, 2] }], ['<a>', 'b'])).not.toContain('<a>');
  });
});
