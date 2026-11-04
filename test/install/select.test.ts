import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import { checklist, notPicked, resolveSelection, toSelected } from '../../src/install/select.js';

const dirs = { templates: 'templates' };
const { catalog } = loadCatalog('test/fixtures/catalog');
const pk = (id: string, include: 'recommended' | 'optional' = 'recommended', over = {}) => ({ id, include, reason: `Why ${id}.`, addresses: [], ...over });
const picks = (...items: ReturnType<typeof pk>[]) => ({ catalog_version: 1, findings: [], items });

test('checklist order and local_only', () => {
  const rows = checklist(picks(pk('lead-a', 'optional'), pk('gsap-skills'), pk('base'), pk('extra', 'optional')), catalog, dirs);
  expect(rows.map((r) => r.id)).toEqual(['base', 'gsap-skills', 'extra', 'lead-a']);
  expect(rows.map((r) => r.ticked)).toEqual([true, true, false, false]);
  expect(rows.map((r) => r.local_only)).toEqual([false, true, false, false]);
  expect(rows[0]).toMatchObject({ title: 'Fixture base', reason: 'Why base.', cost: 'context low, setup none', context: '~0 tokens (estimate)', side_effects: [], include: 'recommended' });
});

test('requires auto-selects with a notice, transitively', () => {
  const r = resolveSelection(['deep'], catalog, null);
  expect(r.ids).toEqual(['deep', 'extra', 'base']);
  expect(r.notices).toEqual(['Added extra because deep requires it.', 'Added base because extra requires it.', 'Claude Code version unknown; not checking which items need a newer Claude Code.']);
  expect(r.errors).toEqual([]);
});

test('required ids appear in toSelected with Required by', () => {
  const p = picks(pk('deep'), pk('lead-a', 'optional', { addresses: ['f1'] }));
  const { ids } = resolveSelection(['deep'], catalog, null);
  const s = toSelected(p, ids, catalog);
  expect(s.map((x) => [x.id, x.selected])).toEqual([['deep', true], ['lead-a', false], ['extra', true], ['base', true]]);
  expect(s[2]).toEqual({ id: 'extra', include: 'optional', selected: true, reason: 'Required by deep.', addresses: [], pin: '' });
  expect(toSelected(picks(pk('gsap-skills')), ['gsap-skills'], catalog)[0].pin).toBe('0123456789abcdef0123456789abcdef01234567');
});

test('conflicts block both', () => {
  expect(resolveSelection(['lead-b', 'lead-a'], catalog, null).errors).toEqual(['lead-a and lead-b conflict; pick one.']);
});

test('discouraged rows carry stance_reason and no_alternative', () => {
  const [row] = checklist(picks(pk('quiet', 'optional', { no_alternative: 'nothing else fits' })), catalog, dirs);
  expect(row).toMatchObject({ stance_reason: 'overlaps lead-a', no_alternative: 'nothing else fits' });
});

test('min_claude_code above the installed version is skipped with the notice', () => {
  const r = resolveSelection(['base', 'newer'], catalog, '2.1.314');
  expect(r.ids).toEqual(['base']);
  expect(r.notices).toEqual(['Skipped newer: needs Claude Code 2.1.400 or newer (you have 2.1.314).']);
  expect(resolveSelection(['newer'], catalog, null).ids).toEqual(['newer']);
});

test('unknown chosen id is an error, escaped', () => {
  const r = resolveSelection(['nope\u001b[2J'], catalog, null);
  expect(r.errors).toEqual(['Unknown item "nope\\u001b[2J".']);
  expect(r.ids).toEqual([]);
});

test('a dependent of a version-skipped item is skipped too, transitively', () => {
  const r = resolveSelection(['needs-newer'], catalog, '2.1.314');
  expect(r.ids).toEqual([]);
  expect(r.notices).toEqual(['Skipped newer: needs Claude Code 2.1.400 or newer (you have 2.1.314).', 'Skipped needs-newer: requires newer, which needs a newer Claude Code.']);
  expect(resolveSelection(['needs-newer', 'base'], catalog, '2.1.314').ids).toEqual(['base']);
  expect(resolveSelection(['needs-newer'], catalog, '2.1.500').ids).toEqual(['needs-newer', 'newer']);
});

test('duplicate chosen ids collapse; a chosen id outside the picks is Chosen by you', () => {
  expect(resolveSelection(['base', 'base'], catalog, null).ids).toEqual(['base']);
  const s = toSelected(picks(pk('deep')), ['deep', 'extra', 'base', 'lead-a'], catalog);
  expect(s.slice(1).map((x) => x.reason)).toEqual(['Required by deep.', 'Required by extra.', 'Chosen by you.']);
});

test('C1 controls in an id are escaped', () => {
  expect(resolveSelection(['a\u009bb'], catalog, null).errors).toEqual(['Unknown item "a\\u009bb".']);
});

test('checklist rows show the context line', () => {
  const rows = checklist(picks(pk('base'), pk('gsap-skills')), catalog, dirs);
  expect(rows.map((r) => r.context)).toEqual(['~0 tokens (estimate)', 'not measured before install']);
});

test('checklist flags items that run unpinned code', () => {
  const c = { ...catalog, items: catalog.items.map((i) => (i.id === 'base' ? { ...i, unpinned_runtime: 'runs npx base@latest' } : i)) };
  const [a, b] = checklist(picks(pk('base'), pk('extra')), c, dirs);
  expect(a).toMatchObject({ id: 'base', unpinned: 'Runs unpinned code at launch.', unpinned_reason: 'runs npx base@latest' });
  expect(b).toMatchObject({ id: 'extra', unpinned: '', unpinned_reason: '' });
});
test('notPicked names chosen ids outside the picks, not ids pulled in by requires', () => {
  const p = picks(pk('deep'));
  expect(notPicked(['deep', 'lead-a\u001b'], p, catalog)).toEqual(['"lead-a\\u001b" was not in the picks; run the recommend step again or pick from the checklist.']);
  expect(notPicked(['deep', 'extra', 'base'], p, catalog)).toEqual([]);
});

test('an empty selection after filtering is an error', () => {
  const r = resolveSelection(['newer'], catalog, '2.1.314');
  expect(r.ids).toEqual([]);
  expect(r.errors).toEqual(['Nothing is left to install: every chosen item was skipped.']);
});

test('an unknown Claude Code version is a notice', () => {
  expect(resolveSelection(['base'], catalog, null).notices).toEqual(['Claude Code version unknown; not checking which items need a newer Claude Code.']);
  expect(resolveSelection(['base'], catalog, '2.1.500').notices).toEqual([]);
});
