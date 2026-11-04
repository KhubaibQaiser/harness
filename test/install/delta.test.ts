import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import { defaults } from '../../src/core/config.js';
import { catalogDelta, contradictions } from '../../src/install/delta.js';
import type { Facts } from '../../src/install/detect.js';

const { catalog } = loadCatalog('test/fixtures/catalog');
const GSAP = '0123456789abcdef0123456789abcdef01234567';
const cfg = (...rows: [string, string?][]) => ({ ...defaults(), items: rows.map(([id, pin = '']) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin })) });

test('catalogDelta: nothing differs', () => {
  expect(catalogDelta(cfg(['base'], ['gsap-skills', GSAP]), catalog)).toEqual({ changed: [], retired: [], conflicting: [] });
});

test('catalogDelta: a changed pin', () => {
  expect(catalogDelta(cfg(['base'], ['gsap-skills', 'old']), catalog).changed).toEqual(['gsap-skills']);
});

test('catalogDelta: an id missing from the catalog is retired', () => {
  expect(catalogDelta(cfg(['base'], ['gone']), catalog)).toMatchObject({ retired: ['gone'], changed: [] });
});

test('catalogDelta: selected items that now conflict', () => {
  expect(catalogDelta(cfg(['lead-a'], ['lead-b']), catalog).conflicting).toEqual([['lead-a', 'lead-b']]);
});

const facts = (over: Partial<Facts> = {}) => ({ apps: [], deploy: [], ...over }) as Facts;
const app = { dir: 'web', kind: 'web' as const };

test('contradictions: only the contradicted keys', () => {
  const c = cfg();
  expect(contradictions(facts(), facts(), c)).toEqual([]);
  expect(contradictions(facts(), facts({ apps: [app] }), c)).toEqual(['apps']);
  expect(contradictions(facts({ apps: [app] }), facts(), c)).toEqual(['apps']);
  expect(contradictions(facts(), facts({ deploy: ['vercel'] }), c)).toEqual(['project.deploy_target']);
  expect(contradictions(facts(), facts({ apps: [app], deploy: ['fly'] }), c)).toEqual(['apps', 'project.deploy_target']);
});

test('contradictions: no stored facts re-asks nothing', () => {
  expect(contradictions(null, facts({ apps: [app], deploy: ['fly'] }), cfg())).toEqual([]);
});
