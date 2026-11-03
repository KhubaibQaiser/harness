import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';

// Each batch task appends its ids here.
const BATCHES: Record<number, string[]> = {
  1: [
    'frontend-design', 'impeccable', 'ui-ux-pro-max', 'taste-skill', 'superdesign', 'design',
    'web-design-guidelines', 'react-best-practices', 'vercel-react-native-skills', 'modern-web-guidance', 'emilkowalski-skills', 'web-quality-skills', 'shadcn', 'shadcn-mcp', 'figma',
    'gsap-skills', 'threejs-skills', 'motion-ai-kit', 'spline-mcp', 'mcp-for-blender',
  ],
};

test.each(Object.entries(BATCHES))('batch %s ids are all in items/ or excluded.yaml', (_n, ids) => {
  const { catalog, excluded, errors } = loadCatalog();
  expect(errors).toEqual([]);
  const items = new Set(catalog.items.map((i) => i.id));
  const out = new Set(excluded.map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect([id, items.has(id) || out.has(id), items.has(id) && out.has(id)]).toEqual([id, true, false]);
});

test('stances from the brief', () => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  expect(by.get('frontend-design')?.stance).toBe('default');
  expect(by.get('superdesign')).toMatchObject({ stance: 'discouraged', stance_reason: 'duplicates Figma' });
  expect(by.get('impeccable')?.side_effects).toEqual(['installs-hook', 'downloads-binary', 'telemetry-on-by-default']);
});
