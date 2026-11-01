import { describe, expect, it } from 'vitest';
import type { PackageFacts } from '../../src/install/detect.js';
import { removeBlocks } from '../../src/install/merge.js';
import { testConfigChange } from '../../src/install/test-config.js';
import { makeRepo } from './helpers.js';

const RD = '.harness/state/test-results';
const vt = (over: Partial<PackageFacts> = {}): PackageFacts => ({ dir: '.', name: 'demo', scripts: {}, test: 'vitest', testConfig: 'vitest.config.ts', ...over });
const jest = (script: string, over: Partial<PackageFacts> = {}): PackageFacts => ({ dir: '.', name: 'demo', scripts: { test: script }, test: 'jest', ...over });

function edit(files: Record<string, string>, pkg: PackageFacts, rel: string) {
  const root = makeRepo(files, { git: false });
  const r = testConfigChange(pkg, root, RD);
  if (!('change' in r)) throw new Error('expected change, got ' + JSON.stringify(r));
  const c = r.change;
  if (c.kind !== 'update') throw new Error('expected update');
  expect(c.rel).toBe(rel);
  expect(removeBlocks(c.after, c.blocks)).toBe(c.before);
  return c;
}

describe('testConfigChange vitest', () => {
  it('vitest defineConfig gets json reporter, keeping default', () => {
    const c = edit({ 'vitest.config.ts': "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    include: ['test/**'],\n  },\n});\n" }, vt(), 'vitest.config.ts');
    expect(c.after).toContain("reporters: ['default', 'json']");
    expect(c.after).toContain(`outputFile: { json: '${RD}/root.json' }`);
    expect(c.after).toContain("coverage: { reporter: ['text', 'json'] }");
    expect(c.after).toContain("include: ['test/**'],");
  });

  it('vitest existing reporters kept', () => {
    const c = edit({ 'vitest.config.ts': "export default { test: { reporters: ['verbose'], coverage: { provider: 'v8', reporter: ['html'] } } };\n" }, vt(), 'vitest.config.ts');
    expect(c.after).toContain("reporters: ['verbose', 'json']");
    expect(c.after).toContain("reporter: ['html', 'json']");
    expect(c.after).toContain("provider: 'v8'");
  });

  it('vite.config with test key edited', () => {
    const c = edit({ 'packages/a/vite.config.ts': "import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [],\n  test: { globals: true },\n});\n" }, vt({ testConfig: 'vite.config.ts', dir: 'packages/a', name: '@s/a' }), 'packages/a/vite.config.ts');
    expect(c.after).toContain("json: '../../.harness/state/test-results/s__a.json'");
    expect(c.after).toContain('globals: true');
  });

  it('already configured returns none', () => {
    const root = makeRepo({ 'vitest.config.ts': `export default { test: { reporters: ['default', 'json'], outputFile: { json: '${RD}/root.json' }, coverage: { reporter: ['text', 'json'] } } };\n` }, { git: false });
    expect(testConfigChange(vt(), root, RD)).toEqual({ none: true });
  });

  it('mergeConfig chain returns manual lines', () => {
    const root = makeRepo({ 'vitest.config.ts': "import base from './vite.config';\nexport default mergeConfig(base, defineConfig({ test: {} }));\n" }, { git: false });
    const r = testConfigChange(vt(), root, RD);
    expect(r).toHaveProperty('manual');
    const m = (r as { manual: string[] }).manual.join('\n');
    expect(m).toContain("reporters: ['default', 'json']");
    expect(m).toContain(`${RD}/root.json`);
  });

  it('CRLF config keeps CRLF', () => {
    const c = edit({ 'vitest.config.ts': "export default {\r\n  test: {\r\n    globals: true,\r\n  },\r\n};\r\n" }, vt(), 'vitest.config.ts');
    expect(c.after.replace(/\r\n/g, '')).not.toMatch(/\n/);
    expect(c.after).toContain('reporters');
  });
});

describe('testConfigChange jest', () => {
  const pj = (s: string) => JSON.stringify({ name: 'demo', scripts: { test: s } }, null, 2) + '\n';

  it('jest script appended', () => {
    const c = edit({ 'package.json': pj('jest --silent') }, jest('jest --silent'), 'package.json');
    expect(JSON.parse(c.after).scripts.test).toBe(`jest --silent --json --outputFile=${RD}/root.json --coverage`);
  });

  it('jest script with --json untouched', () => {
    const root = makeRepo({ 'package.json': pj('jest --json') }, { git: false });
    expect(testConfigChange(jest('jest --json'), root, RD)).toEqual({ none: true });
  });

  it('jest script via a wrapper returns manual', () => {
    const root = makeRepo({ 'package.json': pj('cross-env CI=1 jest') }, { git: false });
    expect(testConfigChange(jest('cross-env CI=1 jest'), root, RD)).toHaveProperty('manual');
  });
});

it('none for packages without a test runner', () => {
  expect(testConfigChange({ dir: '.', scripts: {}, test: 'none' }, '/nowhere', RD)).toEqual({ none: true });
});
