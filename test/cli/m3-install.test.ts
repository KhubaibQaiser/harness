import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { budgetGate } from '../../src/cli/install-selection.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { items } from '../../src/cli/items.js';
import { doctor } from '../../src/cli/doctor.js';
import { status } from '../../src/cli/status.js';
import { itemContext } from '../../src/budget/measure.js';
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
  expect(s.out).toMatch(/Approved earlier: .*agents-md/);
  expect(a.out).toMatch(/Approved earlier: .*agents-md/);
  expect(line(s.out).find((l) => l.startsWith('Approved'))).toBe(line(a.out).find((l) => l.startsWith('Approved')));
});

// Final review I2: approved items count in both before and after, so the ask sees the real total and still never re-asks them.
test('installed items push the repo near the budget: a small add asks, and its total is status plus the item', async () => {
  const root = installed();
  const st = async () => { let out = ''; await status([], { env: CLAUDE, root, out: (s) => (out += s + '\n') }); return Number(/Context: ~([\d,]+) of/.exec(out)![1].replace(/,/g, '')); };
  const total = await st();
  const p = join(root, CONFIG);
  const doc = parseDocument(readFileSync(p, 'utf8'));
  doc.setIn(['context', 'budget_tokens'], total + 5); // the item adds more than 5
  writeFileSync(p, doc.toString());
  commitAll(root);
  const a = await add(root, 'add', ['staff-reviewer', '--yes']);
  expect(a.code, a.out).toBe(2);
  expect(a.out).toContain('Over budget: confirm before installing.');
  expect(a.out).toMatch(/Approved earlier: .*agents-md\./);
  const sr = itemContext(loadCatalog().catalog.items.find((i) => i.id === 'staff-reviewer')!, { templates: templatesDir }).tokens!;
  expect(Number(/Always-loaded context: ~([\d,]+) tokens/.exec(a.out)![1].replace(/,/g, ''))).toBe((await st()) + sr);
});

// Re-review N1: adding agents-md makes CLAUDE.md import AGENTS.md, so the repo's own AGENTS.md text starts loading.
test('add agents-md asks when the AGENTS.md text its new import makes load takes the total past the budget', async () => {
  const root = installed(OWN.filter((id) => id !== 'agents-md'), { ...REPO, 'CLAUDE.md': '# Team\n', 'AGENTS.md': '# Mine\n' + 'x'.repeat(8000) + '\n' });
  const a = await add(root, 'add', ['agents-md', '--yes']);
  expect(a.code, a.out).toBe(2);
  expect(a.out).toContain('Over budget: confirm before installing.');
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Team\n');
});

// Fix round 3: a CLAUDE.md that already imports AGENTS.md by hand gets no new line, so the ask counts no second one.
test('add agents-md with a hand-written @AGENTS.md line: the ask total equals status afterwards', async () => {
  const root = installed(OWN.filter((id) => id !== 'agents-md'), { ...REPO, 'CLAUDE.md': '# Team\n@AGENTS.md\n' });
  const d = await add(root, 'add', ['agents-md', '--dry-run']);
  const preview = Number(/Always-loaded context: ~([\d,]+) tokens/.exec(d.out)![1].replace(/,/g, ''));
  expect((await add(root, 'add', ['agents-md', '--yes'])).code).toBe(0);
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Team\n@AGENTS.md\n');
  let out = '';
  await status([], { env: CLAUDE, root, out: (s) => (out += s + '\n') });
  expect(preview, d.out + out).toBe(Number(/Context: ~([\d,]+) of/.exec(out)![1].replace(/,/g, '')));
});

// Fix round 4: the gate never overlays a planned AGENTS.md that is a link, so its planned text is not counted as the file's.
test.skipIf(process.platform === 'win32')('the budget gate ignores a planned change to a symlinked AGENTS.md', async () => {
  const dot = '.' + 'env';
  const root = installed(OWN.filter((id) => id !== 'agents-md'));
  writeFileSync(join(root, dot), 'API_TOKEN=fake-value-not-a-secret');
  rmSync(join(root, 'AGENTS.md'));
  symlinkSync(dot, join(root, 'AGENTS.md'));
  const lines: string[] = [];
  const stop = await budgetGate({ cat: loadCatalog().catalog, before: [], after: [], exempt: [], changes: [{ kind: 'update', rel: 'AGENTS.md', before: '', after: 'x'.repeat(40000), blocks: [] }], budget: 2000, templatesDir, root, env: {}, out: (l) => lines.push(l), f: { yes: true, dryRun: false, overBudget: false } });
  expect(stop).toBeNull();
  expect(lines.join('\n')).not.toContain('fake-value');
  expect(Number(/~([\d,]+) tokens/.exec(lines[0])![1].replace(/,/g, ''))).toBeLessThan(2000);
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

// M-a: two commands in one process
test('a second command applying in the same process still stops the first (explicit manifest text)', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  rmSync(join(root, SR));
  editItems(root, (list) => { list.find((i) => i.id === 'staff-reviewer').selected = false; }); // A's job: only forget the record
  // Session B runs to the end inside A's confirm, in this process.
  const both: Prompt = { async confirm() { await items('add', ['mobile-mcp', '--yes', '--over-budget'], { env: CLAUDE, root, out: () => {}, prompt: say(false), templatesDir, distDir: join(pkgDir, 'dist'), claudeVersion: () => null }); return true; }, async edit(_l, v) { return v; } };
  const r = await syn(root, [], both);
  expect(readManifest(root)!.files.some((f) => f.rel === '.mcp.json')).toBe(true);
  expect(r.code).toBe(1);
  expect(r.out).toContain('Another harness command changed the install while this one ran.');
});

// M-b: a legacy install has no item tags
test('approvedIds on a legacy install counts staff-reviewer and review-rubric by path', () => {
  const root = makeRepo(REPO);
  const facts = detect(root);
  const config = preset(facts).config; // no items: the legacy own items
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir }).changes, '1.0.0');
  const got = approvedIds(config, readManifest(root)!, loadCatalog().catalog);
  expect(got).toEqual(expect.arrayContaining(['staff-reviewer', 'review-rubric', 'agents-md', 'agent-guard']));
});

// M-c: the lock
test('a locked repo: dry run, doctor and status all say so', async () => {
  const root = installed();
  writeFileSync(join(root, '.harness/apply.lock'), 'x\n');
  const d = await add(root, 'add', ['staff-reviewer', '--dry-run']);
  expect(d.code).toBe(1);
  expect(d.out.split('\n')[0]).toContain('To recover');
  let out = '';
  expect(doctor([], { root, env: {}, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => null })).toBe(1);
  expect(out).toContain('fix .harness/apply.lock exists: ');
  out = '';
  status([], { root, env: {}, out: (s) => (out += s + '\n') });
  expect(out).toContain('Lock: .harness/apply.lock exists.');
});
