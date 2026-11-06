import { describe, expect, it } from 'vitest';
import { defaults, type HarnessConfig } from '../../src/core/config.js';
import { enforcedLine, ruleRows } from '../../src/report/rules.js';
import { renderReport } from '../../src/report/html.js';
import { exportKnown } from '../../src/cli/report.js';
import { buildExport, exportProblems } from '../../src/report/export.js';
import type { GatesResult } from '../../src/report/metrics/gates.js';
import type { WindowsResult } from '../../src/report/windows.js';
import { data } from './html-data.js';

const gates = (tally: Record<string, number> = {}, falseBlocks: GatesResult['falseBlocks'] = []): GatesResult =>
  ({ ...data().gates, tally, falseBlocks });
const win = (): WindowsResult => data().windows;
const withPreset = (c: HarnessConfig, over: Partial<NonNullable<HarnessConfig['preset']>['git']> = {}): HarnessConfig => ({
  ...c, preset: { id: 'p', version: '1', items: [], git: { branch_prefixes: ['feat/'], no_ai_trailer: true, pr_size_warning: true, ...over } },
});
const line = (c: HarnessConfig) => enforcedLine(ruleRows(c, gates(), win()));

describe('rule coverage matrix', () => {
  it('has the 11 rows', () => expect(ruleRows(defaults(), gates(), win())).toHaveLength(11));
  it('default config enforces 1 of 11 (small PRs, prSize is on), 2 partly', () => {
    expect(line(defaults())).toBe('1 of 11 rules enforced deterministically, 2 partly');
  });
  it('tdd with paths, plus a preset trailer rule: tdd yes, trailer only partly; prefixes never', () => {
    const base = { ...defaults(), checks: { ...defaults().checks, tdd: true, prSize: false }, tdd: { ...defaults().tdd, paths: ['src/'] } };
    expect(line(withPreset(base))).toBe('1 of 11 rules enforced deterministically, 3 partly');
    expect(line(withPreset({ ...base, checks: { ...base.checks, prSize: true } }))).toBe('2 of 11 rules enforced deterministically, 3 partly');
  });
  it('tdd on with no tdd.paths enforces nothing', () => {
    const c = { ...defaults(), checks: { ...defaults().checks, tdd: true } };
    expect(ruleRows(c, gates(), win()).find((r) => r.def.id === 'tdd')!.enforced).toBe('no');
  });
  it('the trailer rule is partly with the preset flag and no otherwise; branch prefixes are never enforced', () => {
    const by = (c: HarnessConfig, id: string) => ruleRows(c, gates(), win()).find((r) => r.def.id === id)!;
    expect(by(withPreset(defaults()), 'no-ai-trailer').enforced).toBe('partial');
    expect(by(withPreset(defaults(), { no_ai_trailer: false }), 'no-ai-trailer').enforced).toBe('no');
    expect(by(defaults(), 'no-ai-trailer').enforced).toBe('no');
    expect(by(withPreset(defaults()), 'branch-prefix').enforced).toBe('no');
    expect(by(defaults(), 'no-ai-trailer').def.bypasses).toContain("a plain git commit isn't checked");
  });
  it('no-invented-data needs the guard for dep-verify; stop alone is enough', () => {
    const rowFor = (checks: Partial<HarnessConfig['checks']>) =>
      ruleRows({ ...defaults(), checks: { ...defaults().checks, ...checks } }, gates(), win()).find((r) => r.def.id === 'no-invented-data')!.enforced;
    expect(rowFor({ guard: false, stop: false })).toBe('no');
    expect(rowFor({ guard: false, stop: true })).toBe('partial');
    expect(rowFor({ guard: true, stop: false })).toBe('partial');
  });
  it('paid-ok shows "-" counts: the event log cannot tell paid guard events apart; stop events still count for no-invented-data', () => {
    const rows = ruleRows(defaults(), gates({ 'guard deny': 2, 'stop block': 3 }), win());
    expect(rows.find((r) => r.def.id === 'paid-ok')!.def.checks).toEqual([]);
    expect(rows.find((r) => r.def.id === 'paid-ok')!.fires).toBe(0);
    expect(rows.find((r) => r.def.id === 'no-invented-data')!.blocks).toBe(3);
    const html = renderReport(data({ rules: rows }));
    const row = html.slice(html.indexOf('<td>No paid actions without an OK</td>')).split('</tr>')[0]!;
    expect(row).toContain('<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>');
    expect(html).toContain('the guard also logs events that are not paid actions');
  });
  it('the page shows "-" counts where no check is logged, and 0 where one is', () => {
    const html = renderReport(data({ rules: ruleRows(defaults(), gates(), win()) }));
    const row = (name: string) => html.slice(html.indexOf(`<td>${name}</td>`)).split('</tr>')[0]!;
    expect(row('Lean context')).toContain('<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>');
    expect(row('Small PRs')).toContain('<td>0</td><td>0</td>');
  });
  it('an off check makes its rule no, never followed', () => {
    const c = { ...defaults(), checks: { ...defaults().checks, tdd: false, depVerify: false, stop: false, guard: false, prSize: false } };
    const rows = ruleRows(c, gates(), win());
    expect(rows.find((r) => r.def.id === 'tdd')!.enforced).toBe('no');
    expect(rows.find((r) => r.def.id === 'no-invented-data')!.enforced).toBe('no');
    expect(rows.find((r) => r.def.id === 'paid-ok')!.enforced).toBe('no');
    expect(line(c)).toBe('0 of 11 rules enforced deterministically, 0 partly');
  });
  it('judgement rules are never enforced and carry their window count', () => {
    const w = win();
    w.byRule['ask-first'].total = 4;
    const r = ruleRows(defaults(), gates(), w).find((x) => x.def.id === 'ask-first')!;
    expect(r.enforced).toBe('no');
    expect(r.windows).toBe(4);
  });
  it('counts fires, denies, asks, blocks and probable false blocks per check', () => {
    const g = gates({ 'red-first deny': 3, 'tamper ask': 1, 'stop block': 9, 'guard deny': 2 }, [
      { signal: 'deny-retry', check: 'red-first', session: 's', date: 'd', fuzzy: false },
    ]);
    const r = ruleRows({ ...defaults(), checks: { ...defaults().checks, tdd: true } }, g, win()).find((x) => x.def.id === 'tdd')!;
    expect(r).toMatchObject({ fires: 4, denies: 3, asks: 1, blocks: 0, probableFalse: 1 });
  });
  it('bypass text is verbatim from spec 5.1', () => {
    const d = ruleRows(defaults(), gates(), win());
    expect(d.find((r) => r.def.id === 'no-invented-data')!.def.bypasses).toEqual(['a made-up number labelled "estimate" passes the heuristic']);
    expect(d.find((r) => r.def.id === 'lean-context')!.def.bypasses).toEqual(['not enforced at run time']);
  });
  it('the html rules section shows the matrix and the line, escaped', () => {
    const rows = ruleRows(defaults(), gates(), win());
    const html = renderReport(data({ rules: rows }));
    expect(html).toContain('id="rules-matrix"');
    expect(html).toContain('1 of 11 rules enforced deterministically, 2 partly');
    expect(html).toContain('Ask before deciding');
  });
  it('a hostile key in the rows never reaches the export', () => {
    const rows = ruleRows(defaults(), gates({ '<script> deny': 1 }), win());
    const k = exportKnown();
    const out = buildExport(data({ rules: rows }), k);
    expect(JSON.stringify(out)).not.toContain('<script>');
    expect(exportProblems(out, k)).toEqual([]);
  });
});
