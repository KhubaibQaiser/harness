import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { init, type Prompt } from '../../src/cli/init.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const fixture = join(pkgDir, 'test', 'fixtures', 'presets');

/** The stacks fixture as `.harness/presets/...` files (forward slashes), so it is committed with the repo. */
function presetFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const n of readdirSync(join(fixture, rel))) {
      const r = rel ? `${rel}/${n}` : n;
      if (statSync(join(fixture, r)).isDirectory()) walk(r);
      else if (r.startsWith('stacks')) files[`.harness/presets/${r}`] = readFileSync(join(fixture, r), 'utf8');
    }
  };
  walk('');
  return files;
}
const repo = (settings?: string) => makeRepo({
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
  ...(settings ? { '.claude/settings.json': settings } : {}),
  ...presetFiles(),
});

const SECTIONS = '## Findings\n\n## Roadmap\n30 days: a. 60 days: b. 90 days: c.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n';
const PRODUCT = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n');
const ANSWERS = {
  scope: { paths: ['src'] }, preset: 'stacks',
  project: { type: 'web', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] },
  apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 },
};
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'review-rubric', 'agents-md'];
const dir = mkdtempSync(join(tmpdir(), 'harness-pi-'));
let n = 0;
const aiArgs = (ids: string[]): string[] => {
  const d = join(dir, `r${n++}`);
  mkdirSync(d);
  const f = (name: string, text: string) => (writeFileSync(join(d, name), text), join(d, name));
  const picks = { catalog_version: 1, findings: [], items: OWN.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) };
  return ['--answers', f('answers.json', JSON.stringify(ANSWERS)), '--product', f('product.md', PRODUCT), '--picks', f('picks.json', JSON.stringify(picks)), '--report', f('report.md', SECTIONS), '--choose', ids.join(','), '--yes'];
};
const fake: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const hashes = (root: string) => git(root, 'ls-files').split('\n').filter(Boolean).map((f) => f + createHash('sha256').update(readFileSync(join(root, f))).digest('hex'));
const run = async (root: string, args: string[]) => {
  let out = '';
  const code = await init(args, { ...base, root, env: { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' }, claudeVersion: () => null, out: (s) => (out += s + '\n'), prompt: fake });
  return { code, out };
};
const CHOSEN = [...OWN, 'core-rules', 'engineering-principles', 'frontend-react'];

test('init records the preset in config.yaml and installs its block, skills and settings', async () => {
  const root = repo();
  const r = await run(root, aiArgs(CHOSEN));
  expect(r.code, r.out).toBe(0);
  const cfg = parse(readFileSync(join(root, '.harness/config.yaml'), 'utf8'));
  expect(cfg.preset.id).toBe('stacks');
  expect(cfg.preset.version).toBe('1.2.3');
  expect(cfg.preset.items).toEqual(['core-rules', 'engineering-principles', 'frontend-react']);
  expect(cfg.preset.git.no_ai_trailer).toBe(true);
  expect(JSON.stringify(cfg.preset)).not.toMatch(/@|user\.name/);
  expect(existsSync(join(root, '.claude/skills/frontend-react/SKILL.md'))).toBe(true);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('harness:preset:start');
});

test('uninstall after a preset install leaves the repo byte-identical', async () => {
  const root = repo();
  const before = hashes(root);
  expect((await run(root, aiArgs(CHOSEN))).code).toBe(0);
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake });
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(hashes(root)).toEqual(before);
});

test('the same with a settings.json that already has env', async () => {
  const root = repo('{"env":{"FOO":"1"}}');
  const before = hashes(root);
  expect((await run(root, aiArgs(CHOSEN))).code).toBe(0);
  expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).env.FOO).toBe('1');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake });
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(hashes(root)).toEqual(before);
});

test('a preset skill the stack does not match is refused', async () => {
  const root = repo();
  const r = await run(root, aiArgs([...OWN, 'core-rules', 'frontend-nextjs']));
  expect(r.code).toBe(2);
  expect(r.out).toContain(`"frontend-nextjs" does not apply to this repo's stack.`);
});

test('a repo preset that is missing is a clear error and nothing is written', async () => {
  const bare = makeRepo({ 'package.json': JSON.stringify({ name: 'a', dependencies: { react: '1' } }) + '\n', 'AGENTS.md': '# Mine\n' });
  const m = await run(bare, aiArgs(CHOSEN));
  expect(m.code).toBe(2);
  expect(m.out).toContain('"stacks" is not a shipped or repo preset');
  expect(git(bare, 'status', '--porcelain')).toBe('');
});

test('an invalid repo preset is a clear error and nothing is written', async () => {
  const root = repo();
  writeFileSync(join(root, '.harness/presets/stacks.yaml'), 'id: stacks\ntitle: 3\n');
  git(root, 'commit', '-qam', 'break');
  const r = await run(root, aiArgs(CHOSEN));
  expect(r.code).toBe(2);
  expect(r.out).toContain('preset:');
  expect(git(root, 'status', '--porcelain')).toBe('');
});

const un = async (root: string, args: string[]) => {
  let out = '';
  await uninstall(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake });
  return out;
};

test('uninstall --yes keeps .harness/presets/ and says so', async () => {
  const root = repo();
  expect((await run(root, aiArgs(CHOSEN))).code).toBe(0);
  const out = await un(root, ['--yes']);
  expect(out).toContain('Removed `.harness/` except `.harness/presets/`, your committed presets.');
  expect(existsSync(join(root, '.harness/presets/stacks.yaml'))).toBe(true);
  expect(existsSync(join(root, '.harness/config.yaml'))).toBe(false);
});

test('uninstall --dry-run says presets stay', async () => {
  const root = repo();
  expect((await run(root, aiArgs(CHOSEN))).code).toBe(0);
  expect(await un(root, ['--dry-run'])).toContain('`.harness/presets/` stays');
});
