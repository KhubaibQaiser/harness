// Builds the old-install fixtures for test/e2e/upgrade.e2e.test.ts from a kept beta build.
// `node scripts/old-install-fixtures.mjs --beta <scratch>/beta --sha <sha>` writes test/fixtures/old-install/<name>.json:
// `{ beta, before, installed }`, the repo before and after the beta's `init --yes`, `.git` left out.
// Regenerating rewrites every fixture, also where the beta's output didn't change (each manifest's `createdAt`),
// so review the diff for real changes, not the churn.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({ options: { beta: { type: 'string' }, sha: { type: 'string' } } });
if (!values.beta || !values.sha) throw new Error('usage: node scripts/old-install-fixtures.mjs --beta <dir> --sha <sha>');
// The sha is written into every fixture, so it must be the build's: refuse a mismatch, warn when it can't be checked.
const head = spawnSync('git', ['-C', values.beta, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.status !== 0) process.stderr.write(`warning: can't check --sha: ${values.beta} is not a git checkout\n`);
else if (!head.stdout.trim().startsWith(values.sha)) throw new Error(`--sha ${values.sha} is not ${values.beta}'s HEAD (${head.stdout.trim()})`);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'test/fixtures/old-install');

// makeRepo and withPrettier live in a vitest helper; bundle it with a no-op afterAll (this script removes its own repos).
const tmp = mkdtempSync(join(tmpdir(), 'old-install-'));
const stub = { name: 'vitest-stub', setup(b) {
  b.onResolve({ filter: /^vitest$/ }, () => ({ path: 'vitest', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const afterAll = () => {};' }));
} };
const load = async (src, plugins = []) => {
  const outfile = join(tmp, src.replace(/\W/g, '_') + '.mjs');
  await build({ entryPoints: [join(here, '..', src)], bundle: true, platform: 'node', format: 'esm', outfile, plugins, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
};
const { makeRepo, withPrettier } = await load('test/install/helpers.ts', [stub]);
const { hashText } = await load('src/install/text.ts');

const pj = (o) => JSON.stringify(o, null, 2) + '\n';
const vitestPkg = pj({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0' } });
const jestPkg = pj({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^29.0.0' } });
const INLINE = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n";
const MULTILINE = "import { defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n    globals: true,\n  },\n});\n";
const base = { 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'src/a.ts': 'export const a = 1;\n' };
const JEST_CFG = "module.exports = { reporters: ['default'] };\n";

const FIXTURES = {
  'vitest-inline': { ...base, 'package.json': vitestPkg, 'vitest.config.ts': INLINE },
  'vitest-multiline': { ...base, 'package.json': vitestPkg, 'vitest.config.ts': MULTILINE },
  'vitest-prettier': { ...base, ...withPrettier, 'package.json': vitestPkg, 'vitest.config.ts': INLINE },
  'jest-script': { ...base, 'package.json': jestPkg },
  'jest-config': { ...base, 'package.json': jestPkg, 'jest.config.js': JEST_CFG },
  'existing-sandbox': { ...base, 'package.json': vitestPkg, 'vitest.config.ts': INLINE, '.claude/settings.json': pj({ sandbox: { network: { allowedDomains: ['registry.npmjs.org'] } } }) },
};

const walk = (root, dir = root, out = {}) => {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(root, p, out);
    else out[relative(root, p).split('\\').join('/')] = readFileSync(p, 'utf8');
  }
  return out;
};

const env = { ...process.env };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE']) delete env[k];
const cli = resolve(values.beta, 'dist/cli.mjs');
mkdirSync(OUT, { recursive: true });

for (const [name, files] of Object.entries(FIXTURES)) {
  const root = makeRepo(files);
  const before = walk(root);
  const r = spawnSync('node', [cli, 'init', '--yes'], { cwd: root, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name}: beta init exited ${r.status}\n${r.stdout}${r.stderr}`);
  const out = { beta: values.sha, before };
  if (name === 'jest-config') {
    // The two "Do these by hand" lines the beta printed, applied as a person would.
    const reporters = "jest.config.js: set `reporters: ['default', './.harness/hooks/jest-results.cjs']`";
    const flags = '"--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=.harness/state/test-results/root.json --coverage';
    if (!r.stdout.includes(reporters) || !r.stdout.includes(flags)) throw new Error(`${name}: the beta printed other manual lines\n${r.stdout}`);
    const hand = {
      'jest.config.js': "module.exports = { reporters: ['default', './.harness/hooks/jest-results.cjs'] };\n",
      'package.json': jestPkg.replace('"test": "jest"', `"test": ${JSON.stringify(`jest ${flags}`)}`),
    };
    for (const [rel, text] of Object.entries(hand)) writeFileSync(join(root, rel), text);
    out.hand = hand; // the person's own edits: uninstall leaves them, so the test expects them on top of `before`
  }
  if (name === 'vitest-inline') {
    // Results from a test run under the beta, which update and uninstall must leave alone until `.harness/` goes.
    mkdirSync(join(root, '.harness/state/test-results'), { recursive: true });
    writeFileSync(join(root, '.harness/state/test-results/root.json'), '{"testResults":[]}\n');
  }
  // The beta's 300 KB dispatcher adds nothing: update replaces it when its hash matches the manifest.
  const DISPATCH = '.harness/hooks/dispatch.mjs';
  const placeholder = '// beta dispatcher (placeholder)\n';
  writeFileSync(join(root, DISPATCH), placeholder);
  const mPath = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.files.find((f) => f.rel === DISPATCH).hash = hashText(placeholder);
  writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
  out.installed = walk(root);
  for (const [rel, text] of Object.entries(out.installed)) if (text.includes(root)) throw new Error(`${name}: ${rel} holds the temp path`);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(out, null, 2) + '\n');
  rmSync(root, { recursive: true, force: true });
  console.log(`wrote ${name}.json`);
}
rmSync(tmp, { recursive: true, force: true });
