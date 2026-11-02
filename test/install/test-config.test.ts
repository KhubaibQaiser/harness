import { parseModule } from 'magicast';
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
    expect(c.after).toContain("coverage: { enabled: true, reporter: ['text', 'json'] }");
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
    const root = makeRepo({ 'vitest.config.ts': `export default { test: { reporters: ['default', 'json'], outputFile: { json: '${RD}/root.json' }, coverage: { enabled: true, reporter: ['text', 'json'] } } };\n` }, { git: false });
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
    expect(() => parseModule(c.after)).not.toThrow();
    expect(c.after).toContain('globals: true,');
  });
});

describe('testConfigChange vitest fixes', () => {
  it('empty test object gets one valid insert', () => {
    const c = edit({ 'vitest.config.ts': 'export default { test: {} };\n' }, vt(), 'vitest.config.ts');
    expect(c.blocks).toHaveLength(1);
    expect(() => parseModule(c.after)).not.toThrow();
    for (const k of ['reporters', 'outputFile', 'coverage']) expect(c.after).toContain(k + ':');
  });

  it('coverage enabled added', () => {
    const c = edit({ 'vitest.config.ts': "export default { test: { coverage: { provider: 'v8' } } };\n" }, vt(), 'vitest.config.ts');
    expect(c.after).toContain('enabled: true');
    const d = edit({ 'vitest.config.ts': 'export default { test: {} };\n' }, vt(), 'vitest.config.ts');
    expect(d.after).toContain('enabled: true');
  });

  it('script with --coverage leaves enabled alone', () => {
    const c = edit({ 'vitest.config.ts': 'export default { test: {} };\n' }, vt({ scripts: { test: 'vitest run --coverage' } }), 'vitest.config.ts');
    expect(c.after).not.toContain('enabled');
  });

  it('existing enabled kept', () => {
    const c = edit({ 'vitest.config.ts': 'export default { test: { coverage: { enabled: false } } };\n' }, vt(), 'vitest.config.ts');
    expect(c.after).toContain('enabled: false');
    expect(c.after).not.toContain('enabled: true');
  });

  it('manual header names the file to create when there is no config', () => {
    const root = makeRepo({}, { git: false });
    const r = testConfigChange(vt({ dir: 'packages/a', testConfig: undefined }), root, RD) as { manual: string[] };
    expect(r.manual[0]).toBe('Create `packages/a/vitest.config.ts` with:');
    expect(r.manual.join('\n')).not.toContain('undefined');
  });
});

describe('testConfigChange jest', () => {
  const pj = (s: string) => JSON.stringify({ name: 'demo', scripts: { test: s } }, null, 2) + '\n';

  const FLAGS = '--reporters=default --reporters=./.harness/hooks/jest-results.cjs "--modulePathIgnorePatterns=<rootDir>/.harness"';

  it('jest script gets the harness reporter, the results path, coverage and the .harness ignore', () => {
    const c = edit({ 'package.json': pj('jest --silent') }, jest('jest --silent'), 'package.json');
    expect(JSON.parse(c.after).scripts.test).toBe(`jest --silent ${FLAGS} --outputFile=${RD}/root.json --coverage`);
  });

  it('jest script that already has --coverage keeps one', () => {
    const c = edit({ 'package.json': pj('jest --coverage') }, jest('jest --coverage'), 'package.json');
    expect(JSON.parse(c.after).scripts.test).toBe(`jest --coverage ${FLAGS} --outputFile=${RD}/root.json`);
  });

  it('monorepo package: reporter path relative to the package, results named after the package', () => {
    const files = { 'packages/a/package.json': pj('jest') };
    const root = makeRepo(files, { git: false });
    const r = testConfigChange(jest('jest', { dir: 'packages/a', name: '@acme/a' }), root, RD) as { change: { after: string } };
    expect(JSON.parse(r.change.after).scripts.test).toBe(
      `jest --reporters=default --reporters=../../.harness/hooks/jest-results.cjs "--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=../../${RD}/acme__a.json --coverage`,
    );
  });

  it('jest script already set up is untouched', () => {
    const s = `jest ${FLAGS} --outputFile=${RD}/root.json --coverage`;
    const root = makeRepo({ 'package.json': pj(s) }, { git: false });
    expect(testConfigChange(jest(s), root, RD)).toEqual({ none: true });
  });

  it('jest script with its own --json or --outputFile, or a custom rootDir, returns manual', () => {
    for (const s of ['jest --json', 'jest --outputFile=x.json']) {
      const root = makeRepo({ 'package.json': pj(s) }, { git: false });
      expect(testConfigChange(jest(s), root, RD), s).toHaveProperty('manual');
    }
    const root = makeRepo({ 'package.json': pj('jest'), 'jest.config.js': "module.exports = { rootDir: 'src' };\n" }, { git: false });
    expect(testConfigChange(jest('jest', { testConfig: 'jest.config.js' }), root, RD)).toHaveProperty('manual');
  });

  it('jest manual line names the reporter flags', () => {
    const root = makeRepo({ 'package.json': pj('cross-env CI=1 jest') }, { git: false });
    const r = testConfigChange(jest('cross-env CI=1 jest'), root, RD) as { manual: string[] };
    expect(r.manual[0]).toBe(`package.json: add \`${FLAGS} --outputFile=${RD}/root.json --coverage\` to the jest call in the "test" script`);
  });

  it('jest script via a wrapper returns manual', () => {
    const root = makeRepo({ 'package.json': pj('cross-env CI=1 jest') }, { git: false });
    expect(testConfigChange(jest('cross-env CI=1 jest'), root, RD)).toHaveProperty('manual');
  });
});

it('none for packages without a test runner', () => {
  expect(testConfigChange({ dir: '.', scripts: {}, test: 'none' }, '/nowhere', RD)).toEqual({ none: true });
});

describe('testConfigChange vitest without a coverage provider', () => {
  it('adds the json reporter and outputFile but does not enable coverage', () => {
    const c = edit({ 'vitest.config.ts': "export default { test: {} };\n" }, vt({ noCoverageProvider: true }), 'vitest.config.ts');
    expect(c.after).toContain(`outputFile: { json: '${RD}/root.json' }`);
    expect(c.after).not.toContain('enabled: true');
    const m = testConfigChange(vt({ noCoverageProvider: true, testConfig: undefined }), makeRepo({}, { git: false }), RD) as { manual: string[] };
    expect(m.manual.join('\n')).not.toContain('enabled: true');
  });
});
