import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { defaults, type HarnessConfig } from '../../src/core/config.js';
import { makeRepo } from '../install/helpers.js';

// Stands in for #152: a recorded cost.context_tokens makes itemContext return a number for a plugin pick.
vi.mock('../../src/budget/measure.js', async (orig) => {
  const m = await orig<typeof import('../../src/budget/measure.js')>();
  return { ...m, measureSelectionSync: (...a: Parameters<typeof m.measureSelectionSync>) => {
    const r = m.measureSelectionSync(...a);
    const entries = r.entries.map((e) => (e.id === 'p1' ? { ...e, tokens: 61 } : e));
    return { ...r, entries, unmeasured: r.unmeasured.filter((id) => id !== 'p1') };
  } };
});
const { contextSet } = await import('../../src/budget/summary.js');

test('a measured plugin pick is a catalog row that counts in `catalog`, not unmeasured', () => {
  const y = readFileSync(join(__dirname, '../../catalog/items/auth0.yaml'), 'utf8').replace(/^id: .*$/m, 'id: p1');
  const cat = makeRepo({ 'catalog.yaml': 'version: 1\n', 'items/p1.yaml': y }, { git: false });
  const root = makeRepo({ 'CLAUDE.md': 'x' }, { git: false });
  const config: HarnessConfig = { ...defaults(), items: [{ id: 'p1', include: 'optional', selected: true }] as HarnessConfig['items'] };
  const s = contextSet(root, config, { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') }, undefined, cat);
  expect(s.always.find((e) => e.owner === 'catalog:p1')).toMatchObject({ tokens: 61, path: 'catalog:p1', chars: 0, note: 'size from the catalog record' });
  expect(s.catalog).toBe(61);
  expect(s.unmeasured).not.toContain('plugin: p1');
  expect(s.total).toBe(s.harness + 61 + s.repo);
});
