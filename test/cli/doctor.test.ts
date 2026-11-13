import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { contextSet } from '../../src/budget/summary.js';
import { loadConfig } from '../../src/core/config.js';
import { contextDirs } from '../../src/cli/doctor-context.js';
import { init, type Prompt } from '../../src/cli/init.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { HOOK_ENV_REL, writeHookEnv } from '../../src/core/hook-env.js';
import { appendEvent } from '../../src/core/events.js';
import { hashText } from '../../src/install/text.js';
import { PREFIX } from '../e2e/fixtures.js';
import { makeRepo } from '../install/helpers.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { applyChanges } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import type { pluginList } from '../../src/install/plugin-install.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^1.0.0', '@vitest/coverage-v8': '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const installed = async (prefix?: string) => {
  const root = makeRepo(REPO, prefix ? { prefix } : {});
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  writeHookEnv(root); // as if a hook had run
  return root;
};
// node must be on PATH for the dispatcher self-test.
const withNode = (p?: string) => [p, dirname(process.execPath)].filter(Boolean).join(delimiter);
const bin = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-bin-'));
  writeFileSync(join(d, name), '#!/bin/sh\n');
  chmodSync(join(d, name), 0o755);
  writeFileSync(join(d, `${name}.cmd`), '@echo off\n'); // what findOnPath looks for on Windows
  return d;
};
const run = (root: string, o: { claude?: string | null; path?: string; platform?: NodeJS.Platform } = {}) => {
  let out = '';
  const code = doctor([], { root, env: { PATH: withNode(o.path) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => (o.claude === undefined ? MIN_CLAUDE_CODE : o.claude), platform: o.platform });
  return { code, out, lines: out.trim().split('\n') };
};
const setConfig = (root: string, edit: (s: string) => string) => {
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
};

test('healthy install: all ok, exit 0', async () => {
  const root = await installed();
  // tdd is on for the vitest repo; init applied the reporter config. npm must be on PATH for the test step.
  const r = run(root, { path: bin('npm') });
  expect(r.out).not.toMatch(/^fix /m);
  expect(r.lines.every((l) => l.startsWith('ok ') || l.startsWith('note '))).toBe(true);
  expect(r.lines.length).toBeGreaterThanOrEqual(7);
  expect(r.out).toMatch(/^ok settings run the dispatcher for all 7 hook events$/m);
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
  expect(none.out).toMatch(/^ok Claude Code not found \(or `claude --version` did not answer\): hooks still run when Claude Code is installed/m);
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

test('settings without the SessionStart compact group: the per-group fix line', async () => {
  const root = await installed();
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  delete s.hooks.SessionStart;
  writeFileSync(sp, JSON.stringify(s));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix .*SessionStart/m);
  expect(r.out).toMatch(/missing the harness group for `compact`/);
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
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
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
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
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
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
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
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
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
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  const run = async () => { let out = ''; const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE }); return { code, out }; };
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
  const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE });
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
  expect(await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE })).toBe(1);
  expect(out).toMatch(/^fix `\.harness\/config\.yaml` is (invalid|not valid YAML)/m);
});

test('doctor: a format or lint Stop step that would check the .harness/ files is a problem', async () => {
  const pkg = JSON.parse(REPO['package.json']);
  pkg.scripts['format:check'] = 'prettier --check .';
  pkg.devDependencies.prettier = '^3.0.0';
  const root = makeRepo({ ...REPO, 'package.json': JSON.stringify(pkg, null, 2) + '\n', 'eslint.config.js': 'export default makeConfig();\n' });
  await init(['--yes'], { env: { PATH: bin('npm'), HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  const run = async () => { let out = ''; const code = await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE }); return { code, out }; };
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
  const run = async () => { let out = ''; await doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE }); return out; };
  expect(await run()).toMatch(/does not match the installed version: commit or stash your changes, then run \/harness:update to restore it$/m);
  g('commit', '-q', '-am', 'tampered');
  expect(await run()).toMatch(/does not match the installed version: run \/harness:update to restore it$/m);
});

const editSettings = (root: string, edit: (s: any) => void) => {
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  edit(s);
  writeFileSync(p, JSON.stringify(s, null, 2));
};

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
  const code = doctor([], { root, env: { PATH: bin('npm') }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE });
  expect(out).toMatch(/^fix the dispatcher does not run \(.*ENOENT.*\): check that node is on the PATH/m);
  expect(code).toBe(1);
});

const differs = (ev: string) => new RegExp(`^fix \`\\.claude/settings\\.json\`: \`hooks\\.${ev}\` harness hook differs from the one harness installs: undo the edit or delete that group, then run \/harness:update$`, 'm');
const toShell = (s: any) => {
  const h = s.hooks.PreToolUse[0].hooks[0];
  h.command = 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"';
  delete h.args;
};
/** Edits the settings group, and records the result as an older harness's own block, as an old install's manifest does. */
const recordOld = (root: string, ev: string, edit: (s: any) => void) => {
  editSettings(root, edit);
  const group = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks[ev][0];
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.files.find((f: any) => f.rel === '.claude/settings.json').blocks.push(JSON.stringify({ event: ev, group }));
  writeFileSync(mp, JSON.stringify(m));
};

test('an old recorded shell-form entry is a run-harness-update fix', async () => {
  const root = await installed(PREFIX);
  recordOld(root, 'PreToolUse', toShell);
  const r = run(root, { path: bin('npm') });
  // Through the platform shell, from a path with a space. cmd.exe does not expand ${CLAUDE_PROJECT_DIR} (a POSIX-shell
  // form, the known limit that exec form fixes), so on win32 the self-test fails; the update fix below is the point.
  if (process.platform !== 'win32') expect(r.out).toMatch(/^ok dispatcher runs$/m);
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json` runs the dispatcher through a shell: run \/harness:update$/m);
  expect(r.out).not.toMatch(differs('PreToolUse'));
  expect(r.code).toBe(1);
});

test('an old recorded shell-form entry without onFailure gets one update line', async () => {
  const root = await installed(PREFIX);
  recordOld(root, 'PreToolUse', (s) => (toShell(s), delete s.hooks.PreToolUse[0].hooks[0].onFailure));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/through a shell: run \/harness:update$/m);
  expect(r.out).not.toMatch(/^fix PreToolUse hook has no onFailure/m);
});

test('a shell-form entry the person wrote is an edit: the differs line only', async () => {
  const root = await installed(PREFIX);
  editSettings(root, toShell);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(differs('PreToolUse'));
  expect(r.out).not.toMatch(/through a shell/);
  expect(r.code).toBe(1);
});

test('an old recorded group without onFailure is a run-harness-update fix', async () => {
  const root = await installed();
  recordOld(root, 'UserPromptSubmit', (s) => delete s.hooks.UserPromptSubmit[0].hooks[0].onFailure);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix UserPromptSubmit hook has no onFailure "block": run \/harness:update$/m);
  expect(r.out).not.toMatch(/differs/);
  expect(r.out).not.toMatch(/^fix (PreToolUse|ConfigChange) hook/m);
  expect(r.code).toBe(1);
});

test('a fragment group missing from its event is a run-harness-update fix', async () => {
  const root = await installed();
  editSettings(root, (s) => s.hooks.PreToolUse.splice(1, 1)); // the AskUserQuestion group
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json`: `hooks\.PreToolUse` is missing the harness group for `AskUserQuestion`: run \/harness:update$/m);
  expect(r.code).toBe(1);
});

test('deleting onFailure on a fresh install is an edit: the differs line only', async () => {
  const root = await installed();
  editSettings(root, (s) => delete s.hooks.UserPromptSubmit[0].hooks[0].onFailure);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(differs('UserPromptSubmit'));
  expect(r.out).not.toMatch(/onFailure/);
  expect(r.code).toBe(1);
});

test('an edited harness hook group is a fix', async () => {
  const root = await installed();
  editSettings(root, (s) => (s.hooks.Stop[0].hooks[0].timeout = 5));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json`: `hooks\.Stop` harness hook differs from the one harness installs: undo the edit or delete that group, then run \/harness:update$/m);
  expect(r.lines.filter((l) => l.includes('differs'))).toHaveLength(1);
  expect(r.code).toBe(1);
});

test('sandbox lines per platform and mode', async () => {
  const root = await installed();
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok sandbox: unattended \(required for unattended runs\)$/m);
  const win = run(root, { path: bin('npm'), platform: 'win32' });
  expect(win.out).toMatch(/^note no sandbox on native Windows: hooks, permission rules and text checks only$/m);
  expect(win.code).toBe(0);
  const lin = run(root, { path: bin('npm'), platform: 'linux' });
  expect(lin.out).toMatch(/^note the Linux sandbox needs bwrap and socat \(missing: bwrap, socat\): install them$/m);
  expect(lin.code).toBe(0);
  const both = withNode(bin('npm')) + delimiter + bin('bwrap') + delimiter + bin('socat');
  let out = '';
  doctor([], { root, env: { PATH: both }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, platform: 'linux' });
  if (process.platform !== 'win32') expect(out).not.toMatch(/bwrap/); // a linux PATH splits on ':', which a Windows PATH breaks
  setConfig(root, (s) => s.replace('sandbox: unattended', 'sandbox: always'));
  const always = run(root, { path: bin('npm'), platform: 'linux' });
  expect(always.out).toMatch(/^ok sandbox: always \(on in every session\)$/m);
  expect(always.out).toMatch(/^fix the Linux sandbox needs bwrap and socat \(missing: bwrap, socat\): install them$/m);
  expect(always.code).toBe(1);
  setConfig(root, (s) => s.replace('sandbox: always', 'sandbox: off'));
  const off = run(root, { path: bin('npm'), platform: 'linux' });
  expect(off.out).toMatch(/^ok sandbox: off \(text checks only\)$/m);
  expect(off.out).not.toMatch(/bwrap/);
});

test('a package still writing under .harness/state is a fix', async () => {
  const root = await installed();
  const p = join(root, 'vitest.config.ts');
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('.harness/results', '.harness/state/test-results'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(LEGACY_FIX);
  expect(r.out).not.toMatch(/reporter output/); // one line, one piece of advice
  expect(r.code).toBe(1);
});

const LEGACY_FIX = /^fix the root package writes test results under \.harness\/state, which the sandbox denies: run \/harness:update$/m;
test.each([
  ['a Jest script', {}],
  ['jest.config.js', { 'jest.config.js': "module.exports = { outputFile: '.harness/results/root.json' };\n" }],
])('a Jest package still writing under .harness/state is one fix (%s)', async (_n, extra) => {
  const root = makeRepo({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }), 'package-lock.json': '{}\n', ...extra });
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  for (const f of ['package.json', ...Object.keys(extra)]) {
    const p = join(root, f);
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('.harness/results', '.harness/state/test-results'));
  }
  expect(readFileSync(join(root, Object.keys(extra)[0] ?? 'package.json'), 'utf8')).toContain('.harness/state/test-results');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(LEGACY_FIX);
  expect(r.out).not.toMatch(/reporter output/);
  expect(r.code).toBe(1);
});

test('the last blocked settings change is a note', async () => {
  const root = await installed();
  appendEvent(root, { ts: '2026-11-01T00:00:00.000Z', session: 's', check: 'config-change', decision: 'config-change-blocked', reason: 'old' });
  appendEvent(root, { ts: '2026-11-02T00:00:00.000Z', session: 's', check: 'config-change', decision: 'config-change-blocked', reason: '.claude/settings.json: hooks' });
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^note harness blocked a settings change at 2026-11-02T00:00:00\.000Z \(\.claude\/settings\.json: hooks\): review the file before the next session$/m);
  expect(r.code).toBe(0);
});

// ---- item checks (Task 24) ----
type PL = ReturnType<typeof pluginList>;
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'review-rubric', 'agents-md'];
const itemsRepo = (ids: string[], catalogVersion = loadCatalog().catalog.version) => {
  const root = makeRepo({ ...REPO, 'AGENTS.md': '# Mine\n' });
  const facts = detect(root);
  const config = preset(facts).config;
  config.catalog_version = catalogVersion;
  config.items = [...OWN, ...ids].map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: JSON.stringify({ catalog_version: 1, findings: [], items: [] }), report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir: join(pkgDir, 'templates'), catalog: loadCatalog().catalog, ai }).changes, '1.0.0');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: root });
  writeHookEnv(root);
  return root;
};
const runItems = (root: string, list: PL | (() => PL)) => {
  let out = '';
  let calls = 0;
  const code = doctor([], { root, env: { PATH: withNode() }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, pluginList: () => (calls++, typeof list === 'function' ? list() : list) });
  return { code, out, calls };
};
const pinsOf = (root: string): string => Object.keys(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).extraKnownMarketplaces).find((k) => k.startsWith('harness-pins'))!;
let CAVE = ''; // caveman's id in the repo the test made last
const caveRepo = (ids: string[]) => { const root = itemsRepo(ids); CAVE = `caveman@${pinsOf(root)}`; return root; };
const cave = (o: Partial<{ id: string; version: string; enabled: boolean }> = {}) => ({ id: CAVE, version: '4.0.1', enabled: true, ...o });
const editJson = (root: string, rel: string, f: (j: any) => void) => {
  const j = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  f(j);
  writeFileSync(join(root, rel), JSON.stringify(j, null, 2) + '\n');
};

test('items: catalog line is ok at the repo version, a note when the package is newer', () => {
  const v = loadCatalog().catalog.version;
  expect(runItems(itemsRepo([]), []).out).toContain(`ok catalog ${v}\n`);
  expect(runItems(itemsRepo([], 0), []).out).toContain(`note catalog ${v} is newer than this repo's 0: run /harness:update\n`);
});

test('items: a deleted item file is a fix', () => {
  const root = itemsRepo(['staff-reviewer']);
  rmSync(join(root, '.claude/agents/staff-reviewer.md'));
  expect(runItems(root, []).out).toContain('fix staff-reviewer is missing .claude/agents/staff-reviewer.md: run /harness:sync\n');
});

test('items: a removed plugin entry is a fix, and one claude call serves all plugin checks', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => delete j.enabledPlugins[CAVE]);
  const r = runItems(root, [cave()]);
  expect(r.out).toContain('fix caveman is missing .claude/settings.json: run /harness:sync\n');
  expect(r.calls).toBe(1);
});

test('items: enabled but not installed is a fix; installed is not', () => {
  const root = caveRepo(['caveman']);
  expect(runItems(root, []).out).toContain(`fix ${CAVE} is enabled in this repo but not installed: claude plugin install ${CAVE} --scope project\n`);
  expect(runItems(root, [cave()]).out).not.toContain('not installed');
});

test('items: plugin version drift is a note; an unset plugin_version is skipped', () => {
  const root = caveRepo(['caveman']);
  expect(runItems(root, [cave({ version: '3.0.0' })]).out).toContain(`note ${CAVE} is 3.0.0, the catalog pins 4.0.1: run claude plugin update ${CAVE} --scope project\n`);
  expect(runItems(root, [cave()]).out).not.toContain('the catalog pins');
  const noPin = loadCatalog().catalog.items.find((i) => i.kind === 'plugin' && !i.plugin_version && i.source.type !== 'own')!;
  const root2 = itemsRepo([noPin.id]);
  const id = `${(noPin.source as { plugin: string }).plugin}@${pinsOf(root2)}`;
  expect(runItems(root2, [{ id, version: '9.9.9', enabled: true }]).out).not.toContain('the catalog pins');
});

test('items: the same plugin enabled from two marketplaces is a note', () => {
  const root = caveRepo(['caveman']);
  const r = runItems(root, [cave(), cave({ id: 'caveman@other' })]);
  expect(r.out).toContain(`note caveman is enabled twice (caveman@other and ${pinsOf(root)}); only one copy's hooks run. Disable one.\n`);
  expect(runItems(root, [cave(), cave({ id: 'caveman@other', enabled: false })]).out).not.toContain('enabled twice');
});

test('items: a pins entry whose content no longer matches its name is a fix; an edited MCP server is a note', () => {
  const a = caveRepo(['caveman']);
  const name = pinsOf(a);
  const fix = `fix the ${name} marketplace was edited, so its name no longer matches its pins and can clash with other repos on this machine: undo the edit, or delete that entry and run /harness:sync\n`;
  expect(runItems(a, [cave()]).out).not.toContain('was edited');
  editJson(a, '.claude/settings.json', (j) => { j.extraKnownMarketplaces[name].source.plugins[0].source.sha = 'f'.repeat(40); });
  const r = runItems(a, [cave()]);
  expect(r.out).toContain(fix);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain(`note the ${name} marketplace differs`);
  const b = itemsRepo(['mobile-mcp']);
  editJson(b, '.mcp.json', (j) => { j.mcpServers['mobile-mcp'].args = ['-y', 'evil']; });
  expect(runItems(b, []).out).toContain('note a harness MCP server differs from what harness installed: run /harness:sync\n');
});

test('items: a field hand-added to a pinned plugin entry is a fix', () => {
  const a = caveRepo(['caveman']);
  const name = pinsOf(a);
  editJson(a, '.claude/settings.json', (j) => { j.extraKnownMarketplaces[name].source.plugins[0].strict = false; });
  const r = runItems(a, [cave()]);
  expect(r.out).toContain(`fix the ${name} marketplace was edited, so its name no longer matches its pins`);
  expect(r.code).toBe(1);
});

test('items: two content-named pins entries are a fix naming both, and the plugin checks are skipped', () => {
  const root = caveRepo(['caveman']);
  const name = pinsOf(root);
  editJson(root, '.claude/settings.json', (j) => { j.extraKnownMarketplaces['harness-pins-aaaaaaaaaaaa'] = j.extraKnownMarketplaces[name]; });
  const r = runItems(root, []);
  expect(r.out).toMatch(new RegExp(`fix \`\\.claude/settings\\.json\` has two harness pins marketplaces, (${name} and harness-pins-aaaaaaaaaaaa|harness-pins-aaaaaaaaaaaa and ${name}); keep the one your plugin keys use and delete the other: run /harness:sync\n`));
  expect(r.out).not.toContain('enabled in this repo but not installed');
});

test('items: settings keys are escaped in doctor output', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => { j.enabledPlugins['x\u001b[31m\r\nfix fake@harness-pins-aaaaaaaaaaaa'] = false; });
  const r = runItems(root, [cave()]);
  expect(r.out).toContain('x\\u001b[31m\\r\\nfix fake@harness-pins-aaaaaaaaaaaa');
  expect(r.out).not.toMatch(/[\u001b\r]/);
});

// An install from before content names: the same files with the shared name.
const toLegacy = (root: string) => {
  const own = pinsOf(root);
  for (const rel of ['.claude/settings.json', '.harness/manifest.json']) writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8').replaceAll(own, 'harness-pins'));
};

test('items: the shared harness-pins name is a fix until update renames it', () => {
  const root = caveRepo(['caveman']);
  const old = "fix `.claude/settings.json` uses the shared `harness-pins` marketplace name, so another repo's pins can replace this repo's plugins: run /harness:update to rename it, then /harness:sync --install-plugins; when no repo on this machine still uses harness-pins, run claude plugin marketplace remove harness-pins\n";
  expect(runItems(root, [cave()]).out).not.toContain('shared `harness-pins`');
  toLegacy(root);
  const r = runItems(root, [cave({ id: 'caveman@harness-pins' })]);
  expect(r.out).toContain(old);
  expect(r.code).toBe(1);
  expect(r.out).not.toContain('caveman is missing .claude/settings.json'); // its key is there under the old name
  expect(r.out).not.toContain('enabled in this repo but not installed');
});

test('items: on a legacy install, a really missing plugin key and missing item files are still fixes', () => {
  const root = caveRepo(['caveman', 'staff-reviewer']);
  toLegacy(root);
  editJson(root, '.claude/settings.json', (j) => { delete j.enabledPlugins['caveman@harness-pins']; });
  rmSync(join(root, '.claude/agents/staff-reviewer.md'));
  const r = runItems(root, []);
  expect(r.out).toContain('fix caveman is missing .claude/settings.json: run /harness:sync\n');
  expect(r.out).toContain('fix staff-reviewer is missing .claude/agents/staff-reviewer.md: run /harness:sync\n');
});

test('items: a plugin key naming a pins marketplace the repo no longer has is a note', () => {
  const root = caveRepo(['caveman']);
  editJson(root, '.claude/settings.json', (j) => { j.enabledPlugins['gamma@harness-pins-aaaaaaaaaaaa'] = false; });
  expect(runItems(root, [cave()]).out).toContain('note `gamma@harness-pins-aaaaaaaaaaaa` names the harness-pins-aaaaaaaaaaaa marketplace, which this repo no longer has: remove it from .claude/settings.json\n');
});

test('items: config checks that differ from the selected items are a note', () => {
  const root = itemsRepo([]);
  expect(runItems(root, []).out).not.toContain('checks differ');
  setConfig(root, (s) => s.replace(/(\n\s+tdd: )true/, '$1false'));
  expect(runItems(root, []).out).toContain('note config.yaml checks differ from the selected items (tdd); the items win on the next update. Use /harness:add or harness remove to change gates.\n');
});

test('items: a missing or unreadable claude prints one note and skips the plugin checks', () => {
  const root = itemsRepo(['caveman']);
  const r = runItems(root, null);
  expect(r.out.match(/^note claude is missing/gm)).toHaveLength(1);
  expect(r.out).not.toContain('not installed');
  expect(r.out).toMatch(/^ok catalog /m);
});

// Branch protection: a fake gh, never the real GitHub (test/setup-no-gh.ts makes a real spawn throw).
const VIEW = { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } }) };
const CI = 'name: ci\njobs:\n  ci:\n    name: test\n    steps:\n      - run: pnpm test\n';
const protectionRun = async (api: { status: number | null; stdout: string }, workflow = CI, files: Record<string, string> = {}) => {
  const root = await installed();
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), workflow);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(root, '.github/workflows', f), t);
  const calls: string[][] = [];
  const gh = (a: string[]) => (calls.push(a), a[0] === 'repo' ? VIEW : api);
  let out = '';
  const code = doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { claudeVersion: () => MIN_CLAUDE_CODE, gh });
  return { out, code, calls };
};
const prot = (required: object) => ({ status: 0, stdout: JSON.stringify({ required_status_checks: required }) });

test('doctor: a required check matching a CI job is ok', async () => {
  const r = await protectionRun(prot({ contexts: [], checks: [{ context: 'ci / test' }] }));
  expect(r.out).toContain('ok main is protected and requires `ci / test`');
  expect(r.calls[1]).toEqual(['api', 'repos/o/r/branches/main/protection']);
  expect(r.code).toBe(0);
});

test('doctor: legacy contexts also count', async () => {
  expect((await protectionRun(prot({ contexts: ['test'] }))).out).toContain('ok main is protected and requires `test`');
});

test('doctor: a 404 says the branch is not protected, exit code unchanged', async () => {
  const r = await protectionRun({ status: 1, stdout: '{"message":"Branch not protected","status":"404"}' });
  expect(r.out).toMatch(/note main is not protected: .*require the CI checks/);
  expect(r.code).toBe(0);
});

test.each([
  ['a 403', '{"message":"Resource not accessible","status":"403"}'],
  ['a Not Found without a 404 status', 'gh: Not Found'],
])('doctor: %s is unknown, not "not protected"', async (_n, stdout) => {
  const r = await protectionRun({ status: 1, stdout });
  expect(r.out).not.toContain('is not protected');
  expect(r.out).toContain('note branch protection unknown');
});

test('doctor: protected with no matching required checks is a note', async () => {
  const r = await protectionRun(prot({ contexts: ['deploy'] }));
  expect(r.out).toMatch(/note main is protected but no required check matches/);
  expect(r.code).toBe(0);
});

test('doctor: a required check can match a job of a local reusable workflow', async () => {
  const caller = 'jobs:\n  ci:\n    uses: ./.github/workflows/callee.yml\n';
  const callee = 'jobs:\n  lint-job:\n    name: lint\n    steps:\n      - run: pnpm lint\n';
  const r = await protectionRun(prot({ contexts: ['ci / lint'] }), caller, { 'callee.yml': callee });
  expect(r.out).toContain('ok main is protected and requires `ci / lint`');
});

test('doctor: malformed workflow YAML is a note, not a crash', async () => {
  const r = await protectionRun(prot({ contexts: ['test'] }), 'jobs: [unclosed\n  : :');
  expect(r.out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: only the first 100 required contexts are read', async () => {
  const contexts = [...Array.from({ length: 100 }, (_v, i) => `other-${i}`), 'test'];
  expect((await protectionRun(prot({ contexts }))).out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: gh failing without a status is "not available"; a signed-out gh is not', async () => {
  const root = await installed();
  const go = (gh: () => { status: number | null; stdout: string }) => {
    let out = '';
    doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { claudeVersion: () => MIN_CLAUDE_CODE, gh });
    return out;
  };
  expect(go(() => ({ status: null, stdout: '' }))).toContain('note branch protection unknown (gh not available)');
  expect(go(() => ({ status: 1, stdout: 'HTTP 503: unavailable\nsecond line' }))).toContain('note branch protection unknown (gh could not read it: HTTP 503: unavailable)');
  const hostile = go(() => ({ status: 1, stdout: `\x1b[31m\x07evil${'x'.repeat(200)}` }));
  const line = hostile.split('\n').find((l) => l.startsWith('note branch protection unknown'))!;
  expect(line).toMatch(/^note branch protection unknown \(gh could not read it: \[31mevilx+\)$/);
  expect(line).not.toMatch(/[\x00-\x1f]/);
  expect(line.length).toBeLessThan(200);
  expect(go(() => ({ status: 4, stdout: '' }))).toContain('note branch protection unknown (gh could not read it: exit 4)');
  expect(go(() => ({ status: 1, stdout: 'bad\u202e\u200bname' }))).toContain('(gh could not read it: badname)');
});

test('doctor: a workflow file over 1 MB is skipped', async () => {
  const big = CI + '# ' + 'x'.repeat(1 << 20) + '\n';
  expect((await protectionRun(prot({ contexts: ['test'] }), big)).out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: an unsafe branch name from gh is not used in the api path', async () => {
  const root = await installed();
  const calls: string[][] = [];
  const gh = (a: string[]) => (calls.push(a), { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'x; echo hi' } }) });
  doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: () => {} }, { claudeVersion: () => MIN_CLAUDE_CODE, gh });
  expect(calls).toHaveLength(1);
});

test('doctor: the test setup stops a real gh from being spawned', async () => {
  const root = await installed();
  expect(() => doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: () => {} }, { claudeVersion: () => MIN_CLAUDE_CODE })).toThrow(/real gh/);
});

const withBudget = (root: string, n: number) => setConfig(root, (t) => `${t.replace(/^context:\n(?:[ \t].*\n?)*/m, '')}\ncontext:\n  budget_tokens: ${n}\n`);
const sets = (root: string) => contextSet(root, loadConfig(root).config, contextDirs());

test('doctor prints the always-loaded context: ok within budget, note over it, fix when harness alone is over; offline', async () => {
  const root = await installed();
  const real = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('no network'); }) as typeof fetch;
  try {
    const s = sets(root);
    let r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`ok always-loaded context ~${s.total.toLocaleString('en-US')} of 2,000 tokens (best estimate); harness ~${s.harness.toLocaleString('en-US')}. Run harness context for details.\n`); // a literal comma pins the format
    expect(r.out.match(/always-loaded context/g)).toHaveLength(1);
    // Repo text beyond harness's own pushes the total over a budget harness fits in.
    writeFileSync(join(root, 'CLAUDE.md'), 'x'.repeat(40000));
    const s2 = sets(root);
    expect(s2.total).toBeGreaterThan(s2.harness);
    withBudget(root, s2.harness);
    r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`note always-loaded context ~${s2.total.toLocaleString('en-US')} tokens is over the budget of ${s2.harness.toLocaleString('en-US')}: run /harness:context-optimize\n`);
    expect(r.code).toBe(0);
    withBudget(root, 100);
    r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`fix harness's own always-loaded text (~${s2.harness.toLocaleString('en-US')} tokens) is over the budget of 100: report this as a harness bug, or raise context.budget_tokens\n`);
    expect(r.code).toBe(1);
  } finally { globalThis.fetch = real; }
});

test('doctor context line does not throw without .git', async () => {
  const root = await installed();
  rmSync(join(root, '.git'), { recursive: true, force: true });
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok always-loaded context ~/m);
});

test('an invalid decision makes doctor exit 1', async () => {
  const root = await installed();
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/decisions/2026-11-03-bad.md'), '---\nschema: harness-decision/1\nid: 2026-11-03-bad\n---\n');
  const r = run(root);
  expect(r.out).toMatch(/^fix docs\/decisions\/2026-11-03-bad\.md: /m);
  expect(r.code).toBe(1);
});

test('no decisions folder: doctor prints the ok line', async () => {
  expect(run(await installed()).out).toContain('ok no team decisions yet');
});
