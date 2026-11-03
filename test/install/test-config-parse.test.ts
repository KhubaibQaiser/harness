import { expect, it, vi } from 'vitest';
import type { PackageFacts } from '../../src/install/detect.js';

// The first parse reads the original config; the second (the check of the edited text) fails.
const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock('magicast', async (orig) => {
  const m = await orig<typeof import('magicast')>();
  return { ...m, parseModule: (s: string) => { if (++calls.n > 1) throw new Error('boom'); return m.parseModule(s); } };
});
const { testConfigChange } = await import('../../src/install/test-config.js');
const { makeRepo } = await import('./helpers.js');

it('edit that fails to parse falls back to manual', () => {
  const root = makeRepo({ 'vitest.config.ts': 'export default { test: {} };\n' }, { git: false });
  const pkg: PackageFacts = { dir: '.', scripts: {}, test: 'vitest', testConfig: 'vitest.config.ts' };
  expect(testConfigChange(pkg, root, '.harness/results')).toHaveProperty('manual');
});
