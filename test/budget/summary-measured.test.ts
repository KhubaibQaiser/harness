import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { contextSet } from '../../src/budget/summary.js';
import { defaults, type HarnessConfig } from '../../src/core/config.js';
import { makeRepo } from '../install/helpers.js';

test('a plugin pick with a recorded cost.context_tokens is a catalog row that counts in `catalog`', () => {
  const y = readFileSync(join(__dirname, '../../catalog/items/auth0.yaml'), 'utf8').replace(/^id: .*$/m, 'id: p1').replace(/^cost: .*$/m, 'cost: {"context":"low","setup":"low","context_tokens":61}');
  const cat = makeRepo({ 'catalog.yaml': 'version: 1\n', 'items/p1.yaml': y }, { git: false });
  const root = makeRepo({ 'CLAUDE.md': 'x' }, { git: false });
  const config: HarnessConfig = { ...defaults(), items: [{ id: 'p1', include: 'optional', selected: true }] as HarnessConfig['items'] };
  const s = contextSet(root, config, { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') }, undefined, { catalogDir: cat });
  expect(s.always.find((e) => e.owner === 'catalog:p1')).toMatchObject({ tokens: 61, path: 'catalog:p1', chars: 0, note: 'size from the catalog record' });
  expect(s.catalog).toBe(61);
  expect(s.unmeasured).not.toContain('plugin: p1');
  expect(s.total).toBe(s.harness + 61 + s.repo);
});
