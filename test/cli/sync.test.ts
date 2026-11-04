import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { sync } from '../../src/cli/sync.js';
import type { Prompt } from '../../src/cli/prompt.js';
import type { Exec } from '../../src/core/exec.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
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
const PICKS = JSON.stringify({ catalog_version: 1, findings: [], items: [] });
const commitAll = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
};
const installed = (ids: string[] = OWN) => {
  const root = makeRepo(REPO);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: PICKS, report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai }).changes, '1.0.0');
  commitAll(root);
  return root;
};
const yes: Prompt = { async confirm() { return true; }, async edit(_l, v) { return v; } };
const CLAUDE = { CLAUDECODE: '1' };
const run = async (root: string, args: string[], env: NodeJS.ProcessEnv = CLAUDE, exec?: Exec) => {
  let out = '';
  const code = await sync(args, { env, root, out: (s) => (out += s + '\n'), prompt: yes, templatesDir, distDir: join(pkgDir, 'dist'), exec });
  return { code, out };
};
const tree = (root: string, dir = ''): Record<string, string> => Object.fromEntries(readdirSync(join(root, dir)).filter((n) => n !== '.git').flatMap((n) => {
  const rel = dir ? `${dir}/${n}` : n;
  return statSync(join(root, rel)).isDirectory() ? Object.entries(tree(root, rel)) : [[rel, readFileSync(join(root, rel), 'utf8')]];
}));
const editConfig = (root: string, f: (items: any[]) => void) => {
  const p = join(root, '.harness/config.yaml');
  const doc = parseDocument(readFileSync(p, 'utf8'));
  const items = doc.toJS().items;
  f(items);
  doc.set('items', items);
  writeFileSync(p, doc.toString());
  commitAll(root);
};
const SR = '.claude/agents/staff-reviewer.md';

test('deleted managed file is restored', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  rmSync(join(root, SR));
  commitAll(root);
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(existsSync(join(root, SR))).toBe(true);
  expect(r.out).toContain('Run harness git commit on a branch to commit this change.');
});

test("unselected item's files are removed", async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  editConfig(root, (items) => { items.find((i) => i.id === 'staff-reviewer').selected = false; });
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(existsSync(join(root, SR))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.item === 'staff-reviewer')).toBe(false);
});

test("an unselected item's manifest entry is dropped when its file is already gone", async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  editConfig(root, (items) => { items.find((i) => i.id === 'staff-reviewer').selected = false; });
  rmSync(join(root, SR));
  commitAll(root);
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readManifest(root)!.files.some((f) => f.item === 'staff-reviewer')).toBe(false);
});

test('edited file is kept and listed', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  writeFileSync(join(root, SR), 'mine\n');
  commitAll(root);
  const r = await run(root, ['--yes']);
  expect(r.out).toContain(`Kept \`${SR}\``);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('mine\n');
});

test('--take replaces it', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  writeFileSync(join(root, SR), 'mine\n');
  commitAll(root);
  const r = await run(root, ['--yes', '--take', SR]);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).not.toBe('mine\n');
  const bad = await run(root, ['--yes', '--take', 'nope.md']);
  expect(bad.code).toBe(2);
});

test('in-sync repo reports nothing to do', async () => {
  const root = installed();
  const before = tree(root);
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Nothing to sync.');
  expect(tree(root)).toEqual(before);
});

test('sync --dry-run writes nothing', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  rmSync(join(root, SR));
  commitAll(root);
  const before = tree(root);
  const r = await run(root, ['--dry-run']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(tree(root)).toEqual(before);
});

test('sync refuses outside Claude Code', async () => {
  const r = await run(installed(), ['--yes'], {});
  expect(r.code).toBe(2);
  expect(r.out).toContain('Run /harness:sync inside Claude Code.');
});

test('a hand-added item that grows context past the budget asks', async () => {
  const root = installed();
  editConfig(root, (items) => { items.push({ id: 'mobile-mcp', include: 'optional', selected: true, reason: 'r', addresses: [], pin: '' }); });
  const r = await run(root, ['--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('--over-budget');
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
  expect((await run(root, ['--yes', '--over-budget'])).code).toBe(0);
  expect(existsSync(join(root, '.mcp.json'))).toBe(true);
});

test('missing plugins are installed with --install-plugins', async () => {
  const root = installed([...OWN, 'impeccable']);
  const calls: string[][] = [];
  const exec: Exec = (_c, a) => {
    calls.push(a);
    return a[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 0, stdout: JSON.stringify({ command: 'install', outcome: 'ok', message: '' }) };
  };
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, exec);
  expect(r.code, r.out).toBe(0);
  expect(calls).toContainEqual(['plugin', 'install', 'impeccable@harness-pins', '--scope', 'project', '--json']);
  expect(r.out).toContain('Installed plugin impeccable@harness-pins');
  // already installed: no second install
  calls.length = 0;
  const again = await run(root, ['--yes', '--install-plugins'], CLAUDE, (c, a) => (a[1] === 'list' ? { status: 0, stdout: JSON.stringify([{ id: 'impeccable@harness-pins', version: '1', enabled: true }]) } : exec(c, a)));
  expect(again.code, again.out).toBe(0);
  expect(calls.some((a) => a[1] === 'install')).toBe(false);
});

test('a plugin installed by hand is recorded by sync', async () => {
  const root = installed([...OWN, 'impeccable']);
  const p = join(root, '.claude/settings.json');
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\n$/, '') + '\n\n'); // stands in for claude rewriting the file
  const hash = () => readManifest(root)!.files.find((f) => f.rel === '.claude/settings.json')!.hash;
  const old = hash();
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(hash()).not.toBe(old);
});
