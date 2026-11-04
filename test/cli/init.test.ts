import { execFileSync } from 'node:child_process';
import * as realFs from 'node:fs';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { planChanges } from '../../src/install/plan.js';
import { detect } from '../../src/install/detect.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const distDir = join(pkgDir, 'dist');
const templatesDir = join(pkgDir, 'templates');

const NPM_VITEST = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
};
const PYTHON = { 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n' };

const fake = (answers: (boolean | string)[] = []): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async confirm(q) { asked.push(q); return answers.length ? (answers.shift() as boolean) : false; },
    async edit(label, value) { asked.push(label); return answers.length ? (answers.shift() as string) : value; },
  };
};

const go = async (root: string, args: string[], prompt: Prompt = fake(), extra: object = {}) => {
  let out = '';
  const code = await init(args, { root, env: { HARNESS_PLAIN_INIT: '1' }, out: (s) => (out += s + '\n'), prompt, version: '1.2.3', templatesDir, distDir, ...extra });
  return { code, out };
};
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

test('init --yes on an npm+vitest repo writes every file and a manifest', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(0);
  for (const f of ['.harness/hooks/dispatch.mjs', '.harness/config.yaml', '.claude/agents/staff-reviewer.md', '.claude/skills/review-rubric/SKILL.md', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.harness/manifest.json'])
    expect(existsSync(join(root, f)), f).toBe(true);
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toContain('written by harness init 1.2.3');
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.harness/state/');
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toContain("reporters: ['default', 'json']");
  expect(JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).version).toBe('1.2.3');
  expect(r.out).toContain('Commit these files:');
  expect(r.out).toContain('Teammates need nothing else: the hooks are in the repo.');
});

test('init from a subdirectory writes at the repo root', async () => {
  const root = makeRepo({ ...NPM_VITEST, 'sub/x.txt': 'x' });
  const r = await go(join(root, 'sub'), ['--yes']);
  expect(r.code).toBe(0);
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(true);
  expect(existsSync(join(root, 'sub/.harness'))).toBe(false);
  expect(r.out).toContain(`Installing at the repo root: ${realpathSync.native(root)}\n`);
});

test('second init refuses and names update', async () => {
  const root = makeRepo(NPM_VITEST);
  await go(root, ['--yes']);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@e.x', 'commit', '-qm', 'harness');
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('Harness is already installed (.harness/manifest.json). Run /harness:update instead.');
});

test('declining the plan writes nothing', async () => {
  const root = makeRepo(NPM_VITEST);
  const p = fake([false, false]); // no edit, no apply
  const r = await go(root, [], p);
  expect(p.asked).toEqual(['Edit any value? (y/N)', 'Apply these changes? (y/N)']);
  expect(r.code).toBe(0);
  expect(existsSync(join(root, '.harness'))).toBe(false);
  expect(git(root, 'status', '--porcelain')).toBe('');
});

test('--dry-run writes nothing and prints the plan with diffs', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await go(root, ['--yes', '--dry-run']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('create .harness/config.yaml');
  expect(r.out).toContain('update .gitignore');
  expect(r.out).toContain('+.harness/state/');
  expect(existsSync(join(root, '.harness'))).toBe(false);
  expect(git(root, 'status', '--porcelain')).toBe('');
});

test('dirty touched file refuses with the list', async () => {
  const root = makeRepo(NPM_VITEST);
  writeFileSync(join(root, '.gitignore'), 'node_modules\nlocal\n');
  writeFileSync(join(root, 'unrelated.txt'), 'u');
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('Commit or stash these files first, so the install can be undone cleanly: .gitignore.');
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test('--config with an invalid value exits 2 with every error', async () => {
  const root = makeRepo(NPM_VITEST);
  const f = join(root, '..', `bad-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ bogus: 1, stop: { max_attempts: 'x' } }));
  const r = await go(root, ['--config', f]);
  expect(r.code).toBe(2);
  expect(r.out).toContain('bogus: unknown key');
  expect(r.out).toContain('stop.max_attempts');
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test('--config with a valid YAML file is applied without prompts', async () => {
  const root = makeRepo(NPM_VITEST);
  const f = join(root, '..', `ok-${Date.now()}.yaml`);
  writeFileSync(f, 'stop:\n  max_attempts: 5\n');
  const p = fake([true]);
  const r = await go(root, ['--config', f, '--yes'], p);
  expect(r.code).toBe(0);
  expect(p.asked).toEqual([]);
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toContain('max_attempts: 5');
});

test('report lists off-gates for a python repo', async () => {
  const root = makeRepo(PYTHON);
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/Gates that are off[\s\S]*TDD[\s\S]*Vitest or Jest/);
  expect(r.out).toMatch(/Gates that are on[\s\S]*guard/);
});

test('refuses outside a git repo and on an old Node', async () => {
  const nogit = makeRepo({ 'a.txt': 'a' }, { git: false });
  expect((await go(nogit, ['--yes'])).out).toContain('Not a git repository. Run /harness:init inside a git repo.');
  const root = makeRepo(NPM_VITEST);
  const r = await go(root, ['--yes'], fake(), { nodeVersion: '20.1.0' });
  expect(r.code).toBe(1);
  expect(r.out).toContain('Node 20.1.0 is too old. Harness needs Node 22.11 or newer.');
});

test('editing a value validates it', async () => {
  const root = makeRepo(NPM_VITEST);
  const p: Prompt = { async confirm() { return true; }, async edit(label, v) { return label === 'unattended' ? '{"bad": 1}' : v; } };
  const r = await go(root, [], p);
  expect(r.code).toBe(2);
  expect(r.out).toContain('unattended.bad: unknown key');
});

test('planChanges omits unchanged files and decides create vs update', () => {
  const root = makeRepo({ ...NPM_VITEST, 'AGENTS.md': 'mine\n' });
  const facts = detect(root);
  const p = planChanges(root, preset(facts).config, facts, { version: '1.2.3', distDir, templatesDir });
  const kinds = Object.fromEntries(p.changes.map((c) => [c.rel, c.kind]));
  expect(kinds['AGENTS.md']).toBe('update');
  expect(kinds['.harness/config.yaml']).toBe('create');
  expect(kinds['.gitignore']).toBe('update');
  expect(kinds['package.json']).toBeUndefined();
});

test('templates checked out with CRLF are installed with LF', () => {
  const crlf = mkdtempSync(join(tmpdir(), 'harness-tpl-'));
  cpSync(templatesDir, crlf, { recursive: true });
  const files = ['agents/staff-reviewer.md', 'skills/review-rubric/SKILL.md'];
  for (const f of files) writeFileSync(join(crlf, f), readFileSync(join(templatesDir, f), 'utf8').replace(/\r?\n/g, '\r\n'));
  const root = makeRepo(NPM_VITEST);
  const facts = detect(root);
  const p = planChanges(root, preset(facts).config, facts, { version: '1.2.3', distDir, templatesDir: crlf });
  for (const [f, rel] of [[files[0], '.claude/agents/staff-reviewer.md'], [files[1], '.claude/skills/review-rubric/SKILL.md']] as const) {
    const c = p.changes.find((x) => x.rel === rel);
    expect(c && c.kind === 'create' && c.content, rel).toBe(readFileSync(join(templatesDir, f), 'utf8').replace(/\r\n/g, '\n'));
  }
});

test('the hook bundle never contains magicast', () => {
  expect(readFileSync(join(distDir, 'hooks', 'dispatch.mjs'), 'utf8')).not.toContain('magicast');
});

test('preset reasons describe the multi-file gate and require_reason accurately', () => {
  const r = preset(detect(makeRepo(NPM_VITEST))).reasons;
  expect(r['checks.multiFile']).toBe('Asks you once per turn before an agent edits a second source file (test files never count); your approval covers the rest of that turn.');
  expect(r['unattended.require_reason']).toBe('Only used when the unattended gate is allow-log: extra files then need a one-line reason. It has no effect while the gate is block.');
});

test('partial --config keeps detected values', async () => {
  const root = makeRepo(NPM_VITEST);
  const f = join(root, '..', `part-${Date.now()}.yaml`);
  writeFileSync(f, 'stop:\n  max_attempts: 5\n');
  expect((await go(root, ['--config', f, '--yes'])).code).toBe(0);
  const y = readFileSync(join(root, '.harness/config.yaml'), 'utf8');
  expect(y).toContain('max_attempts: 5');
  expect(y).toContain('package_manager: npm');
  expect(y).toContain('src/**');
  expect(y).toMatch(/tdd: true/);
});

test('report off-reasons match the final config', async () => {
  const root = makeRepo(NPM_VITEST);
  const f = join(root, '..', `off-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify({ checks: { tdd: false } }));
  const r = await go(root, ['--config', f, '--yes']);
  expect(r.out).toMatch(/Gates that are off:\n\s+TDD: Turned off in the config\./);
  expect(r.out).not.toContain('Vitest or Jest (');
});

test('--dry-run on dirty files warns and exits 0', async () => {
  const root = makeRepo(NPM_VITEST);
  writeFileSync(join(root, '.gitignore'), 'node_modules\nlocal\n');
  const r = await go(root, ['--yes', '--dry-run']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('These files have uncommitted changes; commit or stash them before applying: .gitignore.');
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

const NPM_JEST = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'jest.config.js': 'module.exports = {};\n',
  '.gitignore': 'node_modules\n',
};

test('jest repo: init installs the harness reporter, wires it in the test script, and the manifest hashes it', async () => {
  const root = makeRepo(NPM_JEST);
  expect((await go(root, ['--yes'])).code).toBe(0);
  const rep = readFileSync(join(root, '.harness/hooks/jest-results.cjs'), 'utf8');
  expect(rep).toBe(readFileSync(join(templatesDir, 'hooks/jest-results.cjs'), 'utf8').replace(/\r\n/g, '\n'));
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test).toContain('--reporters=./.harness/hooks/jest-results.cjs');
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
  expect(m.files.find((f: { rel: string }) => f.rel === '.harness/hooks/jest-results.cjs')).toMatchObject({ kind: 'create' });
});

test('vitest repo: no jest reporter is installed', async () => {
  const root = makeRepo(NPM_VITEST);
  expect((await go(root, ['--yes'])).code).toBe(0);
  expect(existsSync(join(root, '.harness/hooks/jest-results.cjs'))).toBe(false);
});

test('the jest reporter creates the results folder and writes what the TDD gate reads', async () => {
  const { createRequire } = await import('node:module');
  const { readResults } = await import('../../src/checks/tdd/results.js');
  const root = makeRepo({ 'src/a.test.js': '' }, { git: false });
  const Reporter = createRequire(import.meta.url)(join(templatesDir, 'hooks/jest-results.cjs'));
  const out = join(root, '.harness/results/root.json');
  new Reporter({ outputFile: out }).onRunComplete(new Set(), {
    testResults: [{ testFilePath: join(root, 'src/a.test.js'), numFailingTests: 1, testResults: [{ fullName: 'a adds', status: 'failed' }, { fullName: 'a ok', status: 'passed' }] }],
  });
  const r = readResults(root, join(root, '.harness/results'));
  expect(r).toEqual([{ file: 'src/a.test.js', status: 'failed', tests: [{ fullName: 'a adds', status: 'failed' }, { fullName: 'a ok', status: 'passed' }], writtenAt: expect.any(Number) }]);
});

test('vitest without a coverage provider: init says the coverage gate is off and how to turn it on', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await go(root, ['--yes']);
  expect(r.out).toContain('Coverage gate off for the root package: install @vitest/coverage-v8 to turn on the coverage gate.');
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).not.toContain('enabled: true');
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toMatch(/coverage_skip:\n {4}- src\/\*\*/);
});

test('init leaves out Stop steps whose tool is not on PATH and lists them', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'h-bin-'));
  for (const n of ['pytest', 'pytest.cmd']) writeFileSync(join(bin, n), '#!/bin/sh\n', { mode: 0o755 });
  const root = makeRepo(PYTHON);
  const r = await go(root, ['--yes'], fake(), { env: { PATH: bin, HARNESS_PLAIN_INIT: '1' } });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Stop steps left out:\n  ruff: `ruff` is not on PATH. Install it, then add the step to stop.steps.');
  const y = readFileSync(join(root, '.harness/config.yaml'), 'utf8');
  expect(y).toContain('pytest');
  expect(y).not.toContain('ruff');
});

test('jest coverageReporters without json: TDD on, coverage gate off for that package, reason printed', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' }, jest: { coverageReporters: ['text'] } }, null, 2) + '\n',
    'package-lock.json': '{}\n',
    '.gitignore': 'node_modules\n',
  });
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^Gates that are on: .*TDD/m);
  expect(r.out).not.toMatch(/^Gates that are on: .*coverage/m); // N7: the only package is skipped
  expect(r.out).toMatch(/^Gates that are off:\n  coverage: Coverage gate off for the root package/m);
  expect(r.out.slice(r.out.indexOf('Gates that are off'))).toContain("Coverage gate off for the root package: `package.json` \"jest\" sets `coverageReporters` without 'json'; the gate reads coverage/coverage-final.json");
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toMatch(/coverage_skip:\n\s+- src\/\*\*/);
});

// C2: Prettier reads .gitignore, not the committed .harness/ files, so init adds .prettierignore when Prettier is used.
const WITH_PRETTIER = { ...NPM_VITEST, 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0', prettier: '^3.0.0' } }, null, 2) + '\n' };
test('prettier dependency, no .prettierignore: init creates it; uninstall removes it, or only the harness line once the user added one', async () => {
  const { uninstall } = await import('../../src/cli/uninstall.js');
  const un = (root: string) => uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() });
  const root = makeRepo(WITH_PRETTIER);
  expect((await go(root, ['--yes'])).out).toContain('  create .prettierignore');
  expect(readFileSync(join(root, '.prettierignore'), 'utf8')).toBe('.harness/\n');
  expect(await un(root)).toBe(0);
  expect(existsSync(join(root, '.prettierignore'))).toBe(false);
  const r2 = makeRepo(WITH_PRETTIER);
  await go(r2, ['--yes']);
  writeFileSync(join(r2, '.prettierignore'), '.harness/\ndist/\n');
  expect(await un(r2)).toBe(0);
  expect(readFileSync(join(r2, '.prettierignore'), 'utf8')).toBe('dist/\n');
  // no Prettier anywhere: no file
  const r3 = makeRepo(NPM_VITEST);
  await go(r3, ['--yes']);
  expect(existsSync(join(r3, '.prettierignore'))).toBe(false);
});

test('prettier in a workspace package counts too', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'packages/a/package.json': JSON.stringify({ name: 'a', devDependencies: { prettier: '3' } }),
  }, { git: false });
  expect(detect(root).prettier).toBe(true);
  expect(detect(makeRepo({ 'package.json': '{}' }, { git: false })).prettier).toBeUndefined();
});

test('eslint flat config with only a per-object ignores: init appends a global-ignores entry', async () => {
  const root = makeRepo({ ...NPM_VITEST, 'eslint.config.js': 'export default [\n  { files: ["src/**"], ignores: ["src/gen/**"] },\n];\n' });
  const r = await go(root, ['--yes']);
  expect(r.out).not.toContain("add '.harness/' to the ignores array");
  expect(readFileSync(join(root, 'eslint.config.js'), 'utf8')).toBe('export default [\n  { files: ["src/**"], ignores: ["src/gen/**"] },\n  { ignores: [".harness/"] },\n];\n');
});

// ---- AI init: validated files, the budget ask and plugin installs ----
const SECTIONS = '## Findings\n\n## Roadmap\n30 days: a. 60 days: b. 90 days: c.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n';
const PRODUCT = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n');
const ANSWERS = {
  scope: { paths: ['src'] },
  project: { type: 'library', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] },
  apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 },
};
const aiDir = mkdtempSync(join(tmpdir(), 'harness-ai-'));
let n = 0;
/** Writes the four AI files for `ids` and returns the flag list. */
const aiArgs = (ids: string[], o: { budget?: number; skip?: string; picks?: object } = {}): string[] => {
  const d = join(aiDir, `r${n++}`);
  mkdirSync(d);
  const f = (name: string, text: string) => (writeFileSync(join(d, name), text), join(d, name));
  const picks = o.picks ?? { catalog_version: 1, findings: [], items: ids.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) };
  const a = ['--answers', f('answers.json', JSON.stringify(ANSWERS)), '--product', f('product.md', PRODUCT), '--picks', f('picks.json', JSON.stringify(picks)), '--report', f('report.md', SECTIONS), '--choose', ids.join(',')];
  if (o.budget !== undefined) a.push('--config', f('cfg.yaml', `context:\n  budget_tokens: ${o.budget}\n`));
  if (o.skip) a.splice(a.indexOf(o.skip), 2);
  return a;
};
const ai = (root: string, args: string[], extra: object = {}) =>
  go(root, args, fake(), { env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, claudeVersion: () => null, ...extra });
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'review-rubric', 'agents-md'];
const tree = (root: string) => git(root, 'status', '--porcelain', '-uall');

test('AI init needs all inputs', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs(OWN, { skip: '--picks' }), '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('init: --picks <file> is required inside Claude Code');
});

test('invalid picks stop before planning', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs(OWN, { picks: { catalog_version: 1, findings: [], items: [{ id: 'nope', include: 'recommended', reason: 'r', addresses: [] }] } }), '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('unknown item "nope"');
  expect(r.out).not.toContain('Plan:');
});

test('AI init dry run shows the plan and the budget', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs([...OWN, 'impeccable', 'mobile-mcp']), '--dry-run']);
  expect(r.code).toBe(0);
  for (const f of ['.mcp.json', '.claude/settings.json', '.harness/facts.json', '.harness/picks.json', '.harness/report.md', '.harness/context/product.md', '.harness/config.yaml']) expect(r.out, f).toContain(f);
  expect(r.out).toContain('Always-loaded context from harness');
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(tree(root)).toBe('');
});

test('over budget with --yes refuses before writing; --over-budget applies', async () => {
  const root = makeRepo(NPM_VITEST);
  const args = [...aiArgs(OWN, { budget: 10 }), '--yes'];
  const r = await ai(root, args);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/This goes over the context budget \(~\d+ of 10 tokens, estimate\)\. Run again with --over-budget to accept, or pick fewer items\./);
  expect(tree(root)).toBe('');
  const r2 = await ai(root, [...args, '--over-budget']);
  expect(r2.code).toBe(0);
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(true);
  expect(existsSync(join(root, '.harness/report.md'))).toBe(true);
});

test('a new plugin pick asks under budget', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs([...OWN, 'impeccable']), '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('Not measured before install: impeccable');
  expect(tree(root)).toBe('');
});

test('init --dry-run with every AI flag writes nothing', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs(OWN, { budget: 10 }), '--install-plugins', '--over-budget', '--dry-run']);
  expect(r.code).toBe(0);
  expect(tree(root)).toBe('');
});

test('a write the OS refuses rolls back and prints the person\'s command', async () => {
  const root = makeRepo(NPM_VITEST);
  const fs = {
    ...realFs,
    renameSync: (a: string, b: string) => {
      if (b.replace(/\\/g, '/').endsWith('.claude/settings.json')) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      return realFs.renameSync(a, b);
    },
  };
  const r = await ai(root, [...aiArgs(OWN), '--yes', '--over-budget'], { fs });
  expect(r.code).toBe(1);
  expect(r.out).toContain("Claude Code's sandbox blocks harness's own files. Run this yourself with Claude Code's `!` prefix: ");
  expect(r.out).toContain('init');
  expect(r.out).toContain('--yes');
  expect(tree(root)).toBe('');
});

test('--install-plugins installs the pinned ids after apply, and rehashes settings', async () => {
  const root = makeRepo(NPM_VITEST);
  const seen: string[][] = [];
  const exec = (_c: string, a: string[]) => {
    seen.push(a);
    const p = join(root, '.claude/settings.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/\n$/, '') + '\n\n');
    return { status: 0, stdout: 'Installing...\n{"command":"install","outcome":"ok","message":"done"}' };
  };
  const r = await ai(root, [...aiArgs([...OWN, 'impeccable']), '--yes', '--over-budget', '--install-plugins'], { exec });
  expect(r.code).toBe(0);
  expect(seen).toEqual([['plugin', 'install', 'impeccable@harness-pins', '--scope', 'project', '--json']]);
  expect(r.out).toContain('impeccable@harness-pins');
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
  const text = readFileSync(join(root, '.claude/settings.json'), 'utf8');
  expect(m.files.find((f: { rel: string }) => f.rel === '.claude/settings.json').hash).toBe(createHash('sha256').update(text).digest('hex'));
});

test('a failed plugin install prints the per-plugin command and the sync line; a sandbox network failure exits 1', async () => {
  const run = async (message: string) => {
    const root = makeRepo(NPM_VITEST);
    return ai(root, [...aiArgs([...OWN, 'impeccable']), '--yes', '--over-budget', '--install-plugins'], { exec: () => ({ status: 0, stdout: JSON.stringify({ command: 'install', outcome: 'failed', message }) }) });
  };
  const net = await run('getaddrinfo ENOTFOUND github.com');
  expect(net.code).toBe(1);
  expect(net.out).toContain("Run this yourself with Claude Code's `!` prefix: claude plugin install impeccable@harness-pins --scope project");
  expect(net.out).toContain('Then run /harness:sync to record the install.');
  const other = await run('Plugin impeccable@harness-pins requires a newer Claude Code');
  expect(other.code).toBe(1);
  expect(other.out).toContain('Files applied; 1 plugin(s) not installed.');
  expect(other.out).toContain('requires a newer Claude Code');
  expect(other.out).not.toContain('Restart Claude Code');
});

test('plugin or budget flags without the AI flags are a usage error', async () => {
  const root = makeRepo(NPM_VITEST);
  for (const f of ['--install-plugins', '--over-budget']) expect((await go(root, ['--dry-run', f])).code).toBe(2);
});

test('the gate report follows the written config, not the preset', async () => {
  const root = makeRepo(NPM_VITEST);
  const r = await ai(root, [...aiArgs(['agent-guard', 'agents-md']), '--yes', '--over-budget']);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/Gates that are off:[\s\S]*TDD/);
  expect(r.out).toMatch(/Gates that are on: .*guard/);
  expect(r.out.match(/Gates that are on: (.*)/)![1]).not.toContain('TDD');
});

test('interactive: the budget lines print before the confirm', async () => {
  const root = makeRepo(NPM_VITEST);
  const order: string[] = [];
  const prompt: Prompt = { async confirm(q) { order.push(`ask:${q}`); return false; }, async edit(_l, v) { return v; } };
  let out = '';
  const code = await init(aiArgs(OWN, { budget: 10 }), { root, env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, out: (s) => (order.push(`out:${s}`), (out += s + '\n')), prompt, version: '1.2.3', templatesDir, distDir, claudeVersion: () => null });
  expect(code).toBe(0);
  const ask = order.findIndex((o) => o.startsWith('ask:Apply these changes'));
  expect(ask).toBeGreaterThan(order.findIndex((o) => o.includes('Over budget: confirm before installing.')));
  expect(order.findIndex((o) => o.includes('Over budget'))).toBeGreaterThan(-1);
});

// chmod can't make a directory read-only on Windows, and root ignores the mode.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an ok install then a refused manifest write exits 1 with the sync line', async () => {
  const { installSelected } = await import('../../src/cli/init.js');
  const { loadCatalog } = await import('../../src/catalog/load.js');
  const { applyChanges } = await import('../../src/install/apply.js');
  const { chmodSync } = realFs;
  const root = makeRepo({});
  applyChanges(root, [{ kind: 'create', rel: '.claude/settings.json', content: '{"a":1}\n' }], '1');
  writeFileSync(join(root, '.claude/settings.json'), '{"a":2}\n'); // what the install changed
  chmodSync(join(root, '.harness'), 0o555);
  let out = '';
  try {
    expect(installSelected(root, ['impeccable'], loadCatalog().catalog, () => ({ status: 0, stdout: '{"command":"install","outcome":"ok","message":"x"}' }), (s) => (out += s + '\n'))).toBe(1);
  } finally {
    chmodSync(join(root, '.harness'), 0o755);
  }
  expect(out).toContain('Run /harness:sync to record the install.');
});
