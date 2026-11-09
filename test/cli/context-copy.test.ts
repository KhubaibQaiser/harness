import { expect, test } from 'vitest';
import { CATALOG_ESTIMATE, reportJson, reportText, type Rec } from '../../src/cli/context-copy.js';
import type { ContextSet } from '../../src/budget/summary.js';
import type { SourceEntry } from '../../src/budget/sources.js';

const row = (owner: SourceEntry['owner'], label: string, tokens: number, extra: Partial<SourceEntry> = {}): SourceEntry =>
  ({ id: label, path: label, label, owner, load: 'always', tokens, chars: tokens * 4, text: 'x'.repeat(tokens * 4), ...extra });
const od = (label: string, tokens: number): SourceEntry => ({ ...row('repo', label, tokens), load: 'on-demand' });

// The §7.1 example's shape.
const example = (over: Partial<ContextSet> = {}): ContextSet => ({
  always: [
    row('repo', 'CLAUDE.md', 412), row('repo', 'AGENTS.md (imported by CLAUDE.md)', 427), row('repo', '.claude/rules/style.md', 120),
    row('harness', 'AGENTS.md harness block', 263), row('harness', 'CLAUDE.md line @AGENTS.md', 3),
    row('harness', 'skills harness:doctor, harness:status', 88), row('harness', 'skill review-rubric', 44), row('harness', 'agent staff-reviewer', 46),
  ],
  onDemand: [od('.claude/rules/api.md (paths: src/api/**)', 310), od('team decisions: 3 rules', 180), od('skill and agent bodies: 7', 2020), od('nested CLAUDE.md: 1', 220)],
  unmeasured: ['mcp: github', 'plugin: some-plugin@market'], notes: [],
  total: 1403, harness: 444, catalog: 0, repo: 959, budget: 2000, method: 'estimate', model: null, ...over,
});

const GOLDEN = [
  "Context budget: ~1,403 of 2,000 tokens always loaded (70%). Best estimate (characters ÷ 4); set ANTHROPIC_API_KEY to count with Anthropic's token-counting API.",
  '',
  'Always loaded                                           tokens',
  '  repo     CLAUDE.md                                      ~412',
  '  repo     AGENTS.md (imported by CLAUDE.md)              ~427',
  '  repo     .claude/rules/style.md                         ~120',
  '  harness  AGENTS.md harness block                        ~263',
  '  harness  CLAUDE.md line @AGENTS.md                        ~3',
  '  harness  skills harness:doctor, harness:status           ~88',
  '  harness  skill review-rubric                             ~44',
  '  harness  agent staff-reviewer                            ~46',
  '  Total                                                 ~1,403',
  '  Not measured: plugin some-plugin@market (enabled in .claude/settings.json)',
  '',
  'On demand (loads when used or when matching files are touched)   ~2,730',
  '  .claude/rules/api.md (paths: src/api/**)                ~310',
  '  team decisions: 3 rules                                 ~180',
  '  skill and agent bodies: 7                             ~2,020',
  '  nested CLAUDE.md: 1                                     ~220',
  '  after compaction: state card, at most ~300',
  '',
  "Not measured: Claude Code's system prompt and tools, output style, MCP servers (github), and your personal context (~/.claude files, user plugins, auto memory). Run /context all in a Claude Code session to see them.",
];

test('golden: the §7.1 report within the budget, no recommendations section when there are none', () => {
  expect(reportText(example(), [], null)).toEqual(GOLDEN);
});

test('golden: over the budget the first line says by how much', () => {
  const s = example({ total: 2410, repo: 1966, always: [...example().always, row('repo', 'big.md', 1007)] });
  expect(reportText(s, [], null)[0]).toBe("Context budget: ~2,410 of 2,000 tokens always loaded, over by ~410. Best estimate (characters ÷ 4); set ANTHROPIC_API_KEY to count with Anthropic's token-counting API.");
});

test('without MCP servers the not-measured sentence leaves them out', () => {
  const t = reportText(example({ unmeasured: [] }), [], null);
  expect(t.at(-1)).toBe("Not measured: Claude Code's system prompt and tools, output style, and your personal context (~/.claude files, user plugins, auto memory). Run /context all in a Claude Code session to see them.");
  expect(t).not.toContain('  Not measured: plugin some-plugin@market (enabled in .claude/settings.json)');
});

test('the recommendations section prints the §7.1 lines', () => {
  const recs: Rec[] = [
    { n: 1, kind: 'name-only', owner: 'catalog:seo-audit', target: 'seo-audit', saves: 61, apply: true, line: 'Show skill seo-audit by name only (saves ~61). Apply: harness context apply 1' },
    { n: 2, kind: 'long-file', owner: 'repo', target: 'CLAUDE.md', saves: 0, apply: false, line: 'CLAUDE.md is 260 lines; move the parts that only matter for some folders into path-scoped rules. /harness:context-optimize proposes the diff.' },
  ];
  expect(reportText(example(), recs, null).slice(-4)).toEqual([
    '',
    'Recommendations',
    '  1. harness  Show skill seo-audit by name only (saves ~61). Apply: harness context apply 1',
    '  2. yours    CLAUDE.md is 260 lines; move the parts that only matter for some folders into path-scoped rules. /harness:context-optimize proposes the diff.',
  ]);
});

test("with the API the label names the model and counted rows have no ~", () => {
  const t = reportText(example({ method: 'exact', model: 'claude-opus-5-5' }), [], null);
  expect(t[0]).toBe("Context budget: 1,403 of 2,000 tokens always loaded (70%). Counted by Anthropic's token-counting API (claude-opus-5-5).");
  expect(t[3]).toBe('  repo     CLAUDE.md                                       412');
  expect(t[11]).toBe('  Total                                                  1,403');
  expect(t[14]).toBe('On demand (loads when used or when matching files are touched)   2,730');
  expect(t.slice(0, 20).filter((l) => /~\d/.test(l) && !l.includes('state card'))).toEqual([]);
});

test('with the API catalog-recorded rows stay estimates, marked and counted in the header', () => {
  const pick = row('catalog:seo-audit', 'seo-audit', 61, { path: 'catalog:seo-audit', chars: 0, text: undefined, note: CATALOG_ESTIMATE });
  const t = reportText(example({ method: 'exact', model: 'claude-opus-5-5', always: [...example().always, pick], total: 1464, catalog: 61 }), [], null);
  expect(t[0]).toBe("Context budget: 1,464 of 2,000 tokens always loaded (73%). Counted by Anthropic's token-counting API (claude-opus-5-5), except 1 catalog estimate.");
  expect(t).toContain('  catalog  seo-audit (catalog estimate)                    ~61');
});

test('a failed API call gives the fallback line and ~ estimates', () => {
  const t = reportText(example(), [], '429');
  expect(t[0]).toBe('Context budget: ~1,403 of 2,000 tokens always loaded (70%). Best estimate (characters ÷ 4).');
  expect(t[1]).toBe("Couldn't use the token-counting API (429); counts are best estimates.");
  expect(t[4]).toBe('  repo     CLAUDE.md                                      ~412');
});

test('notes print, and a row note follows its label', () => {
  const t = reportText(example({ notes: ['not a git repository or git not found: nested CLAUDE.md files not listed'], always: [row('repo', 'CLAUDE.md', 0, { chars: 0, note: 'over 4 MiB: Claude Code skips it' })], total: 0 }), [], null);
  expect(t).toContain('  repo     CLAUDE.md (over 4 MiB: Claude Code skips it)     ~0');
  expect(t).toContain('Note: not a git repository or git not found: nested CLAUDE.md files not listed');
});

test('json follows §5: no chars or file path for rows without text', () => {
  const pick = row('catalog:seo-audit', 'seo-audit', 61, { path: 'catalog:seo-audit', chars: 0, text: undefined, note: 'size from the catalog record' });
  const plugin = row('harness', 'skills harness:doctor', 93, { id: 'harness-plugin', path: 'plugin:harness', chars: 0, text: undefined });
  const j = reportJson(example({ always: [...example().always, pick, plugin], method: 'exact', model: 'claude-opus-5-5' }), []) as Record<string, unknown>;
  expect(Object.keys(j)).toEqual(['method', 'model', 'budget', 'always', 'on_demand', 'sources', 'unmeasured', 'not_measured', 'recommendations']);
  expect(j).toMatchObject({ method: 'exact', model: 'claude-opus-5-5', budget: 2000, always: { total: 1403, harness: 444, catalog: 0, repo: 959 }, on_demand: { total: 2730 } });
  expect(j.not_measured).toEqual(['system prompt and tools', 'output style', 'personal context']);
  expect(j.unmeasured).toEqual(['mcp: github', 'plugin: some-plugin@market']);
  const src = j.sources as Record<string, unknown>[];
  expect(src[0]).toEqual({ id: 'CLAUDE.md', path: 'CLAUDE.md', owner: 'repo', load: 'always', tokens: 412, chars: 1648 });
  expect(src.find((r) => r.id === 'seo-audit')).toEqual({ id: 'seo-audit', owner: 'catalog:seo-audit', load: 'always', tokens: 61, note: 'size from the catalog record' });
  expect(src.find((r) => r.id === 'harness-plugin')).toEqual({ id: 'harness-plugin', owner: 'harness', load: 'always', tokens: 93 });
  expect(src.filter((r) => r.load === 'on-demand')).toHaveLength(4);
});

test('json recommendations drop the worded line; model is null offline', () => {
  const rec: Rec = { n: 1, kind: 'remove', owner: 'catalog:x', target: 'x', saves: 5, apply: true, line: 'words' };
  const j = reportJson(example(), [rec]) as Record<string, unknown>;
  expect(j.model).toBeNull();
  expect(j.method).toBe('estimate');
  expect(j.recommendations).toEqual([{ n: 1, kind: 'remove', owner: 'catalog:x', target: 'x', saves: 5, apply: true }]);
});
