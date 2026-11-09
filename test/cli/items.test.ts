import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as realFs from 'node:fs';
import type { FsLike } from '../../src/install/apply.js';
import { expect, test } from 'vitest';
import { items } from '../../src/cli/items.js';
import type { Prompt } from '../../src/cli/prompt.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { changedFiles, readRepoSnapshot, snapshotHarnessFiles } from '../../src/core/harness-files.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { itemFiles } from '../../src/install/manifest.js';
import { hashText } from '../../src/install/text.js';
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
const installed = (ids: string[] = OWN, files: Record<string, string> = REPO) => {
  const root = makeRepo(files);
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
const run = async (root: string, cmd: 'add' | 'remove' | 'why' | 'explain', args: string[], env: NodeJS.ProcessEnv = CLAUDE, catalog?: ReturnType<typeof loadCatalog>['catalog'], fs?: FsLike) => {
  let out = '';
  const code = await items(cmd, args, { env, root, out: (s) => (out += s + '\n'), prompt: noPrompt, templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null, catalog, fs });
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

test('why prints a recorded plugin context_tokens as an estimate', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const cat = structuredClone(loadCatalog().catalog);
  const it = cat.items.find((i) => i.id === 'staff-reviewer')!;
  it.kind = 'plugin'; // plugin picks count the recorded number; no catalog data is changed
  it.cost.context_tokens = 61;
  const r = await run(root, 'why', ['staff-reviewer'], CLAUDE, cat);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Context: ~61 tokens (estimate).\n');
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
  expect(r.out).toMatch(/Always-loaded context: ~[\d,]+ tokens \(estimate\), budget 2,000; harness and its picks ~[\d,]+\./);
});

test('explain counts the repo own CLAUDE.md in the total, not in the harness share', async () => {
  const { 'AGENTS.md': _mine, ...noAgents } = REPO; // AGENTS.md's own text would be in the repo total too
  const root = installed(OWN, { ...noAgents, 'CLAUDE.md': 'x'.repeat(400) }); // 100 tokens
  const [, total, h] = /Always-loaded context: ~([\d,]+) tokens .*harness and its picks ~([\d,]+)\./.exec((await run(root, 'explain', [], {})).out)!.map((s) => Number(s.replace(/,/g, '')));
  // 100 from the file, plus the newline left by cutting harness's @AGENTS.md line, plus AGENTS.md's newline around its block.
  expect(total - h).toBe(102);
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

const MCP = '.mcp.json';
const denied = { ...realFs, renameSync: (a: string, b: string) => { if (b.endsWith('settings.json') || b.endsWith('manifest.json')) throw Object.assign(new Error('EPERM: nope'), { code: 'EPERM' }); return realFs.renameSync(a, b); } } as unknown as FsLike;

test('a sandbox-denied write prints the add or remove command, not update', async () => {
  const root = installed();
  const a = await run(root, 'add', ['mobile-mcp', '--yes', '--over-budget'], CLAUDE, undefined, denied);
  expect(a.code, a.out).toBe(1);
  expect(a.out).toMatch(/ add mobile-mcp --yes --over-budget\n$/);
  expect(a.out).not.toMatch(/ update mobile-mcp/);
  const root2 = installed([...OWN, 'staff-reviewer']);
  const r = await run(root2, 'remove', ['staff-reviewer', '--yes'], {}, undefined, denied);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain(' remove staff-reviewer --yes');
});

test('remove keeps a .mcp.json the person created, with their server', async () => {
  const mine = JSON.stringify({ mcpServers: { mine: { command: 'm' } } }, null, 2) + '\n';
  const root = installed([...OWN, 'mobile-mcp'], { ...REPO, [MCP]: mine });
  expect((await run(root, 'remove', ['mobile-mcp', '--yes'], {})).code).toBe(0);
  expect(readFileSync(join(root, MCP), 'utf8')).toBe(mine);
});

test('remove keeps a harness-created .mcp.json once the person added a server', async () => {
  const root = installed([...OWN, 'mobile-mcp']);
  const p = join(root, MCP);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.mcpServers.mine = { command: 'm' };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  commitAll(root);
  expect((await run(root, 'remove', ['mobile-mcp', '--yes'], {})).code).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ mcpServers: { mine: { command: 'm' } } });
});

test('remove keeps an own file the person edited, and says so', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  writeFileSync(join(root, SR), 'my edits\n');
  commitAll(root);
  const r = await run(root, 'remove', ['staff-reviewer', '--yes'], {});
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('my edits\n');
  expect(r.out).toContain('was edited since harness wrote it');
});

test('remove restores a backed-up file and drops the backup', async () => {
  const root = installed([...OWN, 'staff-reviewer'], { ...REPO, [SR]: 'mine\n' });
  const backup = readManifest(root)!.files.find((f) => f.rel === SR)!.backup!;
  expect(existsSync(join(root, backup))).toBe(true);
  expect((await run(root, 'remove', ['staff-reviewer', '--yes'], {})).code).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('mine\n');
  expect(existsSync(join(root, backup))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.rel === SR)).toBe(false);
});

test('remove ends with the git commit line, and an unrelated refresh is noted', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), 'old\n'); // stands in for a stale dispatcher: the manifest recorded these bytes
  const mp = join(root, '.harness/manifest.json');
  const mj = JSON.parse(readFileSync(mp, 'utf8'));
  mj.files.find((f: any) => f.rel === '.harness/hooks/dispatch.mjs').hash = hashText('old\n');
  writeFileSync(mp, JSON.stringify(mj, null, 2) + '\n');
  commitAll(root);
  const r = await run(root, 'remove', ['staff-reviewer', '--dry-run'], {});
  expect(r.out).toContain('Note: this also refreshes harness files: .harness/hooks/dispatch.mjs.');
  const ok = await run(root, 'remove', ['staff-reviewer', '--yes'], {});
  expect(ok.out).toMatch(/Run harness git commit on a branch to commit this change\.\n$/);
  expect(ok.out).not.toContain('Commit these files');
});

test('why and explain on a legacy install count the own items as installed', async () => {
  const root = installed();
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\nitems:[\s\S]*?\n(?=\S)/, '\nitems: []\n'));
  expect(readFileSync(p, 'utf8')).toContain('items: []');
  expect((await run(root, 'why', ['stop-gate'], {})).out).not.toContain('Not installed');
  expect((await run(root, 'explain', [], {})).out).toContain('stop-gate (');
});

test('why escapes control characters in the reason and finding title', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const cfg = join(root, '.harness/config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('Reviews every diff.', '"x \\u001b[2J \\u009b31m"'));
  writeFileSync(join(root, '.harness/picks.json'), JSON.stringify({ items: [], findings: [{ id: 'f1', severity: 'critical', title: 'T \u001b]0;pwned\u0007' }] }));
  const r = await run(root, 'why', ['staff-reviewer'], {});
  expect(r.out).toContain('x \\u001b[2J \\u009b31m');
  expect(r.out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test('add of a plugin item prints the install step', async () => {
  const root = installed();
  const r = await run(root, 'add', ['frontend-design', '--yes', '--over-budget']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Run /harness:sync --install-plugins to install the plugin.');
});

test('add of an external-skill item prints the install step too', async () => {
  const root = installed();
  const r = await run(root, 'add', ['webapp-testing', '--yes', '--over-budget']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Run /harness:sync --install-plugins');
});

test('remove and why on a preset: id print the preset lines', async () => {
  const root = installed();
  const rm = await run(root, 'remove', ['preset:khubaib-frontend', '--yes']);
  expect(rm.code).toBe(2);
  expect(rm.out).toContain('Preset files are removed by turning the preset off in /harness:update.');
  const why = await run(root, 'why', ['preset:khubaib-frontend']);
  expect(why.code).toBe(0);
  expect(why.out).toContain('Installed by the khubaib-frontend preset.');
});
