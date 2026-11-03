import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkCatalog } from '../../src/catalog/check.js';
import { conflictPairs, requiresClosure } from '../../src/catalog/relations.js';
import { compactCatalog, loadCatalog } from '../../src/catalog/load.js';
import type { Catalog, CatalogItem } from '../../src/catalog/schema.js';

const item = (id: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({
  id, kind: 'plugin', title: id, source: { type: 'github', repo: 'a/b', plugin: id, sha: 'a'.repeat(40) }, license: 'MIT', min_claude_code: '2.1.0',
  applies_when: { always: true }, conflicts_with: [], requires: [], cost: { context: 'low', setup: 'none' }, stance: 'optional', stance_reason: '',
  side_effects: [], why: 'w', evidence: [], ...extra,
});
const cat = (...items: CatalogItem[]): Catalog => ({ version: 1, items });

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-cat-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  return d;
}
const y = (id: string) => `id: ${id}
kind: plugin
title: t
source: { type: github, repo: a/b, plugin: p, sha: ${'a'.repeat(40)} }
license: MIT
min_claude_code: 2.1.0
applies_when: { always: true }
cost: { context: low, setup: none }
stance: optional
why: w
`;

test('loadCatalog file-level checks give one message each', () => {
  const dup = loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': '[]', 'items/x.yaml': y('x'), 'items/y.yaml': y('x') }));
  expect(dup.errors).toEqual(['duplicate id "x" in x.yaml and y.yaml', 'y.yaml: file name must be x.yaml (the item id)']);
  expect(loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': '[]', 'items/other.yaml': y('x') })).errors).toEqual(['other.yaml: file name must be x.yaml (the item id)']);
  const ex = (a: string) => `- { id: ${a}, reason: r }\n`;
  expect(loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': ex('e') + ex('e') })).errors).toEqual(['duplicate excluded id "e"']);
  expect(loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': ex('x'), 'items/x.yaml': y('x') })).errors).toEqual(['"x" is in both items/ and excluded.yaml']);
  const none = loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': '[]' }));
  expect(none.errors).toEqual([]);
  expect(none.catalog.items).toEqual([]);
});

test('compactCatalog is sorted by id and drops source fields', () => {
  const c = compactCatalog(cat(item('b'), item('a')));
  expect(c.map((i) => i.id)).toEqual(['a', 'b']);
  expect(c[0]).not.toHaveProperty('source');
});

test('checkCatalog cross-item checks', () => {
  expect(checkCatalog(cat(item('a', { requires: ['zz'] })))).toEqual(['a: requires "zz", which is not in the catalog']);
  expect(checkCatalog(cat(item('a', { conflicts_with: ['zz'] })))).toEqual(['a: conflicts_with "zz", which is not in the catalog']);
  const own = item('o', { kind: 'own-skill', source: { type: 'own', files: [{ from: 'skills/nope/SKILL.md', to: 'x' }] } });
  expect(checkCatalog(cat(own), tmpdir())).toEqual([`o: source.files[0].from: template skills/nope/SKILL.md not found`]);
  expect(checkCatalog(cat(item('a', { requires: ['b'] }), item('b')))).toEqual([]);
});

test('checkCatalog rejects self-reference', () => {
  expect(checkCatalog(cat(item('a', { requires: ['a'], conflicts_with: ['a'] })))).toEqual(['a: requires "a": an item cannot list itself', 'a: conflicts_with "a": an item cannot list itself']);
});

test('excluded ids must look like item ids', () => {
  expect(loadCatalog(dir({ 'catalog.yaml': 'version: 1\n', 'excluded.yaml': '- { id: Bad_Id, reason: r }\n' })).errors).toEqual(['excluded.yaml[0]: id must be lowercase letters, digits and hyphens']);
});

test('conflictPairs is symmetric; requiresClosure is transitive', () => {
  const c = cat(item('a', { conflicts_with: ['b'] }), item('b'), item('c'));
  expect(conflictPairs(['a', 'b'], c)).toEqual([['a', 'b']]);
  expect(conflictPairs(['b', 'a'], c)).toEqual([['a', 'b']]);
  expect(conflictPairs(['a', 'c'], c)).toEqual([]);
  const r = cat(item('a', { requires: ['b'] }), item('b', { requires: ['c'] }), item('c'));
  expect(requiresClosure(['a'], r)).toEqual({ ids: ['a', 'b', 'c'], added: [{ id: 'b', by: 'a' }, { id: 'c', by: 'b' }] });
});

test('loadCatalog on the real catalog/ has no errors', () => {
  const r = loadCatalog();
  expect(r.errors).toEqual([]);
  expect(checkCatalog(r.catalog)).toEqual([]);
});
