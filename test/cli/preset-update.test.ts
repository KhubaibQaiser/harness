import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const fixture = join(pkgDir, 'test', 'fixtures', 'presets');

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
const pkg = (deps: object) => JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: deps, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n';
const NEXT_EXPO = { react: '^18.0.0', next: '^14.0.0', expo: '^50.0.0', 'react-native': '^0.73.0' };
const repo = () => makeRepo({
  'package.json': pkg(NEXT_EXPO),
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
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
const CHOSEN = [...OWN, 'core-rules', 'engineering-principles', 'frontend-react', 'frontend-nextjs', 'frontend-react-native'];
const dir = mkdtempSync(join(tmpdir(), 'harness-pu-'));
let n = 0;
const aiArgs = (ids: string[], answers: object | null = ANSWERS): string[] => {
  const d = join(dir, `r${n++}`);
  mkdirSync(d);
  const f = (name: string, text: string) => (writeFileSync(join(d, name), text), join(d, name));
  const picks = { catalog_version: 1, findings: [], items: [...OWN, 'ponytail'].map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) };
  return [...(answers ? ['--answers', f('answers.json', JSON.stringify(answers))] : []), '--product', f('product.md', PRODUCT), '--picks', f('picks.json', JSON.stringify(picks)), '--report', f('report.md', SECTIONS), '--choose', ids.join(','), '--yes', ...(ids.includes('ponytail') ? ['--over-budget'] : [])];
};
const fake: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
// Files by content hash and directories by name, so an empty leftover directory fails a comparison.
const hashes = (root: string) => (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[]).map((f) => f.replace(/\\/g, '/')).filter((f) => !f.startsWith('.git/') && f !== '.git').sort().map((f) => statSync(join(root, f)).isFile() ? f + createHash('sha256').update(readFileSync(join(root, f))).digest('hex') : `${f}/`);
const env = { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' };
const run = async (root: string, args: string[]) => {
  let out = '';
  const code = await init(args, { ...base, version: '1.2.3', root, env, claudeVersion: () => null, out: (s) => (out += s + '\n'), prompt: fake });
  return { code, out };
};
const up = async (root: string, args: string[], version = '1.2.3') => {
  let out = '';
  const code = await update(args, { ...base, version, root, env, claudeVersion: () => null, out: (s) => (out += s + '\n'), prompt: fake });
  return { code, out };
};
const commit = (root: string, msg: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg); };
const installed = async () => {
  const root = repo();
  const r = await run(root, aiArgs(CHOSEN));
  expect(r.code, r.out).toBe(0);
  commit(root, 'harness');
  return root;
};
const cfg = (root: string) => parse(readFileSync(join(root, '.harness/config.yaml'), 'utf8'));
const RN = '.claude/skills/frontend-react-native/SKILL.md';

test('a changed core.md replaces the block in place', async () => {
  const root = await installed();
  writeFileSync(join(root, '.harness/presets/stacks/templates/core.md'), 'Changed core block.\n');
  commit(root, 'core');
  const r = await up(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(agents).toContain('Changed core block.');
  expect(agents).not.toContain('Fixture core block.');
  expect(agents.match(/harness:preset:start/g)).toHaveLength(1);
});

test('a stack that is gone drops its skill and its id from preset.items', async () => {
  const root = await installed();
  expect(existsSync(join(root, RN))).toBe(true);
  writeFileSync(join(root, 'package.json'), pkg({ react: '^18.0.0', next: '^14.0.0' }));
  commit(root, 'drop expo');
  const r = await up(root, ['--dry-run']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`delete ${RN}`);
  const real = await up(root, ['--yes']);
  expect(real.code, real.out).toBe(0);
  expect(existsSync(join(root, RN))).toBe(false);
  expect(cfg(root).preset.items).not.toContain('frontend-react-native');
  expect(cfg(root).preset.items).toContain('frontend-nextjs');
});

test('a skill that newly matches is noted, not written', async () => {
  const root = repo();
  writeFileSync(join(root, 'package.json'), pkg({ react: '^18.0.0' }));
  commit(root, 'react only');
  expect((await run(root, aiArgs(['core-rules', 'engineering-principles', 'frontend-react', ...OWN]))).code).toBe(0);
  commit(root, 'harness');
  writeFileSync(join(root, 'package.json'), pkg(NEXT_EXPO));
  commit(root, 'add stacks');
  const r = await up(root, ['--dry-run']);
  expect(r.out).toContain('Note: frontend-nextjs now applies here; run /harness:update and tick it to add it.');
  expect(r.out).not.toContain('create .claude/skills/frontend-nextjs');
});

test('update without answers leaves preset in config.yaml as it is', async () => {
  const root = await installed();
  const before = cfg(root).preset;
  const r = await up(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(cfg(root).preset).toEqual(before);
});

test('preset null removes it, keeps preselected plugins, and uninstall is byte-identical to before init', async () => {
  const root = repo();
  const before = hashes(root);
  const i0 = await run(root, aiArgs([...CHOSEN, 'ponytail']));
  expect(i0.code, i0.out).toBe(0);
  commit(root, 'harness');
  const r = await up(root, aiArgs([...OWN, 'ponytail'], { preset: null }));
  expect(r.code, r.out).toBe(0);
  const c = cfg(root);
  expect(c.preset).toBeUndefined();
  expect(c.items.map((i: { id: string }) => i.id)).toContain('ponytail');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(agents).not.toContain('harness:preset');
  expect(existsSync(join(root, RN))).toBe(false);
  const settings = readFileSync(join(root, '.claude/settings.json'), 'utf8');
  expect(settings).not.toContain('DO_NOT_TRACK');
  expect(settings).not.toContain('attribution');
  commit(root, 'off');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake });
  expect(hashes(root)).toEqual(before);
});

test('a deleted preset folder is reported and nothing about the preset changes', async () => {
  const root = await installed();
  rmSync(join(root, '.harness/presets'), { recursive: true });
  commit(root, 'rm presets');
  const r = await up(root, ['--dry-run']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Preset "stacks" was not found; its files are kept as they are.');
  expect(r.out).not.toMatch(/delete .*SKILL\.md/);
});

test('init without a preset, update with it, update without it: uninstall is byte-identical to before init', async () => {
  const root = repo();
  const before = hashes(root);
  expect((await run(root, aiArgs(OWN, { ...ANSWERS, preset: null }))).code).toBe(0);
  commit(root, 'harness');
  const on = await up(root, aiArgs(CHOSEN, { preset: 'stacks' }));
  expect(on.code, on.out).toBe(0);
  expect(cfg(root).preset.id).toBe('stacks');
  commit(root, 'preset on');
  const off = await up(root, aiArgs(OWN, { preset: null }));
  expect(off.code, off.out).toBe(0);
  expect(cfg(root).preset).toBeUndefined();
  commit(root, 'preset off');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake });
  expect(hashes(root)).toEqual(before);
});

test('update refreshes preset.version to the installed version', async () => {
  const root = await installed();
  const r = await up(root, ['--yes'], '1.3.0');
  expect(r.code, r.out).toBe(0);
  expect(cfg(root).preset.version).toBe('1.3.0');
});

test('a legacy results_dir is migrated in the same update that drops a gone stack', async () => {
  const root = await installed();
  const text = readFileSync(join(root, '.harness/config.yaml'), 'utf8');
  expect(text).toMatch(/^\s*results_dir:/m);
  writeFileSync(join(root, '.harness/config.yaml'), text.replace(/^(\s*results_dir:).*$/m, '$1 .harness/state/test-results'));
  writeFileSync(join(root, 'package.json'), pkg({ react: '^18.0.0', next: '^14.0.0' }));
  commit(root, 'legacy + drop expo');
  const r = await up(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).not.toContain('state/test-results');
  expect(cfg(root).preset.items).not.toContain('frontend-react-native');
});

test('a preset folder whose skill now writes outside its own folder is reported invalid, and update changes nothing', async () => {
  const root = await installed();
  const p = join(root, '.harness/presets/stacks/items/frontend-react.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace('to: .claude/skills/frontend-react/SKILL.md', 'to: .git/hooks/pre-commit'));
  commit(root, 'bad destination');
  const before = hashes(root);
  const r = await up(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/Preset "stacks" is invalid \(.*must be under \.claude\/skills\/frontend-react\/.*\); its files are kept as they are\./);
  expect(hashes(root)).toEqual(before);
  expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(false);
});
