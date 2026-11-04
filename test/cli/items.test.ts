import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { items } from '../../src/cli/items.js';
import type { Prompt } from '../../src/cli/prompt.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { changedFiles, readRepoSnapshot, snapshotHarnessFiles } from '../../src/core/harness-files.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { itemFiles } from '../../src/install/manifest.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = join(pkgDir, 'templates');
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
};
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'review-rubric', 'agents-md'];
const PICKS = JSON.stringify({
  catalog_version: 1,
  findings: [{ id: 'f1', severity: 'critical', title: 'No reviewer' }],
  items: [{ id: 'staff-reviewer', include: 'recommended', reason: 'Reviews every diff.', addresses: ['f1'] }],
});
const commitAll = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
};
const installed = (ids: string[] = OWN) => {
  const root = makeRepo(REPO);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' })).map((i) => (i.id === 'staff-reviewer' ? { ...i, reason: 'Reviews every diff.', addresses: ['f1'] } : i));
  const ai = { picks: PICKS, report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai }).changes, '1.0.0');
  commitAll(root);
  return root;
};
const noPrompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const CLAUDE = { CLAUDECODE: '1' };
const run = async (root: string, cmd: 'add' | 'remove' | 'why' | 'explain', args: string[], env: NodeJS.ProcessEnv = CLAUDE, catalog?: ReturnType<typeof loadCatalog>['catalog']) => {
  let out = '';
  const code = await items(cmd, args, { env, root, out: (s) => (out += s + '\n'), prompt: noPrompt, templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null, catalog });
  return { code, out };
};
const tree = (root: string, dir = ''): Record<string, string> => Object.fromEntries(readdirSync(join(root, dir)).filter((n) => n !== '.git').flatMap((n) => {
  const rel = dir ? `${dir}/${n}` : n;
  return statSync(join(root, rel)).isDirectory() ? Object.entries(tree(root, rel)) : [[rel, readFileSync(join(root, rel), 'utf8')]];
}));
const SR = '.claude/agents/staff-reviewer.md';

test('add pulls in requires', async () => {
  const root = installed();
  const cat = structuredClone(loadCatalog().catalog);
  cat.items.find((i) => i.id === 'staff-reviewer')!.requires = ['mobile-mcp'];
  const r = await run(root, 'add', ['staff-reviewer', '--yes', '--over-budget'], CLAUDE, cat);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Added mobile-mcp because staff-reviewer requires it.');
  expect(existsSync(join(root, SR))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers).toHaveProperty('mobile-mcp');
  expect(itemFiles(readManifest(root)!, 'mobile-mcp')[0].rel).toBe('.mcp.json');
});

test('add refuses a conflict', async () => {
  const root = installed();
  const r = await run(root, 'add', ['probity', '--yes', '--over-budget']);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/probity and tdd-gate conflict|tdd-gate and probity conflict/);
  expect(readManifest(root)!.files.some((f) => f.item === 'probity')).toBe(false);
});

test('add records the pick reason or the hand-added reason', async () => {
  const root = installed();
  expect((await run(root, 'add', ['staff-reviewer', '--yes'])).code).toBe(0);
  const cfg = readFileSync(join(root, '.harness/config.yaml'), 'utf8');
  expect(cfg).toContain('Reviews every diff.');
  commitAll(root);
  expect((await run(root, 'add', ['shadcn-mcp', '--yes', '--over-budget'])).code).toBe(0);
  expect(readFileSync(join(root, '.harness/config.yaml'), 'utf8')).toContain('Added by hand with harness add.');
});

test('add over budget refuses with --yes and applies with --over-budget', async () => {
  const root = installed();
  const r = await run(root, 'add', ['mobile-mcp', '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('Over budget:');
  expect(r.out).toContain('--over-budget');
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  const ok = await run(root, 'add', ['mobile-mcp', '--yes', '--over-budget']);
  expect(ok.code, ok.out).toBe(0);
  expect(ok.out).toContain('Run harness git commit on a branch to commit this change.');
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
});

test('add --dry-run writes nothing', async () => {
  const root = installed();
  const before = tree(root);
  const r = await run(root, 'add', ['staff-reviewer', '--dry-run']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(tree(root)).toEqual(before);
});

test('remove refuses a required item', async () => {
  const root = installed();
  const cat = structuredClone(loadCatalog().catalog);
  cat.items.find((i) => i.id === 'stop-gate')!.requires = ['review-rubric'];
  const r = await run(root, 'remove', ['review-rubric', '--yes'], {}, cat);
  expect(r.code).toBe(1);
  expect(r.out).toContain('stop-gate requires review-rubric; remove stop-gate first.');
});

test('remove of the last mcp item deletes .mcp.json', async () => {
  const root = installed([...OWN, 'mobile-mcp']);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
  const r = await run(root, 'remove', ['mobile-mcp', '--yes'], {});
  expect(r.code, r.out).toBe(0);
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.rel === '.mcp.json')).toBe(false);
});

test('remove then add is byte-identical to before', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const before = tree(root);
  expect((await run(root, 'remove', ['staff-reviewer', '--yes'], {})).code).toBe(0);
  expect(existsSync(join(root, SR))).toBe(false);
  commitAll(root);
  expect((await run(root, 'add', ['staff-reviewer', '--yes'])).code).toBe(0);
  const after = tree(root);
  for (const t of [before, after]) for (const k of Object.keys(t)) if (k === '.harness/manifest.json' || k.startsWith('.harness/backup/') || k.startsWith('.harness/state/')) delete t[k]; // bookkeeping, not content
  expect(after).toEqual(before);
});

test('remove agent-guard prints the guard line', async () => {
  const root = installed();
  const r = await run(root, 'remove', ['agent-guard', '--yes'], {});
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('The guard is off now, so the agent can run harness commands without asking.');
  expect((await run(installed(), 'remove', ['stop-gate', '--yes'], {})).out).not.toContain('guard is off');
});

test('add and remove leave no change for change detection', async () => {
  const root = installed();
  await run(root, 'add', ['staff-reviewer', '--yes']);
  expect(changedFiles(readRepoSnapshot(root).lastSeen!.files, snapshotHarnessFiles(root))).toEqual([]);
  commitAll(root);
  await run(root, 'remove', ['staff-reviewer', '--yes'], {});
  expect(changedFiles(readRepoSnapshot(root).lastSeen!.files, snapshotHarnessFiles(root))).toEqual([]);
});

test('why prints reason, findings and cost', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const r = await run(root, 'why', ['staff-reviewer'], {});
  expect(r.code).toBe(0);
  expect(r.out).toContain('staff-reviewer: Reviews every diff.');
  expect(r.out).toContain('[critical] No reviewer');
  expect(r.out).toMatch(/Cost: context \w+, setup \w+\./);
  expect(r.out).toMatch(/Context: ~\d+ tokens \(estimate\)/);
});

test('why for an uninstalled item, and an unknown one', async () => {
  const root = installed();
  const r = await run(root, 'why', ['mobile-mcp'], {});
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^Not installed\. .+ Cost: context \w+, setup \w+\.$/m);
  expect((await run(root, 'why', ['nope'], {})).code).toBe(1);
});

test('explain lists items and files', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const r = await run(root, 'explain', [], {});
  expect(r.code).toBe(0);
  expect(r.out).toContain('staff-reviewer (own-agent): Reviews every diff.');
  expect(r.out).toContain(`  ${SR}`);
  expect(r.out).toMatch(/Always-loaded context from harness: ~\d+ tokens/);
});

test('add refuses outside Claude Code; remove, why and explain do not', async () => {
  const root = installed();
  const a = await run(root, 'add', ['staff-reviewer', '--yes'], {});
  expect(a.code).toBe(2);
  expect(a.out).toContain('Run /harness:add inside Claude Code.');
  expect((await run(root, 'why', ['stop-gate'], {})).code).toBe(0);
  expect((await run(root, 'explain', [], {})).code).toBe(0);
  expect((await run(root, 'remove', ['stop-gate', '--dry-run'], {})).code).toBe(0);
});
