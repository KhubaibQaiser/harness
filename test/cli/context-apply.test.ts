import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import { changedFiles, readRepoSnapshot, snapshotHarnessFiles } from '../../src/core/harness-files.js';
import { contextApply } from '../../src/cli/context-apply.js';
import { context } from '../../src/cli/context.js';
import { init } from '../../src/cli/init.js';
import { items } from '../../src/cli/items.js';
import { NO_TTY, type Prompt } from '../../src/cli/prompt.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { update } from '../../src/cli/update.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from '../install/helpers.js';

vi.mock('../../src/cli/items.js', async (orig) => {
  const m = await orig<typeof import('../../src/cli/items.js')>();
  return { ...m, items: vi.fn(m.items) };
});

const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('no network in tests'); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const fixture = join(pkgDir, 'test', 'fixtures', 'presets');
const SETTINGS = '.claude/settings.json';
const SET_PARENT = '{"set":["skillOverrides"],"value":{}}';
const SET_PR_SHIP = '{"set":["skillOverrides","pr-ship"],"value":"name-only"}';

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
const pkg = JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { react: '^18.0.0', next: '^14.0.0' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n';
// A long AGENTS.md of the person's own puts the repo over the budget, so name-only is recommended, and it is a user-file finding too.
const AGENTS = `# Mine\n${'x'.repeat(9000)}\n`;
const FILES = {
  'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'AGENTS.md': AGENTS,
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
};
const SECTIONS = '## Findings\n\n## Roadmap\n30 days: a. 60 days: b. 90 days: c.\n\n## Deliberate exclusions\nnone\n\n## Limits\nx\n';
const PRODUCT = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx\n`).join('\n');
const ANSWERS = {
  scope: { paths: ['src'] }, preset: null,
  project: { type: 'web', domain: 'tools', compliance: [], data_handling: '', team_size: 1, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [] },
  apps: [], unattended: { multi_file_gate: 'block', require_reason: false }, tdd: { paths: ['src/**'], diff_coverage: 80 },
};
const OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'review-rubric', 'staff-reviewer', 'pr-ship', 'agents-md'];
const WITH_PRESET = [...OWN, 'core-rules', 'engineering-principles', 'frontend-react', 'frontend-nextjs'];
const dir = mkdtempSync(join(tmpdir(), 'harness-ca-'));
let k = 0;
const aiArgs = (ids: string[], answers: object): string[] => {
  const d = join(dir, `r${k++}`);
  mkdirSync(d);
  const f = (name: string, text: string) => (writeFileSync(join(d, name), text), join(d, name));
  const picks = { catalog_version: 1, findings: [], items: OWN.map((id) => ({ id, include: 'recommended', reason: 'r', addresses: [] })) };
  return ['--answers', f('answers.json', JSON.stringify(answers)), '--product', f('product.md', PRODUCT), '--picks', f('picks.json', JSON.stringify(picks)), '--report', f('report.md', SECTIONS), '--choose', ids.join(','), '--yes', '--over-budget'];
};
const yes: Prompt = { async confirm() { return true; }, async edit(_l, v) { return v; } };
const no: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const env = { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' };
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const commit = (root: string, msg: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg); };
const hashes = (root: string) => (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[]).map((f) => f.replace(/\\/g, '/')).filter((f) => !f.startsWith('.git/') && f !== '.git').sort().map((f) => statSync(join(root, f)).isFile() ? f + createHash('sha256').update(readFileSync(join(root, f))).digest('hex') : `${f}/`);
const repo = () => makeRepo({ ...FILES, ...presetFiles() });
const initAt = async (root: string, ids = OWN, answers: object = ANSWERS) => {
  let out = '';
  const code = await init(aiArgs(ids, answers), { ...base, version: '1.2.3', root, env, claudeVersion: () => null, out: (s) => (out += s + '\n'), prompt: no });
  expect(code, out).toBe(0);
  commit(root, 'harness');
  return root;
};
const up = async (root: string, args: string[]) => {
  let out = '';
  const code = await update(args, { ...base, version: '1.2.3', root, env, claudeVersion: () => null, out: (s) => (out += s + '\n'), prompt: no });
  return { code, out };
};
const apply = async (root: string, args: string[], o: { prompt?: Prompt; tty?: boolean; catalog?: ReturnType<typeof loadCatalog>['catalog'] } = {}) => {
  const lines: string[] = [];
  const asked: string[] = [];
  const p = o.prompt ?? yes;
  const prompt: Prompt = { confirm: (q) => (asked.push(q), p.confirm(q)), edit: p.edit };
  const code = await contextApply(args, { ...base, env: {}, root, out: (l) => lines.push(l), prompt, tty: o.tty, claudeVersion: () => null, catalog: o.catalog });
  return { code, out: lines.join('\n'), asked };
};
type Rec = { n: number; kind: string; target: string; apply: boolean };
const recs = async (root: string): Promise<Rec[]> => {
  const lines: string[] = [];
  await context(['--json', '--offline'], { root, env: {}, out: (l) => lines.push(l) });
  return JSON.parse(lines.join('\n')).recommendations;
};
const numberOf = async (root: string, kind: string, target: string): Promise<number> => {
  const r = (await recs(root)).find((x) => x.kind === kind && x.target === target);
  expect(r, `${kind} ${target}`).toBeDefined();
  return r!.n;
};
const settings = (root: string) => JSON.parse(readFileSync(join(root, SETTINGS), 'utf8'));
const blocks = (root: string) => readManifest(root)!.files.find((f) => f.rel === SETTINGS)?.blocks ?? [];

test('the report recommends name-only for pr-ship and never for review-rubric, which staff-reviewer preloads', async () => {
  const root = await initAt(repo());
  const r = await recs(root);
  expect(r.some((x) => x.kind === 'name-only' && x.target === 'pr-ship')).toBe(true);
  expect(r.some((x) => x.target === 'review-rubric')).toBe(false);
  const lines: string[] = [];
  await context(['--offline'], { root, env: {}, out: (l) => lines.push(l) });
  const n = r.find((x) => x.target === 'pr-ship')!.n;
  expect(lines).toContain(`  ${n}. harness  Show skill pr-ship by name only (saves ~${lines.join('\n').match(/pr-ship by name only \(saves ~(\d+)\)/)![1]}). Apply: harness context apply ${n}`);
});

test('apply name-only writes the key and records the set block and its parent in the manifest', async () => {
  const root = await initAt(repo());
  const n = await numberOf(root, 'name-only', 'pr-ship');
  const r = await apply(root, [String(n), '--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.asked).toEqual([]);
  expect(settings(root).skillOverrides).toEqual({ 'pr-ship': 'name-only' });
  expect(blocks(root)).toEqual(expect.arrayContaining([SET_PARENT, SET_PR_SHIP]));
  expect((await recs(root)).some((x) => x.target === 'pr-ship')).toBe(false);
  // Recorded as the CLI's own write, so the ConfigChange check and change detection allow it.
  expect(changedFiles(readRepoSnapshot(root).lastSeen!.files, snapshotHarnessFiles(root))).toEqual([]);
  expect(readRepoSnapshot(root).cli?.settings?.[SETTINGS]).toBeTruthy();
});

test('a key the person already set is left alone, with the note', async () => {
  const root = await initAt(repo());
  const s = settings(root);
  s.skillOverrides = { 'pr-ship': 'on' };
  writeFileSync(join(root, SETTINGS), JSON.stringify(s, null, 2) + '\n');
  commit(root, 'mine');
  const before = readFileSync(join(root, SETTINGS), 'utf8');
  const n = await numberOf(root, 'name-only', 'pr-ship');
  const r = await apply(root, [String(n), '--yes']);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('`.claude/settings.json`: `skillOverrides.pr-ship` is already "on"; left as is (harness would set "name-only").');
  expect(r.out).toContain('Nothing to change.');
  expect(readFileSync(join(root, SETTINGS), 'utf8')).toBe(before);
});

test('apply remove runs harness remove with the same flags', async () => {
  const cat = structuredClone(loadCatalog().catalog);
  cat.items.find((i) => i.id === 'agent-sdk-dev')!.cost.context_tokens = 3000;
  const root = makeRepo(FILES);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = [...OWN, 'agent-sdk-dev'].map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  applyChanges(root, planChanges(root, config, facts, { version: '1.0.0', ...base, catalog: cat, ai: { picks: JSON.stringify({ catalog_version: 1, findings: [], items: [] }), report: '# R\n\n## Limits\n\nx\n', product: '# P\n' } }).changes, '1.0.0');
  commit(root, 'harness');
  const r0 = await apply(root, ['1', '--dry-run'], { catalog: cat });
  expect(r0.code, r0.out).toBe(0);
  expect(items).toHaveBeenCalledWith('remove', ['agent-sdk-dev', '--dry-run'], expect.objectContaining({ root }));
  await apply(root, ['1', '--yes'], { catalog: cat });
  expect(items).toHaveBeenLastCalledWith('remove', ['agent-sdk-dev', '--yes'], expect.objectContaining({ root }));
});

test('a recommendation on your own file refuses with exit 2', async () => {
  const root = await initAt(repo());
  const n = await numberOf(root, 'move-to-skill', 'AGENTS.md');
  const r = await apply(root, [String(n), '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toBe(`Recommendation ${n} changes your own file; the context-optimize skill shows you the diff first.`);
});

test('bad arguments and an unknown number exit 2', async () => {
  const root = await initAt(repo());
  for (const a of [[], ['x'], ['1', '2'], ['1', '--yes', '--yes'], ['1', '--force']]) expect((await apply(root, a)).code, a.join(' ')).toBe(2);
  const r = await apply(root, ['99', '--yes']);
  expect(r.code).toBe(2);
  expect(r.out).toContain('No recommendation 99.');
});

test('--dry-run prints the diff and writes nothing; the prompt asks, and no TTY prints NO_TTY', async () => {
  const root = await initAt(repo());
  const n = String(await numberOf(root, 'name-only', 'pr-ship'));
  const status = git(root, 'status', '--porcelain');
  const dry = await apply(root, [n, '--dry-run']);
  expect(dry.code, dry.out).toBe(0);
  expect(dry.out).toMatch(/^\+.*"pr-ship": "name-only"/m);
  expect(dry.out).toContain('Dry run: nothing was written.');
  expect(git(root, 'status', '--porcelain')).toBe(status);

  const tty = await apply(root, [n], { tty: false });
  expect(tty.code).toBe(2);
  expect(tty.out).toBe(NO_TTY);

  const cancelled = await apply(root, [n], { prompt: no });
  expect(cancelled.asked).toEqual(['Apply these changes? [y/N]']);
  expect(cancelled.out).toContain('Cancelled. Nothing was written.');
  expect(git(root, 'status', '--porcelain')).toBe(status);

  const ok = await apply(root, [n], { prompt: yes });
  expect(ok.code, ok.out).toBe(0);
  expect(ok.asked).toEqual(['Apply these changes? [y/N]']);
  expect(settings(root).skillOverrides).toEqual({ 'pr-ship': 'name-only' });
});

test('init → context apply → uninstall leaves the repo byte-identical', async () => {
  const root = repo();
  const before = hashes(root);
  await initAt(root);
  const r = await apply(root, [String(await numberOf(root, 'name-only', 'pr-ship')), '--yes']);
  expect(r.code, r.out).toBe(0);
  commit(root, 'apply');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: no });
  expect(hashes(root)).toEqual(before);
});

test('after apply, update with and without a preset keeps the block, and uninstall is still byte-identical', async () => {
  const root = repo();
  const before = hashes(root);
  await initAt(root);
  expect((await apply(root, [String(await numberOf(root, 'name-only', 'pr-ship')), '--yes'])).code).toBe(0);
  commit(root, 'apply');
  const keeps = () => {
    expect(settings(root).skillOverrides).toEqual({ 'pr-ship': 'name-only' });
    expect(blocks(root)).toEqual(expect.arrayContaining([SET_PARENT, SET_PR_SHIP]));
  };
  const plain = await up(root, ['--yes']);
  expect(plain.code, plain.out).toBe(0);
  keeps();
  commit(root, 'update');
  const on = await up(root, aiArgs(WITH_PRESET, { preset: 'stacks' }));
  expect(on.code, on.out).toBe(0);
  keeps();
  commit(root, 'preset on');
  const off = await up(root, aiArgs(OWN, { preset: null }));
  expect(off.code, off.out).toBe(0);
  keeps();
  commit(root, 'preset off');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: no });
  expect(hashes(root)).toEqual(before);
});
