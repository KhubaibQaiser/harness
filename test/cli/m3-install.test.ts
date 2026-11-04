import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { items } from '../../src/cli/items.js';
import { sync } from '../../src/cli/sync.js';
import { uninstall } from '../../src/cli/uninstall.js';
import type { Prompt } from '../../src/cli/prompt.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { pruneStale } from '../../src/install/finish.js';
import { approvedIds } from '../../src/install/approved.js';
import { backupText } from '../../src/install/manifest.js';
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
const commitAll = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
};
const installed = (ids: string[] = OWN, files: Record<string, string> = REPO) => {
  const root = makeRepo(files);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: '{"catalog_version":1,"findings":[],"items":[]}', report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai }).changes, '1.0.0');
  commitAll(root);
  return root;
};
const say = (yes: boolean, during?: () => void): Prompt => ({ async confirm() { during?.(); return yes; }, async edit(_l, v) { return v; } });
const CLAUDE = { CLAUDECODE: '1' };
const add = async (root: string, cmd: 'add' | 'remove', args: string[], prompt = say(false)) => {
  let out = '';
  const code = await items(cmd, args, { env: CLAUDE, root, out: (s) => (out += s + '\n'), prompt, templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null });
  return { code, out };
};
const syn = async (root: string, args: string[], prompt = say(true)) => {
  let out = '';
  const code = await sync(args, { env: CLAUDE, root, out: (s) => (out += s + '\n'), prompt, templatesDir, distDir: join(pkgDir, 'dist') });
  return { code, out };
};
const un = async (root: string, args: string[]) => {
  let out = '';
  const code = await uninstall(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: say(true) });
  return { code, out };
};
const SR = '.claude/agents/staff-reviewer.md';
const CONFIG = '.harness/config.yaml';
const editItems = (root: string, f: (items: any[]) => void) => {
  const p = join(root, CONFIG);
  const doc = parseDocument(readFileSync(p, 'utf8'));
  const list = doc.toJS().items;
  f(list);
  doc.set('items', list);
  writeFileSync(p, doc.toString());
  commitAll(root);
};

// I1
test('add keeps another item\'s committed hand edit, lists it, and --take replaces it', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const mine = readFileSync(join(root, SR), 'utf8') + 'MY OWN RULE\n';
  writeFileSync(join(root, SR), mine);
  commitAll(root);
  const r = await add(root, 'add', ['mobile-mcp', '--yes', '--over-budget']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe(mine);
  expect(r.out).toContain(`Kept \`${SR}\``);
  commitAll(root);
  expect((await add(root, 'add', ['impeccable', '--take', 'AGENTS.md', '--yes', '--over-budget'])).code).toBe(2); // not an edited harness-owned file
  const t = await add(root, 'add', ['impeccable', '--take', SR, '--yes', '--over-budget']);
  expect(t.code, t.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).not.toContain('MY OWN RULE');
});

test('remove keeps another item\'s committed hand edit too', async () => {
  const root = installed([...OWN, 'staff-reviewer', 'mobile-mcp']);
  const mine = readFileSync(join(root, SR), 'utf8') + 'MY OWN RULE\n';
  writeFileSync(join(root, SR), mine);
  commitAll(root);
  const r = await add(root, 'remove', ['mobile-mcp', '--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe(mine);
});

// I2
test('a manifest changed while the command waited stops the apply and writes nothing', async () => {
  const root = installed([...OWN, 'review-rubric'].filter((x, i, a) => a.indexOf(x) === i));
  rmSync(join(root, '.claude/skills/review-rubric/SKILL.md'));
  commitAll(root);
  const p = join(root, '.harness/manifest.json');
  let other = '';
  const r = await syn(root, [], say(true, () => { other = readFileSync(p, 'utf8').replace('"version"', '"note": "other session",\n  "version"'); writeFileSync(p, other); }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('Another harness command changed the install while this one ran. Run it again.');
  expect(readFileSync(p, 'utf8')).toBe(other);
  expect(existsSync(join(root, '.claude/skills/review-rubric/SKILL.md'))).toBe(false);
});

// I3
test('approvedIds: installed through harness only, agents-md and check-only items by their record', () => {
  const root = installed([...OWN, 'staff-reviewer']);
  const m = readManifest(root)!;
  const cat = loadCatalog().catalog;
  const config = { ...preset(detect(root)).config, items: [...OWN, 'staff-reviewer', 'mobile-mcp'].map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' })) };
  const got = approvedIds(config, m, cat);
  expect(got).toEqual(expect.arrayContaining([...OWN, 'staff-reviewer']));
  expect(got).not.toContain('mobile-mcp');
});

test('add and sync give the same budget verdict for a hand-selected, never-installed item', async () => {
  const root = installed();
  editItems(root, (list) => list.push({ id: 'mobile-mcp', include: 'optional', selected: true, reason: 'by hand', addresses: [], pin: '' }));
  const s = await syn(root, ['--yes']);
  const a = await add(root, 'add', ['staff-reviewer', '--yes']);
  expect(s.code, s.out).toBe(2);
  expect(a.code, a.out).toBe(2);
  expect(a.out).toContain('Not measured before install: mobile-mcp');
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
});

test('add and sync count the same tokens for the same repo state', async () => {
  const root = installed();
  rmSync(join(root, '.claude/skills/review-rubric/SKILL.md'));
  commitAll(root);
  const line = (o: string) => o.split('\n').filter((l) => /Approved earlier|context/i.test(l));
  const s = await syn(root, ['--dry-run']);
  const a = await add(root, 'add', ['staff-reviewer', '--dry-run']);
  expect(s.out).toMatch(/Approved earlier, not counted: .*agents-md/);
  expect(a.out).toMatch(/Approved earlier, not counted: .*agents-md/);
  expect(line(s.out).find((l) => l.startsWith('Approved'))).toBe(line(a.out).find((l) => l.startsWith('Approved')));
});

// M1
test('add keeps a comment under items:', async () => {
  const root = installed();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/^items:\n/m, 'items:\n  # my item note\n'));
  commitAll(root);
  expect(readFileSync(p, 'utf8')).toContain('# my item note');
  const r = await add(root, 'add', ['staff-reviewer', '--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(p, 'utf8')).toContain('# my item note');
  expect(readFileSync(p, 'utf8')).toContain('staff-reviewer');
});

// M2
test('uninstall --force never deletes a CLAUDE.md that holds only the person\'s text', async () => {
  const root = installed();
  expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  writeFileSync(join(root, 'CLAUDE.md'), readFileSync(join(root, 'CLAUDE.md'), 'utf8') + 'My own notes\n');
  commitAll(root);
  const r = await add(root, 'remove', ['agents-md', '--yes']);
  expect(r.code, r.out).toBe(0);
  commitAll(root);
  expect((await un(root, ['--yes', '--force'])).code).toBe(0);
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('My own notes');
});

// M3
test('sync deletes a harness-created .mcp.json that ends up empty', async () => {
  const root = installed([...OWN, 'mobile-mcp']);
  editItems(root, (list) => { list.find((i) => i.id === 'mobile-mcp').selected = false; });
  const r = await syn(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(existsSync(join(root, '.mcp.json'))).toBe(false);
});

// M4
test('a backup path outside .harness/backup is never read', () => {
  const root = makeRepo({ 'a.txt': 'x\n', '.harness/backup/t/a.txt': 'ok\n' });
  writeFileSync(join(root, '..', 'harness-secret-m4.txt'), 'secret');
  expect(backupText(root, '../harness-secret-m4.txt')).toBeNull();
  expect(backupText(root, '.harness/backup/../../a.txt')).toBeNull();
  expect(backupText(root, '.harness/backup/t/a.txt')).toBe('ok\n');
  rmSync(join(root, '..', 'harness-secret-m4.txt'));
});

// M5
test('a CRLF config.yaml stays CRLF after add', async () => {
  const root = installed();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  commitAll(root);
  const r = await add(root, 'add', ['staff-reviewer', '--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(p, 'utf8').replace(/\r\n/g, '')).not.toContain('\n');
});

// M6: stale blocks. A block the person already removed by hand is forgotten by the manifest when its item goes.
test('remove forgets the settings blocks of an item whose entries the person already deleted', async () => {
  const root = installed([...OWN, 'impeccable']);
  const sp = join(root, '.claude/settings.json');
  const j = JSON.parse(readFileSync(sp, 'utf8'));
  delete j.enabledPlugins;
  delete j.extraKnownMarketplaces;
  writeFileSync(sp, JSON.stringify(j, null, 2) + '\n');
  commitAll(root);
  const owns = () => (readManifest(root)!.files.find((f) => f.rel === '.claude/settings.json')?.blocks ?? []).filter((b) => b.includes('impeccable'));
  expect(owns().length).toBeGreaterThan(0);
  expect((await add(root, 'remove', ['impeccable', '--yes'])).code).toBe(0);
  expect(owns()).toEqual([]);
});

test('pruneStale drops the dropped blocks of a file with no change and counts them', () => {
  const m = { version: '1', createdAt: '', files: [{ rel: '.mcp.json', kind: 'update' as const, hash: 'h', blocks: ['a', 'b'] }, { rel: '.claude/settings.json', kind: 'update' as const, hash: 'h', blocks: ['c'] }] };
  expect(pruneStale(m, [], ['a', 'c'])).toBe(2);
  expect(m.files[0].blocks).toEqual(['b']);
  expect(m.files[1].blocks).toBeUndefined();
  expect(pruneStale(m, [{ kind: 'delete', rel: '.mcp.json', before: '' }], ['b'])).toBe(0); // a file with a change is left to the merge
});
