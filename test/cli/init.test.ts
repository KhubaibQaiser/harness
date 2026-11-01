import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const code = await init(args, { root, env: {}, out: (s) => (out += s + '\n'), prompt, version: '1.2.3', templatesDir, distDir, ...extra });
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
});

test('second init refuses and names update', async () => {
  const root = makeRepo(NPM_VITEST);
  await go(root, ['--yes']);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@e.x', 'commit', '-qm', 'harness');
  const r = await go(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('Harness is already installed (.harness/manifest.json). Run harness update instead.');
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
  expect((await go(nogit, ['--yes'])).out).toContain('Not a git repository. Run harness init inside a git repo.');
  const root = makeRepo(NPM_VITEST);
  const r = await go(root, ['--yes'], fake(), { nodeVersion: '20.1.0' });
  expect(r.code).toBe(1);
  expect(r.out).toContain('Node 20.1.0 is too old. Harness needs Node 22.11 or newer.');
});

test('editing a value validates it', async () => {
  const root = makeRepo(NPM_VITEST);
  const p: Prompt = { async confirm() { return true; }, async edit(label, v) { return label === 'unattended' ? '{"bad": 1}' : v; } };
  const r = await go(root, ['--dry-run'], p);
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

test('the hook bundle never contains magicast', () => {
  expect(readFileSync(join(distDir, 'hooks', 'dispatch.mjs'), 'utf8')).not.toContain('magicast');
});

test('preset reasons describe the multi-file gate and require_reason accurately', () => {
  const r = preset(detect(makeRepo(NPM_VITEST))).reasons;
  expect(r['checks.multiFile']).toBe('Asks you once per turn before an agent edits a second source file; your approval covers the rest of that turn.');
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
