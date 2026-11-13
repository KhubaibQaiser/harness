import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { parseDocument } from 'yaml';
import { sync } from '../../src/cli/sync.js';
import { uninstall } from '../../src/cli/uninstall.js';
import type { Prompt } from '../../src/cli/prompt.js';
import type { Exec } from '../../src/core/exec.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from '../install/helpers.js';
import { decision, writeDecision } from '../core/decisions-helpers.js';

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
const run = async (root: string, args: string[], env: NodeJS.ProcessEnv = CLAUDE, exec?: Exec, version?: string) => {
  let out = '';
  const code = await sync(args, { env, root, out: (s) => (out += s + '\n'), prompt: yes, templatesDir, distDir: join(pkgDir, 'dist'), exec, version });
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
const editConfigNoCommit = (root: string) => { // an uncommitted selection change: the plan rewrites config.yaml
  const p = join(root, '.harness/config.yaml');
  const doc = parseDocument(readFileSync(p, 'utf8'));
  const items = doc.toJS().items;
  items.find((i: any) => i.id === 'tdd-gate').selected = false;
  doc.set('items', items);
  writeFileSync(p, doc.toString());
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

const pinsOf = (root: string): string => Object.keys(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).extraKnownMarketplaces).find((k) => k.startsWith('harness-pins'))!;
const imp = (root: string) => `impeccable@${pinsOf(root)}`;

test('missing plugins are installed with --install-plugins', async () => {
  const root = installed([...OWN, 'impeccable']);
  const calls: string[][] = [];
  const exec: Exec = (_c, a) => {
    calls.push(a);
    return a[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 0, stdout: JSON.stringify({ command: 'install', outcome: 'ok', message: '' }) };
  };
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, exec);
  expect(r.code, r.out).toBe(0);
  expect(calls).toContainEqual(['plugin', 'install', imp(root), '--scope', 'project', '--json']);
  expect(r.out).toContain(`Installed plugin ${imp(root)}`);
  // already installed: no second install
  calls.length = 0;
  const again = await run(root, ['--yes', '--install-plugins'], CLAUDE, (c, a) => (a[1] === 'list' ? { status: 0, stdout: JSON.stringify([{ id: imp(root), version: '1', enabled: true }]) } : exec(c, a)));
  expect(again.code, again.out).toBe(0);
  expect(calls.some((a) => a[1] === 'install')).toBe(false);
});

const SETTINGS = '.claude/settings.json';

test('sync moves an install on the shared harness-pins name to its own name, in settings and the manifest', async () => {
  const root = installed([...OWN, 'impeccable']);
  const own = pinsOf(root);
  for (const rel of [SETTINGS, '.harness/manifest.json']) writeFileSync(join(root, rel), readFileSync(join(root, rel), 'utf8').replaceAll(own, 'harness-pins')); // an install from before per-repo names
  commitAll(root);
  const r = await run(root, ['--yes'], CLAUDE, listing([]));
  expect(r.code, r.out).toBe(0);
  const now = pinsOf(root);
  expect(now).toMatch(/^harness-pins-[0-9a-f]{12}$/);
  const text = readFileSync(join(root, SETTINGS), 'utf8');
  expect(text).not.toMatch(/"harness-pins"|@harness-pins"/);
  expect(JSON.parse(text).enabledPlugins).toEqual({ [`impeccable@${now}`]: true });
  expect(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).not.toMatch(/"harness-pins\\"|@harness-pins\\"/);
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: yes })).toBe(0);
  expect(existsSync(join(root, SETTINGS)) ? readFileSync(join(root, SETTINGS), 'utf8') : '').not.toContain('harness-pins');
});
const listing = (ids: string[]): Exec => (_c, a) => (a[1] === 'list' ? { status: 0, stdout: JSON.stringify(ids.map((id) => ({ id, version: '1', enabled: true }))) } : { status: 1, stdout: '' });
const hash = (root: string) => readManifest(root)!.files.find((f) => f.rel === SETTINGS)!.hash;

test('a plugin installed by hand is recorded with --install-plugins', async () => {
  const root = installed([...OWN, 'impeccable']);
  const p = join(root, SETTINGS);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.enabledPlugins[imp(root)] = false; // stands in for claude's own change to the entry
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  const old = hash(root);
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, listing([imp(root)]));
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Recorded the plugin install');
  expect(hash(root)).not.toBe(old);
});

test('sync without --install-plugins never rehashes settings, and a hand-edited key survives uninstall', async () => {
  const root = installed([...OWN, 'impeccable']);
  const p = join(root, SETTINGS);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.mine = { keep: true };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  commitAll(root);
  const old = hash(root);
  const r = await run(root, ['--yes'], CLAUDE, listing([imp(root)]));
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain('Recorded');
  expect(hash(root)).toBe(old);
  let out = '';
  expect(await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s), prompt: yes })).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8')).mine).toEqual({ keep: true });
});

test('the preview lists missing plugins without --install-plugins', async () => {
  const root = installed([...OWN, 'impeccable']);
  const r = await run(root, ['--dry-run'], CLAUDE, listing([]));
  expect(r.out).toContain(`Plugins not installed: ${imp(root)}`);
});

test('a failed plugin install prints the recovery copy', async () => {
  const root = installed([...OWN, 'impeccable']);
  const exec: Exec = (_c, a) => (a[1] === 'list' ? { status: 0, stdout: '[]' } : { status: 0, stdout: JSON.stringify({ command: 'install', outcome: 'failed', message: 'boom' }) });
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, exec);
  expect(r.code).toBe(1);
  expect(r.out).toContain('Then run /harness:sync to record the install.');
});

test('an edited AGENTS.md keeps the person\'s content and is listed', async () => {
  const root = installed();
  const p = join(root, 'AGENTS.md');
  const mine = '# Mine\nmy own rules\n';
  writeFileSync(p, readFileSync(p, 'utf8').replace('# Mine\n', mine));
  commitAll(root);
  const text = readFileSync(p, 'utf8');
  writeFileSync(p, text.slice(0, text.indexOf('<!--')) ); // the harness block is gone: sync restores only that part
  commitAll(root);
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('sync changes only the harness parts: `AGENTS.md`');
  expect(readFileSync(p, 'utf8').startsWith(mine)).toBe(true);
  expect((await run(root, ['--yes', '--take', 'AGENTS.md'])).code).toBe(2); // a merged file has nothing to take
});

test('an edited file of an unselected item is kept', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  writeFileSync(join(root, SR), 'mine\n');
  editConfig(root, (items) => { items.find((i) => i.id === 'staff-reviewer').selected = false; });
  const r = await run(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('mine\n');
});

test('a hand install plus another edit is not recorded, and the person\'s key survives uninstall', async () => {
  const root = installed([...OWN, 'impeccable']);
  const p = join(root, SETTINGS);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.enabledPlugins[imp(root)] = false;
  j.mine = { keep: true };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  commitAll(root);
  const old = hash(root);
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, listing([imp(root)]));
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('settings.json has other edits; not recorded. Run /harness:update to review them.');
  expect(hash(root)).toBe(old);
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: yes })).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8')).mine).toEqual({ keep: true });
});

/** Stands in for `claude plugin install`: reports it missing, then rewrites settings.json the way claude does (the entry flips), plus `extra`. */
const installer = (root: string, extra: object = {}): Exec => (_c, a) => {
  if (a[1] === 'list') return { status: 0, stdout: '[]' };
  const p = join(root, SETTINGS);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.enabledPlugins[imp(root)] = false;
  writeFileSync(p, JSON.stringify({ ...j, ...extra }, null, 2) + '\n');
  return { status: 0, stdout: JSON.stringify({ command: 'install', outcome: 'ok', message: '' }) };
};

test('sync --install-plugins after a committed hand edit does not record it, and the key survives uninstall', async () => {
  const root = installed([...OWN, 'impeccable']);
  const p = join(root, SETTINGS);
  const j = JSON.parse(readFileSync(p, 'utf8'));
  j.mine = { keep: true };
  writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  commitAll(root);
  const old = hash(root);
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, installer(root));
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('settings.json has other edits; not recorded. Run /harness:update to review them.');
  expect(hash(root)).toBe(old);
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: yes })).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8')).mine).toEqual({ keep: true });
});

test('a clean sync --install-plugins is recorded, and uninstall leaves the repo as it was', async () => {
  const root = installed([...OWN, 'impeccable']);
  const r = await run(root, ['--yes', '--install-plugins'], CLAUDE, installer(root));
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain('not recorded');
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: yes })).toBe(0);
  const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  expect(execFileSync('git', ['diff', first], { cwd: root, encoding: 'utf8' })).toBe('');
  expect(execFileSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: root, encoding: 'utf8' })).toBe('');
});

test('sync refuses when the package version differs from the manifest', async () => {
  const r = await run(installed(), ['--dry-run'], CLAUDE, undefined, '9.9.9');
  expect(r.code).toBe(1);
  expect(r.out).toContain('Run /harness:update first');
});

test('the preview reports uncommitted files and still exits 0', async () => {
  const root = installed([...OWN, 'staff-reviewer']);
  rmSync(join(root, SR));
  commitAll(root);
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '# note\n');
  editConfigNoCommit(root);
  const r = await run(root, ['--dry-run']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('Commit or stash these files first');
});

// Team decisions (spec §4.3): M3's sync also runs the decision sync, on an injected clock.
const DEC = '2026-11-03-use-zod';
const RULE = `.claude/rules/harness-decision-${DEC}.md`;
const DAY = '2026-11-03';
const at = (day: string) => () => new Date(`${day}T12:00:00Z`);
const runAt = async (root: string, args: string[], day = DAY) => {
  let out = '';
  const code = await sync(args, { env: CLAUDE, root, out: (s) => (out += s + '\n'), prompt: yes, templatesDir, distDir: join(pkgDir, 'dist'), now: at(day) });
  return { code, out };
};
const withDecision = () => {
  const root = installed();
  writeDecision(root, decision(DEC, { verified_on: DAY }));
  commitAll(root);
  return root;
};

test('sync writes an out-of-sync decision rule and records it in the manifest', async () => {
  const root = withDecision();
  const r = await runAt(root, ['--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`Wrote ${RULE}`);
  expect(existsSync(join(root, RULE))).toBe(true);
  expect(readManifest(root)!.files.some((f) => f.rel === RULE)).toBe(true);
  expect((await runAt(root, ['--yes'])).out).toContain('Nothing to sync.');
});

test('sync removes the rule of a decision past decisions.expiry_days, and its manifest entry', async () => {
  const root = withDecision();
  expect((await runAt(root, ['--yes'])).code).toBe(0);
  commitAll(root);
  const r = await runAt(root, ['--yes'], '2027-02-02'); // 91 days after verified_on; the default expiry is 90
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`Removed ${RULE}`);
  expect(existsSync(join(root, RULE))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.rel === RULE)).toBe(false);
  expect(existsSync(join(root, `docs/decisions/${DEC}.md`))).toBe(true);
});

test('sync --dry-run lists the decision rule and writes nothing', async () => {
  const root = withDecision();
  const before = tree(root);
  const r = await runAt(root, ['--dry-run']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain(`create ${RULE}`);
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(tree(root)).toEqual(before);
});

test("a foreign decision rule stops sync with the §4.3 line", async () => {
  const root = withDecision();
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  writeFileSync(join(root, RULE), 'mine\n');
  commitAll(root);
  const before = tree(root);
  const r = await runAt(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`harness remember: ${RULE} is not harness's; rename it`);
  expect(tree(root)).toEqual(before);
});

test('final review M1: a decision rule that would hold a secret stops sync, nothing written', async () => {
  const root = installed();
  writeDecision(root, decision(DEC, { verified_on: DAY, body: `**Rule:** Use ghp_${'a1'.repeat(18)}.\n` }));
  commitAll(root);
  const before = tree(root);
  const r = await runAt(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`harness remember: ${RULE} would hold a secret (GitHub token).`);
  expect(tree(root)).toEqual(before);
});
