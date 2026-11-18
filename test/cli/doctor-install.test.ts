import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { init } from '../../src/cli/init.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { HOOK_ENV_REL } from '../../src/core/hook-env.js';
import { hashText } from '../../src/install/text.js';
import { PREFIX } from '../e2e/fixtures.js';
import { makeRepo } from '../install/helpers.js';
import { pkgDir, REPO, prompt, installed, withNode, bin, hermetic, run, setConfig } from './doctor-helpers.js';

test('healthy install: all ok, exit 0', async () => {
  const root = await installed();
  // tdd is on for the vitest repo; init applied the reporter config. npm must be on PATH for the test step.
  const r = run(root, { path: bin('npm') });
  expect(r.out).not.toMatch(/^fix /m);
  expect(r.lines.every((l) => l.startsWith('ok ') || l.startsWith('note '))).toBe(true);
  expect(r.lines.length).toBeGreaterThanOrEqual(7);
  expect(r.out).toMatch(/^ok settings run the dispatcher for all 8 hook events$/m);
  expect(r.code).toBe(0);
});

test('tampered dispatcher: fix line, exit 1', async () => {
  const root = await installed();
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// edited\n');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*dispatch\.mjs.*: .*harness:update/m);
  expect(r.code).toBe(1);
});

test('missing step binary named', async () => {
  const root = await installed();
  setConfig(root, (s) => s.replace(/steps:[\s\S]*?\n {2}package_manager/, 'steps:\n    - name: ruff\n      run: [ruff, check, .]\n  package_manager'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*`ruff`/m);
  expect(r.code).toBe(1);
});

test('claude too old or missing', async () => {
  const root = await installed();
  const old = run(root, { claude: '2.0.0', path: bin('npm') });
  expect(old.out).toMatch(/^fix Claude Code 2\.0\.0 .*update Claude Code/m);
  const none = run(root, { claude: null, path: bin('npm') });
  expect(none.out).toMatch(/^note Claude Code not found \(or `claude --version` did not answer\): hooks still run when Claude Code is installed/m);
});

test('bad config and unwired event named', async () => {
  const root = await installed();
  setConfig(root, (s) => s + '\nbogus: 1\n');
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  delete s.hooks.Stop;
  delete s.hooks.ConfigChange;
  writeFileSync(sp, JSON.stringify(s));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*Stop/m);
  expect(r.out).toMatch(/^fix .*ConfigChange/m);
  expect(r.out).toMatch(/^fix .*bogus/m);
});

test('settings without the SessionStart group: the per-group fix line', async () => {
  const root = await installed();
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  delete s.hooks.SessionStart;
  writeFileSync(sp, JSON.stringify(s));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*SessionStart/m);
  expect(r.out).toMatch(/missing the harness group for `all tools`/);
});

test('missing reporter output for a TDD package', async () => {
  const root = await installed();
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*`vitest\.config\.ts`/m);
});

test('not installed: message and exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-none-'));
  mkdirSync(root, { recursive: true });
  const r = run(root);
  expect(r.out).toContain('not installed');
  expect(r.code).toBe(1);
});

test('missing config: restore from git, never loops through update', async () => {
  const root = await installed();
  rmSync(join(root, '.harness/config.yaml'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toContain('fix `.harness/config.yaml` is missing: restore it with git checkout -- .harness/config.yaml, or run harness uninstall and then /harness:init.');
  expect(r.lines.find((l) => l.includes('config.yaml` is missing'))).not.toContain('harness update');
  expect(r.code).toBe(1);
});

test('custom tdd.paths: missing reporter is still reported', async () => {
  const root = await installed();
  setConfig(root, (s) => s.replace(/\n {2}paths:[\s\S]*?\n {2}exempt/, '\n  paths:\n    - lib/**\n  exempt'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^ok vitest reporter output is set up/m);
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");
  expect(run(root, { path: bin('npm') }).out).toMatch(/^fix .*`vitest\.config\.ts`/m);
});

const UNSAFE = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src' } });\n";

test('package left out of TDD: doctor repeats the manual lines, then names the tdd.paths edit once they are there', async () => {
  const root = makeRepo({ ...REPO, 'vitest.config.ts': UNSAFE });
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  const a = run(root, { path: bin('npm') });
  expect(a.out).toMatch(/^note TDD is off for the root package because its test config could not be edited safely: do this by hand: .*outputFile: \{ json: '\.harness\/results\/root\.json' \}.*then set checks\.tdd to true and add `src\/\*\*` to tdd\.paths in \.harness\/config\.yaml$/m);
  expect(a.code).toBe(0); // a note, not a problem
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { root: './src', reporters: ['default', 'json'], outputFile: { json: '.harness/results/root.json' } } });\n");
  const b = run(root, { path: bin('npm') });
  expect(b.out).toMatch(/^note TDD is off for the root package: set checks\.tdd to true and add `src\/\*\*` to tdd\.paths in \.harness\/config\.yaml$/m);
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toContain("root: './src'"); // never rewritten
  setConfig(root, (s) => s.replace('tdd: false', 'tdd: true').replace(/\n {2}paths: \[\]/, '\n  paths:\n    - src/**'));
  const c = run(root, { path: bin('npm') });
  expect(c.out).not.toMatch(/TDD is off/);
  expect(c.out).toMatch(/^ok vitest reporter output is set up for the root package$/m);
});

test('jest repo: doctor checks the installed reporter against the manifest', async () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }), 'package-lock.json': '{}\n' });
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  const ok = run(root, { path: bin('npm') });
  expect(ok.out).toMatch(/^ok Jest reporter matches the manifest$/m);
  expect(ok.out).not.toMatch(/writes test results under/); // the reporter script is not a legacy results path
  writeFileSync(join(root, '.harness/hooks/jest-results.cjs'), '// edited\n');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.harness\/hooks\/jest-results\.cjs` is not the installed version: commit or stash your changes, then run \/harness:update to restore it$/m);
  expect(r.code).toBe(1);
});

test('vitest without a coverage provider: doctor gives the install hint, then the steps once it is installed', async () => {
  const root = makeRepo({ ...REPO, 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }) });
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).not.toContain('enabled: true');
  const a = run(root, { path: bin('npm') });
  expect(a.out).toMatch(/^note the coverage gate is off for the root package: install @vitest\/coverage-v8 to turn on the coverage gate$/m);
  expect(a.out).not.toMatch(/problems? found/);
  expect(a.code).toBe(0);
  mkdirSync(join(root, 'node_modules/@vitest/coverage-v8'), { recursive: true });
  const b = run(root, { path: bin('npm') });
  expect(b.code).toBe(1); // actionable now: a problem, not a note
  expect(b.out).toMatch(/^fix the coverage gate is off for the root package: run \/harness:update to turn on Vitest coverage, then remove `src\/\*\*` from tdd\.coverage_skip in \.harness\/config\.yaml$/m);
});

test('CRLF checkout of the dispatcher still matches the manifest', async () => {
  const root = await installed();
  const p = join(root, '.harness/hooks/dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok dispatcher matches the manifest$/m);
});

test('package with no vitest config file: the note says so and gives the lines to create it', async () => {
  const { 'vitest.config.ts': _, ...noCfg } = REPO;
  const root = makeRepo(noCfg);
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^note TDD is off for the root package because it has no Vitest\/Jest config file: do this by hand: Create `vitest\.config\.ts` with:/m);
  expect(r.code).toBe(0);
});

test('doctor notes that the hooks may see a different PATH than this terminal', async () => {
  const r = run(await installed(), { path: bin('npm') });
  expect(r.out).toMatch(/^note Stop steps were checked against this terminal's PATH: Claude Code's hooks may see a different one \(for example when Claude Code starts from the GUI\); if Stop warns that a tool is not on its PATH, make the tool available there$/m);
  expect(r.code).toBe(0);
});

const JEST_TEXT = { 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' }, jest: { coverageReporters: ['text'] } }, null, 2) + '\n', 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n' };

test('doctor: a Jest coverage config the gate cannot read is a note when skipped, a fix when it is not', async () => {
  const root = makeRepo(JEST_TEXT);
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  const run = async () => { let out = ''; const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() }); return { code, out }; };
  const a = await run();
  expect(a.out).toMatch(/^note the coverage gate is off for the root package: `package.json` "jest" sets `coverageReporters` without 'json'/m);
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/coverage_skip:\n\s+- src\/\*\*\n/, 'coverage_skip: []\n'));
  const b = await run();
  expect(b.code).toBe(1);
  expect(b.out).toMatch(/^fix the coverage gate cannot read coverage for the root package/m);
});

test('doctor: a package with working coverage that the user lists in tdd.coverage_skip is a note, not a problem', async () => {
  const root = await installed(); // REPO has @vitest/coverage-v8, so init turned coverage on
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/coverage_skip: \[\]/, 'coverage_skip:\n    - src/**'));
  expect(readFileSync(p, 'utf8')).toContain('    - src/**');
  let out = '';
  const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() });
  expect(out).toMatch(/^note the coverage gate is off for the root package: it is listed in tdd.coverage_skip/m);
  expect(code).toBe(0);
});

test.each([
  ['bad YAML', 'checks:\n  tdd: [\n'], ['top level not a mapping', '- a\n'], ['unknown key', 'checks:\n  tdd_x: true\n'],
  ['wrong type', 'checks:\n  tdd: "true"\n'], ['out of range', 'stop:\n  max_attempts: 99\n'], ['not a mapping', 'checks: true\n'],
])('doctor exits 1 on an invalid config (%s)', async (_n, yaml) => {
  const root = await installed();
  writeFileSync(join(root, '.harness/config.yaml'), yaml);
  let out = '';
  expect(await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() })).toBe(1);
  expect(out).toMatch(/^fix `\.harness\/config\.yaml` is (invalid|not valid YAML)/m);
});

test('doctor: a format or lint Stop step that would check the .harness/ files is a problem', async () => {
  const pkg = JSON.parse(REPO['package.json']);
  pkg.scripts['format:check'] = 'prettier --check .';
  pkg.devDependencies.prettier = '^3.0.0';
  const root = makeRepo({ ...REPO, 'package.json': JSON.stringify(pkg, null, 2) + '\n', 'eslint.config.js': 'export default makeConfig();\n' });
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  const run = async () => { let out = ''; const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() }); return { code, out }; };
  const a = await run(); // init wrote .prettierignore, but could not edit the computed ESLint config
  expect(a.out).not.toMatch(/runs Prettier/);
  expect(a.out).toMatch(/^fix Stop step `lint` runs ESLint, which lints the `\.harness\/` files: add `\{ ignores: \['\.harness\/'\] \}` to the exported array in `eslint\.config\.js`/m);
  writeFileSync(join(root, 'eslint.config.js'), "export default makeConfig({ ignores: ['.harness/'] });\n");
  rmSync(join(root, '.prettierignore'));
  const b = await run();
  expect(b.out).not.toMatch(/runs ESLint/);
  expect(b.out).toMatch(/^fix Stop step `format:check` runs Prettier, which checks the committed `\.harness\/` files: add `\.harness\/` to `\.prettierignore`/m);
  expect(b.code).toBe(1);
});

test('N6: the restore advice says to commit or stash first when the file has uncommitted changes', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = await installed();
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { cwd: root });
  g('add', '-A'); g('commit', '-q', '-m', 'harness');
  const p = join(root, '.harness/hooks/dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// tampered\n');
  const run = async () => { let out = ''; await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() }); return out; };
  expect(await run()).toMatch(/does not match the installed version: commit or stash your changes, then run \/harness:update to restore it$/m);
  g('commit', '-q', '-am', 'tampered');
  expect(await run()).toMatch(/does not match the installed version: run \/harness:update to restore it$/m);
});

test('claude 2.1.294 is a fix and exit 1; 2.1.295 is ok', async () => {
  const root = await installed();
  const a = run(root, { claude: '2.1.294', path: bin('npm') });
  expect(a.out).toMatch(/^fix Claude Code 2\.1\.294 is older than 2\.1\.295: update Claude Code$/m);
  expect(a.code).toBe(1);
  const b = run(root, { claude: '2.1.295', path: bin('npm') });
  expect(b.out).toMatch(/^ok Claude Code 2\.1\.295$/m);
  expect(b.code).toBe(0);
});

test('hook-side Node: old is a fix, current is ok, none recorded is a note', async () => {
  const root = await installed();
  expect(run(root, { path: bin('npm') }).out).toMatch(new RegExp(`^ok hooks run Node ${process.version.replace(/\./g, '\\.')}$`, 'm'));
  const p = join(root, HOOK_ENV_REL);
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), node: 'v22.10.0' }));
  const old = run(root, { path: bin('npm') });
  expect(old.out).toMatch(/^fix hooks run Node v22\.10\.0, older than 22\.11: install Node 22\.11 or newer where Claude Code finds it$/m);
  expect(old.code).toBe(1);
  rmSync(p);
  const none = run(root, { path: bin('npm') });
  expect(none.out).toMatch(/^note no hook has run here yet: start a Claude Code session, send a prompt, then run harness doctor again$/m);
  expect(none.code).toBe(0);
});

test('doctor self-test runs from a path with a space and ü', async () => {
  const root = await installed(PREFIX);
  expect(root).toContain(' ');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^ok dispatcher runs$/m);
  expect(r.code).toBe(0);
});

test('a dispatcher that cannot run is a fix', async () => {
  const root = await installed();
  const body = 'process.exit(3);\n';
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), body);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.files.find((f: any) => f.rel === '.harness/hooks/dispatch.mjs').hash = hashText(body);
  writeFileSync(mp, JSON.stringify(m));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^ok dispatcher matches the manifest$/m);
  expect(r.out).toMatch(/^fix the dispatcher does not run \(.*\): check that node is on the PATH Claude Code gives its hooks, then run harness doctor again$/m);
  expect(r.code).toBe(1);
});

test('a missing dispatcher gives one line, not also "does not run"', async () => {
  const root = await installed();
  rmSync(join(root, '.harness/hooks/dispatch.mjs'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.harness\/hooks\/dispatch\.mjs` is missing/m);
  expect(r.out).not.toContain('the dispatcher does not run');
});

test('no node on the PATH: the dispatcher does not run', async () => {
  const root = await installed();
  let out = '';
  const code = doctor([], { root, env: { PATH: bin('npm') }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() });
  expect(out).toMatch(/^fix the dispatcher does not run \(.*ENOENT.*\): check that node is on the PATH/m);
  expect(code).toBe(1);
});
