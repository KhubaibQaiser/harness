import { parseModule } from 'magicast';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PackageFacts } from '../../src/install/detect.js';
import { removeBlocks } from '../../src/install/merge.js';
import { resultsRename, testConfigChange } from '../../src/install/test-config.js';
import { makeRepo } from './helpers.js';

const RD = '.harness/results';
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
    expect(c.after).toContain("json: '../../.harness/results/s__a.json'");
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

describe('testConfigChange jest: configs the script flags would break or override', () => {
  const pj = (s: string, jest?: object) => JSON.stringify({ name: 'demo', scripts: { test: s }, ...(jest ? { jest } : {}) }, null, 2) + '\n';
  const REP = './.harness/hooks/jest-results.cjs';

  it.each(['jest --config=config/jest.config.js', 'jest --config config/jest.config.js', 'jest -c config/jest.config.js', 'jest --projects a b', 'jest --rootDir=src'])(
    '%s returns manual (rootDir moves where the reporter resolves)',
    (s) => {
      const root = makeRepo({ 'package.json': pj(s) }, { git: false });
      expect(testConfigChange(jest(s), root, RD)).toHaveProperty('manual');
    },
  );

  it('jest.config.js with reporters: manual line with the merged reporters, the rest stays a script flag', () => {
    const root = makeRepo({ 'package.json': pj('jest'), 'jest.config.js': "module.exports = {\n  reporters: ['default', 'jest-junit'],\n};\n" }, { git: false });
    const r = testConfigChange(jest('jest', { testConfig: 'jest.config.js' }), root, RD) as { manual: string[] };
    expect(r.manual).toEqual([
      `jest.config.js: set \`reporters: ['default', 'jest-junit', '${REP}']\``,
      `package.json: add \`"--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=${RD}/root.json --coverage\` to the jest call in the "test" script`,
    ]);
  });

  it('package.json jest key with both keys: both merged in the manual lines', () => {
    const files = { 'package.json': pj('jest', { reporters: ['default'], modulePathIgnorePatterns: ['<rootDir>/dist'] }) };
    const root = makeRepo(files, { git: false });
    const r = testConfigChange(jest('jest'), root, RD) as { manual: string[] };
    expect(r.manual).toEqual([
      `package.json: set \`"jest": { "reporters": ["default","${REP}"] }\``,
      `package.json: set \`"jest": { "modulePathIgnorePatterns": ["<rootDir>/dist","<rootDir>/.harness"] }\``,
      `package.json: add \`--outputFile=${RD}/root.json --coverage\` to the jest call in the "test" script`,
    ]);
  });

  it('a jest.config.ts whose reporters is not a literal array gets a plain instruction', () => {
    const root = makeRepo({ 'package.json': pj('jest'), 'jest.config.ts': 'export default { reporters: base.reporters };\n' }, { git: false });
    const r = testConfigChange(jest('jest', { testConfig: 'jest.config.ts' }), root, RD) as { manual: string[] };
    expect(r.manual[0]).toBe(`jest.config.ts: add '${REP}' to \`reporters\``);
  });
});

describe('testConfigChange jest: migrating the pre-reporter script', () => {
  const pj = (s: string) => JSON.stringify({ name: 'demo', scripts: { test: s } }, null, 2) + '\n';
  it.each([
    ['jest --silent', ` --json --outputFile=${RD}/root.json --coverage`],
    ['jest --coverage', ` --json --outputFile=${RD}/root.json`],
  ])('%s with the old flags becomes the reporter form; removing the new block restores the original', (orig, old) => {
    const root = makeRepo({ 'package.json': pj(orig + old) }, { git: false });
    const r = testConfigChange(jest(orig + old), root, RD) as { change: { before: string; after: string; blocks: string[] } };
    const fresh = testConfigChange(jest(orig), makeRepo({ 'package.json': pj(orig) }, { git: false }), RD) as { change: { after: string } };
    expect(r.change.after).toBe(fresh.change.after);
    expect(removeBlocks(r.change.after, r.change.blocks)).toBe(pj(orig));
  });
});

describe('testConfigChange jest: inherited config (base spreads, presets, functions) is never overridden', () => {
  const pj = (jest?: object) => JSON.stringify({ name: 'demo', scripts: { test: 'jest' }, ...(jest ? { jest } : {}) }, null, 2) + '\n';
  it.each([
    "module.exports = { ...require('../../jest.base.js'), testMatch: ['**/*.test.js'] };\n",
    "module.exports = require('../../jest.base.js');\n",
    "module.exports = { preset: '../../jest.preset.js' };\n",
    'module.exports = async () => ({ testMatch: [] });\n',
    'export default base;\n',
  ])('jest.config.js %j returns manual, with the reporter and ignore in the config, not as script flags', (cfg) => {
    const root = makeRepo({ 'package.json': pj(), 'jest.config.js': cfg }, { git: false });
    const r = testConfigChange(jest('jest', { testConfig: 'jest.config.js' }), root, RD) as { manual: string[] };
    expect(r.manual).toEqual([
      "jest.config.js: add './.harness/hooks/jest-results.cjs' to `reporters`, keeping the ones it inherits (if it sets none, use `['default', './.harness/hooks/jest-results.cjs']` so Jest keeps its console output)",
      "jest.config.js: add '<rootDir>/.harness' to `modulePathIgnorePatterns`",
      `package.json: add \`--outputFile=${RD}/root.json --coverage\` to the jest call in the "test" script`,
    ]);
  });

  it('package.json jest.preset returns manual', () => {
    const root = makeRepo({ 'package.json': pj({ preset: 'ts-jest' }) }, { git: false });
    expect(testConfigChange(jest('jest'), root, RD)).toHaveProperty('manual');
  });

  it('a plain literal config is still edited', () => {
    const root = makeRepo({ 'package.json': pj(), 'jest.config.js': "module.exports = { testMatch: ['**/*.test.js'] };\n" }, { git: false });
    expect(testConfigChange(jest('jest', { testConfig: 'jest.config.js' }), root, RD)).toHaveProperty('change');
  });
});

describe('testConfigChange jest: an old-form script in a package that now needs manual lines', () => {
  it('says to remove the old flags, and hasResultsOutput no longer counts it as set up', async () => {
    const { hasResultsOutput } = await import('../../src/install/test-config.js');
    const s = `jest --config=config/jest.config.js --json --outputFile=${RD}/root.json --coverage`;
    const root = makeRepo({ 'package.json': JSON.stringify({ name: 'demo', scripts: { test: s } }) }, { git: false });
    const r = testConfigChange(jest(s), root, RD) as { manual: string[] };
    expect(r.manual[0]).toBe(`package.json: remove \`--json --outputFile=${RD}/root.json --coverage\` from the "test" script; Jest does not create the results folder, so it fails on a fresh clone`);
    expect(hasResultsOutput(jest(s), root, RD)).toBe(false);
  });
});

// C2: the inserted text follows the file's quotes and Prettier's layout, so a Prettier-clean config stays clean.
describe('testConfigChange vitest: quote style and layout', () => {
  it('a double-quoted, multi-line config gets double quotes and one property per line', () => {
    const before = 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  plugins: [],\n});\n';
    const c = edit({ 'vitest.config.ts': before }, vt(), 'vitest.config.ts');
    expect(c.after).toBe(`import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  plugins: [],\n  test: {\n    reporters: ["default", "json"],\n    outputFile: { json: "${RD}/root.json" },\n    coverage: { enabled: true, reporter: ["text", "json"] },\n  },\n});\n`);
  });
  it('an empty test object in a multi-line config is filled one property per line; no trailing comma when the file has none', () => {
    const c = edit({ 'vitest.config.ts': "export default {\n    test: {}\n};\n" }, vt(), 'vitest.config.ts');
    expect(c.after).toBe(`export default {\n    test: {\n        reporters: ['default', 'json'],\n        outputFile: { json: '${RD}/root.json' },\n        coverage: { enabled: true, reporter: ['text', 'json'] }\n    }\n};\n`);
  });
  it('a double-quoted config gets double quotes in edits to an existing test object', () => {
    const c = edit({ 'vitest.config.ts': 'export default {\n  test: {\n    globals: true,\n    include: ["src/**"],\n  },\n};\n' }, vt(), 'vitest.config.ts');
    expect(c.after).toContain('    reporters: ["default", "json"],\n');
    expect(c.after).toContain(`    outputFile: { json: "${RD}/root.json" },\n`);
    expect(c.after).not.toContain("'");
  });
});

describe('testConfigChange: migrating the legacy results path', () => {
  const LEGACY = '.harness/state/test-results';
  const migrate = (files: Record<string, string>, pkg: PackageFacts, legacy = LEGACY) => testConfigChange(pkg, makeRepo(files, { git: false }), RD, legacy);

  it('vitest root package: the old path becomes the new one', () => {
    const before = "export default { test: { outputFile: { json: '.harness/state/test-results/root.json' } } };\n";
    expect(migrate({ 'vitest.config.ts': before }, vt())).toEqual({ change: { kind: 'update', rel: 'vitest.config.ts', before, after: before.replace('.harness/state/test-results/root.json', '.harness/results/root.json'), blocks: [], rename: { from: '.harness/state/test-results/root.json', to: '.harness/results/root.json' } } });
  });

  it('monorepo package: the relative path is substituted', () => {
    const r = migrate({ 'packages/a/vitest.config.ts': "export default { test: { outputFile: { json: '../../.harness/state/test-results/a.json' } } };\n" }, vt({ dir: 'packages/a', name: 'a' })) as { change: { rel: string; after: string } };
    expect(r.change.rel).toBe('packages/a/vitest.config.ts');
    expect(r.change.after).toContain("'../../.harness/results/a.json'");
  });

  it('jest: the --outputFile in package.json is substituted', () => {
    const pj = JSON.stringify({ name: 'demo', scripts: { test: 'jest --reporters=./.harness/hooks/jest-results.cjs --outputFile=.harness/state/test-results/root.json' } }, null, 2) + '\n';
    const r = migrate({ 'package.json': pj }, jest('x')) as { change: { rel: string; after: string; rename: unknown } };
    expect(r.change.rel).toBe('package.json');
    expect(r.change.after).toBe(pj.replace('.harness/state/test-results/', '.harness/results/'));
    expect(r.change.rename).toEqual({ from: '.harness/state/test-results/root.json', to: '.harness/results/root.json' });
  });

  it('the old path twice, or legacyDir equal to resultsDir, gives the existing result', () => {
    const twice = "export default { test: { outputFile: { json: '.harness/state/test-results/root.json' } } }; // .harness/state/test-results/root.json\n";
    const root = makeRepo({ 'vitest.config.ts': twice }, { git: false });
    expect(testConfigChange(vt(), root, RD, LEGACY)).toEqual(testConfigChange(vt(), root, RD));
    const plain = makeRepo({ 'vitest.config.ts': 'export default { test: {} };\n' }, { git: false });
    expect(testConfigChange(vt(), plain, RD, RD)).toEqual(testConfigChange(vt(), plain, RD));
  });
});

describe('resultsRename: whole paths only, and the Jest config', () => {
  it('a longer path ending in the old one is not the root package path', () => {
    const before = "export default { test: { outputFile: { json: 'x/.harness/state/test-results/root.json' } } };\n";
    expect(resultsRename(vt(), makeRepo({ 'vitest.config.ts': before }, { git: false }), RD, '.harness/state/test-results')).toBeNull();
  });

  it('a ./-prefixed hand-set path is migrated, keeping the prefix', () => {
    const before = "export default { test: { outputFile: { json: './.harness/state/test-results/root.json' } } };\n";
    const c = resultsRename(vt(), makeRepo({ 'vitest.config.ts': before }, { git: false }), RD, '.harness/state/test-results');
    expect(c).toMatchObject({ after: before.replace('state/test-results', 'results') });
  });

  it('jest: a path in the Jest config is migrated when package.json has none', () => {
    const cfg = "module.exports = { outputFile: '.harness/state/test-results/root.json' };\n";
    const root = makeRepo({ 'package.json': '{ "name": "demo" }\n', 'jest.config.js': cfg }, { git: false });
    const c = resultsRename(jest('jest', { testConfig: 'jest.config.js' }), root, RD, '.harness/state/test-results');
    expect(c).toMatchObject({ rel: 'jest.config.js', after: cfg.replace('state/test-results', 'results') });
  });
});

// Fix round 5: the plan never reads a test config or package.json through a link; it refuses as apply does.
describe.skipIf(process.platform === 'win32')('testConfigChange refuses a linked file before reading it', () => {
  const dot = '.' + 'env';
  const linked = (rel: string) => {
    const root = makeRepo({ [dot]: 'API_TOKEN=fake-value-not-a-secret' }, { git: false });
    symlinkSync(dot, join(root, rel));
    return root;
  };
  it('a Vitest config', () => {
    expect(() => testConfigChange(vt(), linked('vitest.config.ts'), RD)).toThrow('refusing symlink: vitest.config.ts');
  });
  it('package.json for Jest', () => {
    expect(() => testConfigChange(jest('jest'), linked('package.json'), RD)).toThrow('refusing symlink: package.json');
  });
  it('the results rename', () => {
    expect(() => resultsRename(vt(), linked('vitest.config.ts'), RD, '.harness/state/test-results')).toThrow('refusing symlink: vitest.config.ts');
  });
});
