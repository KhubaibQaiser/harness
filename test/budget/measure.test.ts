import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { defaults } from '../../src/core/config.js';
import { loadCatalog } from '../../src/catalog/load.js';
import type { Catalog, CatalogItem } from '../../src/catalog/schema.js';
import { stripComments } from '../../src/budget/text.js';
import { DEFAULT_CONTEXT_BUDGET, SKILL_DESCRIPTION_MAX, alwaysLoadedText, budgetLines, budgetVerdict, estimateTokens, itemContext, itemContextLine, measureSelection, measureSelectionSync, pluginEntry, type ContextMeasure } from '../../src/budget/measure.js';
import { budgetGate } from '../../src/cli/install-selection.js';

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
  const text = stripComments(block) + '@AGENTS.md\n'; // spec 3.4: the markers count 0, as contextSet counts them
  expect(block).toContain('<!--');
  expect(e).toEqual({ id: 'agents-md', tokens: estimateTokens(text), text });
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

test('harness-plugin also counts the agents plugin.json registers', async () => {
  const skills = readdirSync(join(plugin, 'skills')).reduce((n, d) => n + estimateTokens(alwaysLoadedText('skill', readFileSync(join(plugin, 'skills', d, 'SKILL.md'), 'utf8'))), 0);
  const agent = estimateTokens(alwaysLoadedText('agent', readFileSync(join(templates, 'agents/staff-reviewer.md'), 'utf8')));
  const r = await measureSelection([], cat(), dirs);
  expect(r.entries[0]!.tokens).toBe(skills + agent);
  expect(agent).toBeGreaterThan(0);
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
  expect(budgetLines(budgetVerdict(m(10), m(20), 2000))).toEqual(['Always-loaded context: ~20 tokens (estimate), budget 2,000; harness and its picks ~0.']);
  expect(budgetLines(budgetVerdict(m(10), m(3000, ['a', 'b']), 2000))).toEqual([
    'Always-loaded context: ~3,000 tokens (estimate), budget 2,000; harness and its picks ~0.',
    'Not measured before install: a, b.',
    'Over budget: confirm before installing.',
  ]);
});

test('budgetLines lists approved ids', () => {
  const after: ContextMeasure = { ...m(5), entries: [{ id: 'x', tokens: 9, exempt: true }, { id: 'y', tokens: 3 }, { id: 'z', tokens: null, exempt: true }] };
  expect(budgetLines(budgetVerdict(m(5), after, 2000))).toEqual([
    'Always-loaded context: ~5 tokens (estimate), budget 2,000; harness and its picks ~3.',
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

test('block descriptions with blank lines count in full', () => {
  const desc = 'line one\n\nline three';
  const t = alwaysLoadedText('skill', `---\nname: x\ndescription: |\n  line one\n\n  line three\n---\nbody`);
  expect(t).toBe(`name: x\ndescription: ${desc}`);
  expect(() => alwaysLoadedText('skill', '---\nname: [x\n---\nbody')).toThrow();
});

test('duplicate ids count once', async () => {
  const c = cat(rubric);
  expect((await measureSelection(['review-rubric', 'review-rubric'], c, dirs)).tokens).toBe((await measureSelection(['review-rubric'], c, dirs)).tokens);
});

test('config default equals DEFAULT_CONTEXT_BUDGET', () => {
  expect(defaults().context.budget_tokens).toBe(DEFAULT_CONTEXT_BUDGET);
});

test('extra entries add like items, in both measure functions', async () => {
  const extra = [{ id: 'core', tokens: 30 }, { id: 'plug', tokens: null }];
  const base = await measureSelection([], cat(), dirs);
  for (const r of [await measureSelection([], cat(), dirs, { extra }), measureSelectionSync([], cat(), dirs, { extra })]) {
    expect(r.tokens).toBe(base.tokens + 30);
    expect(r.entries.slice(-2)).toEqual(extra);
    expect(r.unmeasured).toEqual(['plug']);
  }
});

test('a skill with disable-model-invocation: true costs nothing', () => {
  expect(alwaysLoadedText('skill', '---\nname: x\ndescription: d\ndisable-model-invocation: true\n---\nbody')).toBe('');
  expect(alwaysLoadedText('skill', '---\nname: x\ndescription: d\ndisable-model-invocation: false\n---\nbody')).toBe('name: x\ndescription: d');
});

test('when_to_use is appended to the description after one space', () => {
  expect(alwaysLoadedText('skill', '---\nname: x\ndescription: Does X.\nwhen_to_use: Use it on X.\n---\n')).toBe('name: x\ndescription: Does X. Use it on X.');
});

test('the description part is cut at SKILL_DESCRIPTION_MAX', () => {
  const out = alwaysLoadedText('skill', `---\nname: x\ndescription: ${'a'.repeat(2000)}\nwhen_to_use: Use it.\n---\n`);
  expect(SKILL_DESCRIPTION_MAX).toBe(1536);
  expect(out).toBe(`name: x\ndescription: ${'a'.repeat(1536)}`);
});

test('pluginEntry counts only skills the model can invoke', () => {
  const root = mkdtempSync(join(tmpdir(), 'cb1-'));
  const skill = (n: string, extra: string) => { mkdirSync(join(root, 'skills', n), { recursive: true }); writeFileSync(join(root, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: d\n${extra}---\n`); };
  skill('off', 'disable-model-invocation: true\n');
  skill('on', '');
  const r = measureSelectionSync([], cat(), { templates, plugin: root });
  expect(r.entries.find((e) => e.id === 'harness-plugin')!.tokens).toBe(estimateTokens('name: on\ndescription: d'));
});

const BAD = '---\nname: x\ndescription: Set up: now\n---\nbody';
test('unparseable frontmatter is reported, not counted raw', () => {
  expect(() => alwaysLoadedText('skill', BAD)).toThrow(/frontmatter/);
  const root = mkdtempSync(join(tmpdir(), 'cb1-'));
  mkdirSync(join(root, 'skills', 'bad'), { recursive: true });
  writeFileSync(join(root, 'skills', 'bad', 'SKILL.md'), BAD);
  const r = measureSelectionSync([], cat(), { templates, plugin: root });
  expect(r.entries.find((e) => e.id === 'harness-plugin')!.tokens).toBeNull();
  expect(r.unmeasured).toContain('harness-plugin');
  const t = mkdtempSync(join(tmpdir(), 'cb1t-'));
  mkdirSync(join(t, 'skills', 'review-rubric'), { recursive: true });
  writeFileSync(join(t, 'skills', 'review-rubric', 'SKILL.md'), BAD);
  expect(itemContext(rubric, { templates: t })).toEqual({ id: 'review-rubric', tokens: null });
});

test('plugin and external-skill picks count the recorded context_tokens; MCP stays unmeasured', async () => {
  const withTokens = (i: CatalogItem, n: number): CatalogItem => ({ ...i, cost: { ...i.cost, context_tokens: n } });
  const p = withTokens(item('p', 'plugin', gh), 61);
  const s = withTokens(item('s', 'external-skill', gh), 0);
  const mcp = withTokens(item('m', 'mcp', { type: 'npm', package: 'x', version: '1.0.0' }), 9);
  expect(itemContext(p, dirs)).toEqual({ id: 'p', tokens: 61 });
  expect(itemContextLine(itemContext(p, dirs))).toBe('~61 tokens (estimate)');
  expect(itemContext(mcp, dirs).tokens).toBeNull();
  const none = item('q', 'plugin', gh);
  expect(itemContext(none, dirs).tokens).toBeNull();
  const base = (await measureSelection([], cat(), dirs)).tokens;
  const r = await measureSelection(['p', 's', 'q'], cat(p, s, none), dirs);
  expect(r.tokens - base).toBe(61);
  expect(r.unmeasured).toEqual(['q']);
});

test('a recorded plugin number survives an API count and keeps the result an estimate', async () => {
  const p = { ...item('p', 'plugin', gh), cost: { context: 'low', setup: 'none', context_tokens: 61 } } as CatalogItem;
  const base = await measureSelection([], cat(), dirs, { count: async (t) => Object.fromEntries(t.map((x) => [x.id, 5])) });
  const r = await measureSelection(['p'], cat(p), dirs, { count: async (t) => Object.fromEntries(t.map((x) => [x.id, 5])) });
  expect(r.entries.find((e) => e.id === 'p')!.tokens).toBe(61);
  expect(r.tokens - base.tokens).toBe(61);
  expect(r.method).toBe('estimate');
});

test('budgetLines: harness and its picks sums the non-exempt entries that are not the repo', () => {
  const after: ContextMeasure = { ...m(19), entries: [{ id: 'a', tokens: 7 }, { id: 'r', tokens: 12, owner: 'repo' }, { id: 'x', tokens: 9, exempt: true }, { id: 'n', tokens: null }] };
  expect(budgetLines(budgetVerdict(m(19), after, 2000))[0]).toBe('Always-loaded context: ~19 tokens (estimate), budget 2,000; harness and its picks ~7.');
});

// ---- budgetGate counts the repo's own context (spec 8, Q6) ----
const p120 = { ...item('p120', 'plugin', gh), cost: { context: 'low', setup: 'none', context_tokens: 120 } } as CatalogItem;
const harnessTokens = pluginEntry(plugin).tokens!;
const n = (x: number) => x.toLocaleString('en-US');
const gate = async (o: { claude?: boolean; before?: string[]; yes?: boolean; overBudget?: boolean; env?: NodeJS.ProcessEnv }) => {
  const root = mkdtempSync(join(tmpdir(), 'gate-'));
  if (o.claude !== false) writeFileSync(join(root, 'CLAUDE.md'), 'x'.repeat(7600)); // 1,900 tokens
  let out = '';
  const real = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('no network'); }) as typeof fetch;
  try {
    const code = await budgetGate({ cat: cat(p120), before: o.before ?? [], after: ['p120'], exempt: [], budget: harnessTokens + 2000, templatesDir: templates, root, env: o.env ?? {}, out: (s) => (out += s + '\n'), f: { yes: o.yes ?? false, dryRun: false, overBudget: o.overBudget ?? false } });
    return { code, out };
  } finally {
    globalThis.fetch = real;
  }
};

test('budgetGate: a 1,900-token repo CLAUDE.md plus a 120-token pick asks; without the file it does not', async () => {
  const r = await gate({});
  expect(r.code).toBeNull();
  expect(r.out).toContain(`Always-loaded context: ~${n(harnessTokens + 2020)} tokens (estimate), budget ${n(harnessTokens + 2000)}; harness and its picks ~${n(harnessTokens + 120)}.`);
  expect(r.out).toContain('Over budget: confirm before installing.');
  expect((await gate({ claude: false })).out).not.toContain('Over budget');
});

test('budgetGate: --yes with an ask and no --over-budget exits 2 with the M3 copy', async () => {
  const r = await gate({ yes: true });
  expect(r.code).toBe(2);
  expect(r.out).toContain(`This goes over the context budget (~${n(harnessTokens + 2020)} of ${n(harnessTokens + 2000)} tokens, estimate). Run again with --over-budget to accept, or pick fewer items.`);
  expect((await gate({ yes: true, overBudget: true })).code).toBeNull();
});

test('budgetGate: an unattended run is refused even with --over-budget --yes', async () => {
  for (const env of [{ CI: 'true' }, { HARNESS_UNATTENDED: '1' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
    const r = await gate({ yes: true, overBudget: true, env });
    expect(r.code).toBe(2);
    expect(r.out).toContain(`Not added: it would take always-loaded context past the budget of ${n(harnessTokens + 2000)} tokens, and no person is here to approve it. Run it in a session, or raise context.budget_tokens.`);
  }
});

test('budgetGate: a change that does not raise the total does not ask, even over the budget', async () => {
  const r = await gate({ before: ['p120'], yes: true, env: { CI: 'true' } });
  expect(r.code).toBeNull();
  expect(r.out).not.toContain('Over budget');
});
