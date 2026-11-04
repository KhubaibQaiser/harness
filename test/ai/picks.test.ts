import { expect, test } from 'vitest';
import { validatePicks } from '../../src/ai/picks.js';
import { loadCatalog } from '../../src/catalog/load.js';

const { catalog } = loadCatalog('test/fixtures/catalog');
const ans = (named: string[] = []) => ({ project: { named_items: named } }) as any;
const f = (id = 'f1') => ({ id, severity: 'medium', title: 'A finding' });
const it = (id: string, over: Record<string, unknown> = {}) => ({ id, include: 'recommended', reason: 'Because it helps.', addresses: ['f1'], ...over });
const picks = (items: unknown[], over: Record<string, unknown> = {}) => ({ catalog_version: 1, findings: [f()], items, ...over });
const errs = (raw: unknown, a = ans()) => {
  const r = validatePicks(raw, catalog, a);
  return r.ok ? [] : r.errors;
};

test('a valid picks file passes', () => expect(validatePicks(picks([it('lead-a'), it('base')]), catalog, ans()).ok).toBe(true));
test('unknown id fails', () => expect(errs(picks([it('lead-a'), it('base'), it('foo')]))).toEqual(['items[2].id: unknown item "foo"']));
test('conflicting picks fail in either direction', () => {
  const e = ['items: "lead-a" conflicts with "lead-b"'];
  expect(errs(picks([it('lead-a'), it('lead-b')]))).toEqual(e);
  expect(errs(picks([it('lead-b'), it('lead-a')]))).toEqual(e);
});
test('missing reason fails', () => expect(errs(picks([it('lead-a', { reason: ' ' })]))).toEqual(['items[0].reason: must be a non-empty sentence']));
test('discouraged needs the user to name it or a no_alternative reason', () => {
  expect(errs(picks([it('lead-a'), it('quiet')]))).toEqual(['items[1]: "quiet" is discouraged (overlaps lead-a); propose it only when the user names it or no alternative fits, and say why in no_alternative']);
  expect(errs(picks([it('lead-a'), it('quiet')]), ans(['quiet']))).toEqual([]);
  expect(errs(picks([it('lead-a'), it('quiet', { no_alternative: 'nothing else fits' })]))).toEqual([]);
});
test('addresses must name findings', () => {
  expect(errs(picks([it('lead-a', { addresses: ['zz'] })]))).toEqual(['items[0].addresses[0]: unknown finding "zz"']);
  expect(errs(picks([it('lead-a')], { findings: [f(), f()] }))).toEqual(['findings[1].id: duplicate "f1"']);
});
test('catalog_version must match', () => expect(errs(picks([it('lead-a')], { catalog_version: 0 }))).toEqual(['catalog_version: picks are for catalog 0, this harness has catalog 1']));
test('requires is not auto-added here', () => expect(errs(picks([it('extra')]))).toEqual([]));
test('echoed text is escaped', () => expect(errs(picks([it('a\u001b[2Jb')]))[0]).toBe('items[0].id: unknown item "a\\u001b[2Jb"'));

test('control characters in free text are rejected', () => {
  const bad = 'ok \u001b[2J \u009b31m ‮';
  for (const [name, raw] of [
    ['items[0].reason', picks([it('lead-a', { reason: bad })])],
    ['items[0].no_alternative', picks([it('lead-a', { no_alternative: bad })])],
    ['findings[0].title', picks([it('lead-a')], { findings: [{ ...f(), title: bad }] })],
    ['findings[0].id', picks([it('lead-a', { addresses: [] })], { findings: [{ ...f(bad) }] })],
  ] as const) expect(errs(raw).join('\n'), name).toContain(`${name}: must not contain control characters`);
});
