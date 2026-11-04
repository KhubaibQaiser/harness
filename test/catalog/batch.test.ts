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

// Stances from the brief table; every other batch item is optional.
const STANCES: Record<number, Record<string, { stance: string; reason?: string }>> = {
  1: { 'frontend-design': { stance: 'default' }, superdesign: { stance: 'discouraged', reason: 'duplicates Figma' } },
};

test.each(Object.entries(BATCHES))('batch %s stances and reasons match the brief', (n, ids) => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  const want = STANCES[Number(n)] ?? {};
  for (const item of ids.map((id) => by.get(id)).filter((i) => i !== undefined)) {
    const w = want[item.id] ?? { stance: 'optional' };
    expect([item.id, item.stance, item.stance_reason]).toEqual([item.id, w.stance, w.reason ?? '']);
  }
});

test('impeccable side effects and mcp config shapes', () => {
  const items = loadCatalog().catalog.items;
  expect(items.find((i) => i.id === 'impeccable')?.side_effects).toEqual(['installs-hook', 'downloads-binary', 'telemetry-on-by-default']);
  for (const i of items.filter((x) => x.kind === 'mcp')) {
    const c = i.mcp!.config;
    expect(c.command !== undefined || (c.type === 'http' && typeof c.url === 'string'), i.id).toBe(true);
  }
});
