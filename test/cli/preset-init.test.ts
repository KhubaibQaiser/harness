import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { items } from '../../src/cli/items.js';
import { sync } from '../../src/cli/sync.js';
import { presetContext } from '../../src/catalog/presets.js';
import { status } from '../../src/cli/status.js';
import { previewLines, loadPreset } from '../../src/catalog/presets.js';
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

// ---- Task 8: preview and budget lines ----
const WEB = ['core-rules', 'engineering-principles', 'frontend-react', 'impeccable', 'superpowers'];
const dry = (ids: string[]) => aiArgs(ids).map((a) => (a === '--yes' ? '--dry-run' : a));
const count = (s: string, line: string) => s.split('\n').filter((l) => l === line).length;
const IMP = ['Impeccable installs hooks: SessionStart, PostToolUse on Edit and Write, and Stop.', 'Impeccable downloads its engine into ~/.impeccable/bin/ on first use.'];
const ATTR = 'Attribution: .claude/settings.json sets "attribution": false, so commits and PRs get no AI trailer.';
const TEL = (n: string, v: string, id: string) => `Telemetry: ${n}=${v} goes in .claude/settings.json env for ${id}; it applies to every command in the session.`;

test('the dry run lists the preview lines once each when Impeccable is selected', async () => {
  const r = await run(repo(), dry([...OWN, ...WEB]));
  expect(r.code, r.out).toBe(0);
  for (const l of [...IMP, TEL('DO_NOT_TRACK', '1', 'impeccable'), TEL('SUPERPOWERS_DISABLE_TELEMETRY', 'true', 'superpowers'), ATTR]) expect(count(r.out, l), l).toBe(1);
});

test('without Impeccable only the other telemetry line and the attribution line show', async () => {
  const r = await run(repo(), dry([...OWN, 'core-rules', 'superpowers']));
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain('Impeccable');
  expect(r.out).not.toContain('DO_NOT_TRACK');
  expect(count(r.out, TEL('SUPERPOWERS_DISABLE_TELEMETRY', 'true', 'superpowers'))).toBe(1);
  expect(count(r.out, ATTR)).toBe(1);
});

test('without a preset there are no preview lines', async () => {
  const d = join(dir, 'np');
  mkdirSync(d);
  const args = dry(OWN).map((a, i, all) => (all[i - 1] === '--answers' ? (writeFileSync(join(d, 'a.json'), JSON.stringify({ ...ANSWERS, preset: undefined })), join(d, 'a.json')) : a));
  const r = await run(repo(), args);
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toMatch(/Telemetry:|Attribution:|Impeccable/);
});

test('previewLines drops telemetry_off ids that are not selected', () => {
  const lp = loadPreset(join(fixture, 'stacks.yaml'));
  if (!lp.ok) throw new Error(lp.errors.join());
  expect(previewLines(lp.loaded, [])).toEqual([ATTR]);
});

test('the init budget total includes the preset core and skills, and status prints the same one', async () => {
  const root = repo();
  const d = await run(root, dry([...OWN, ...WEB]));
  const line = /Always-loaded context from harness: ~(\d+) tokens/.exec(d.out)!;
  expect(line, d.out).toBeTruthy();
  expect(d.out).toContain('Not measured before install:');
  expect(d.out).toMatch(/Not measured before install: .*impeccable/);
  const bare = await run(repo(), dry([...OWN]));
  expect(Number(line[1]) - Number(/~(\d+) tokens/.exec(bare.out)![1])).toBe(presetSum(['core-rules', 'engineering-principles', 'frontend-react']));
  expect((await run(root, [...aiArgs([...OWN, ...WEB]), '--over-budget'])).code).toBe(0);
  let out = '';
  status([], { root, env: {}, out: (s) => (out += s + '\n') });
  expect(statusTotal(out)).toBe(Number(line[1]));
});

// ---- update, add, explain and sync count the preset like init and status ----
const loaded = () => { const l = loadPreset(join(fixture, 'stacks.yaml')); if (!l.ok) throw new Error('fixture'); return l.loaded; };
const presetSum = (ids: string[]) => presetContext(loaded(), ids).reduce((n, e) => n + (e.tokens ?? 0), 0);
const PRESET_IDS = ['core-rules', 'engineering-principles', 'frontend-react'];
const total = (out: string) => Number(/Always-loaded context from harness: ~(\d+) tokens/.exec(out)![1]);
const statusTotal = (out: string) => Number(/^Context: .*harness ~([\d,]+)\./m.exec(out)![1].replace(/,/g, ''));
const sh = (root: string, ...a: string[]) => git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
/** An installed repo with the preset (ids include its items) or without (the same picks, no preset key). */
async function twin(withPreset: boolean) {
  const root = repo();
  const ids = withPreset ? [...OWN, ...PRESET_IDS] : OWN;
  let args = [...aiArgs(ids), '--over-budget'];
  if (!withPreset) {
    const i = args.indexOf('--answers') + 1;
    writeFileSync(args[i], JSON.stringify({ ...ANSWERS, preset: undefined }));
  }
  expect((await run(root, args)).code).toBe(0);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'harness');
  return { root, ids, args };
}
const env = { CLAUDECODE: '1', HARNESS_PLAIN_INIT: '1' };
const TD = { ...base, env, claudeVersion: () => null as null, prompt: fake };
const viaUpdate = async (t: Awaited<ReturnType<typeof twin>>) => {
  let out = '';
  const args = aiArgs(t.ids).map((a) => (a === '--yes' ? '--dry-run' : a));
  const withAnswers = t.args[t.args.indexOf('--answers') + 1];
  args[args.indexOf('--answers') + 1] = withAnswers;
  await update(args, { ...TD, root: t.root, out: (s) => (out += s + '\n') });
  return out;
};
const viaItems = async (root: string, cmd: 'explain' | 'add', a: string[]) => {
  let out = '';
  await items(cmd, a, { ...TD, root, out: (s) => (out += s + '\n') });
  return out;
};

test('update prints the preview lines and counts the preset, so its total matches init and status by the preset sum', async () => {
  const [a, b] = [await twin(true), await twin(false)];
  const [ua, ub] = [await viaUpdate(a), await viaUpdate(b)];
  expect(total(ua) - total(ub), ua).toBe(presetSum(PRESET_IDS));
  expect(ua).toContain(ATTR);
  let st = '';
  status([], { root: a.root, env: {}, out: (s) => (st += s + '\n') });
  let sb = '';
  status([], { root: b.root, env: {}, out: (s) => (sb += s + '\n') });
  expect(statusTotal(st) - statusTotal(sb)).toBe(presetSum(PRESET_IDS));
});

test('items explain and add count the preset', async () => {
  const [a, b] = [await twin(true), await twin(false)];
  const want = presetSum(PRESET_IDS);
  expect(total(await viaItems(a.root, 'explain', [])) - total(await viaItems(b.root, 'explain', []))).toBe(want);
  const [aa, ab] = [await viaItems(a.root, 'add', ['ponytail', '--dry-run']), await viaItems(b.root, 'add', ['ponytail', '--dry-run'])];
  expect(total(aa) - total(ab), aa).toBe(want);
});

test('sync counts the preset', async () => {
  const [a, b] = [await twin(true), await twin(false)];
  const go = async (root: string) => {
    rmSync(join(root, '.claude/skills/review-rubric/SKILL.md'));
    sh(root, 'commit', '-qam', 'rm');
    let out = '';
    await sync(['--dry-run'], { ...TD, root, out: (s) => (out += s + '\n') });
    return out;
  };
  const [sa, sbOut] = [await go(a.root), await go(b.root)];
  expect(total(sa) - total(sbOut), sa).toBe(presetSum(PRESET_IDS));
});
