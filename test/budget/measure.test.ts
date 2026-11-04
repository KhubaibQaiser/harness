import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import type { Catalog, CatalogItem } from '../../src/catalog/schema.js';
import { alwaysLoadedText, budgetLines, budgetVerdict, estimateTokens, itemContext, itemContextLine, measureSelection, type ContextMeasure } from '../../src/budget/measure.js';

const templates = join(__dirname, '../../templates');
const plugin = join(__dirname, '../..');
const dirs = { templates, plugin };
const item = (id: string, kind: CatalogItem['kind'], source: CatalogItem['source'] = { type: 'own' }): CatalogItem =>
  ({ id, kind, title: id, source, license: 'MIT', min_claude_code: '2.1.0', applies_when: { always: true }, conflicts_with: [], requires: [], cost: { context: 'low', setup: 'none' }, stance: 'default', stance_reason: '', side_effects: [], why: 'w', evidence: [] });
const gh = { type: 'github', repo: 'a/b', plugin: 'p', sha: '0'.repeat(40) } as const;
const cat = (...items: CatalogItem[]): Catalog => ({ version: 1, items });
const rubric = item('review-rubric', 'own-skill', { type: 'own', files: [{ from: 'skills/review-rubric/SKILL.md', to: '.claude/skills/review-rubric/SKILL.md' }] });
const m = (tokens: number, unmeasured: string[] = []): ContextMeasure => ({ entries: [], tokens, unmeasured, method: 'estimate' });

test('estimateTokens rounds chars/4 up', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('abcde')).toBe(2);
});

test('skills count only name and description', () => {
  const fm = 'name: x\ndescription: Does a thing.';
  const body = 'b'.repeat(4000);
  const withBody = alwaysLoadedText('skill', `---\n${fm}\nmodel: sonnet\n---\n${body}`);
  expect(estimateTokens(withBody)).toBe(estimateTokens(fm));
  expect(alwaysLoadedText('skill', `---\n${fm}\n---\n${body}`)).not.toContain('bbbb');
  expect(alwaysLoadedText('agent', `---\nname: a\ndescription: d\ntools: Read\n---\n${body}`)).toBe('name: a\ndescription: d');
  expect(alwaysLoadedText('agents-block', 'whole text')).toBe('whole text');
});

test('agents-md counts the block and the import', () => {
  const block = readFileSync(join(templates, 'agents-block.md'), 'utf8');
  const e = itemContext(item('agents-md', 'rule', { type: 'own', merge: ['agents-md'] }), dirs);
  expect(e).toEqual({ id: 'agents-md', tokens: estimateTokens(block + '@AGENTS.md\n') });
});

test('own skill counts its template frontmatter; hooks, settings and ci are 0', () => {
  expect(itemContext(rubric, dirs).tokens).toBeGreaterThan(0);
  for (const k of ['own-hook', 'settings', 'ci'] as const) expect(itemContext(item(k, k), dirs).tokens).toBe(0);
});

test('plugins, outside skills and MCP are unmeasured', async () => {
  const c = cat(item('p', 'plugin', gh), item('s', 'external-skill', gh), item('m', 'mcp', { type: 'npm', package: 'x', version: '1.0.0' }));
  const r = await measureSelection(['p', 's', 'm'], c, dirs);
  expect(r.entries.filter((e) => e.id !== 'harness-plugin').map((e) => e.tokens)).toEqual([null, null, null]);
  expect(r.unmeasured).toEqual(['p', 's', 'm']);
  expect(r.method).toBe('estimate');
});

test("measureSelection always includes the harness plugin's own skills", async () => {
  const r = await measureSelection([], cat(), dirs);
  const e = r.entries.find((x) => x.id === 'harness-plugin');
  expect(e?.tokens).toBeGreaterThan(0);
  expect(r.tokens).toBe(e!.tokens);
});

test('approved items are exempt', async () => {
  const c = cat(rubric, item('p', 'plugin', gh));
  const base = await measureSelection([], c, dirs);
  const r = await measureSelection(['review-rubric', 'p'], c, dirs, { exempt: ['review-rubric', 'p', 'harness-plugin'] });
  expect(r.entries.find((e) => e.id === 'review-rubric')).toMatchObject({ exempt: true });
  expect(r.tokens).toBe(base.tokens);
  expect(r.unmeasured).toEqual([]);
  expect(r.entries.find((e) => e.id === 'harness-plugin')?.exempt).toBeUndefined();
});

test('a new unmeasured item still asks while approved ones don\'t', async () => {
  const c = cat(item('old', 'plugin', gh), item('new', 'plugin', gh));
  const exempt = ['old'];
  const before = await measureSelection(['old'], c, dirs, { exempt });
  const after = await measureSelection(['old', 'new'], c, dirs, { exempt });
  const v = budgetVerdict(before, after, 100000);
  expect(v.added_unmeasured).toEqual(['new']);
  expect(v.ask).toBe(true);
  expect(budgetVerdict(before, before, 100000).ask).toBe(false);
});

test('verdict asks when growing past the budget', () => {
  expect(budgetVerdict(m(1800), m(2100), 2000).ask).toBe(true);
  expect(budgetVerdict(m(2100), m(2050), 2000).ask).toBe(false);
  expect(budgetVerdict(m(1800), m(1900), 2000).ask).toBe(false);
});

test('verdict asks for a new unmeasured item under budget', () => {
  const v = budgetVerdict(m(10), m(10, ['gsap-skills']), 2000);
  expect(v.ask).toBe(true);
  expect(v.added_unmeasured).toEqual(['gsap-skills']);
});

test('budgetLines say estimate and name the unmeasured ids', () => {
  expect(budgetLines(budgetVerdict(m(10), m(20), 2000))).toEqual(['Always-loaded context from harness: ~20 tokens (estimate), budget 2000.']);
  expect(budgetLines(budgetVerdict(m(10), m(3000, ['a', 'b']), 2000))).toEqual([
    'Always-loaded context from harness: ~3000 tokens (estimate), budget 2000.',
    'Not measured before install: a, b.',
    'Over budget: confirm before installing.',
  ]);
});

test('budgetLines lists approved ids', () => {
  const after: ContextMeasure = { ...m(5), entries: [{ id: 'x', tokens: 9, exempt: true }, { id: 'y', tokens: 3 }, { id: 'z', tokens: null, exempt: true }] };
  expect(budgetLines(budgetVerdict(m(5), after, 2000))).toEqual([
    'Always-loaded context from harness: ~5 tokens (estimate), budget 2000.',
    'Approved earlier, not counted: x, z.',
  ]);
});

test('itemContextLine', () => {
  expect(itemContextLine({ id: 'a', tokens: 12 })).toBe('~12 tokens (estimate)');
  expect(itemContextLine({ id: 'a', tokens: null })).toBe('not measured before install');
});

test('measureSelection reads a real catalog', async () => {
  const { catalog } = loadCatalog(join(__dirname, '../../catalog'));
  const r = await measureSelection(['review-rubric', 'agents-md'], catalog, dirs);
  expect(r.tokens).toBeGreaterThan(0);
});
