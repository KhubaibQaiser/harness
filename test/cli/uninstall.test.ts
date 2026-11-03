import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { status } from '../../src/cli/status.js';
import { doctor } from '../../src/cli/doctor.js';
import { makeRepo } from '../install/helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { env: {}, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
};
const fake = (answers: boolean[] = []): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return answers.length ? answers.shift()! : false; }, async edit(_l, v) { return v; } };
};
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const installed = async (files: Record<string, string> = REPO) => {
  const root = makeRepo(files);
  await init(['--yes'], { ...base, root, out: () => {}, prompt: fake() });
  return root;
};
const un = async (root: string, args: string[], prompt = fake()) => {
  let out = '';
  const code = await uninstall(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt });
  return { code, out, prompt };
};
const hashes = (root: string) => git(root, 'ls-files').split('\n').filter(Boolean).map((f) => f + createHash('sha256').update(readFileSync(join(root, f))).digest('hex'));

test('init then uninstall leaves the repo byte-identical', async () => {
  const root = makeRepo(REPO);
  const before = hashes(root);
  await init(['--yes'], { ...base, root, out: () => {}, prompt: fake() });
  expect(existsSync(join(root, '.claude/agents'))).toBe(true);
  const r = await un(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(git(root, 'status', '--porcelain')).toBe('');
  expect(hashes(root)).toEqual(before);
  expect(existsSync(join(root, '.harness'))).toBe(false);
  expect(existsSync(join(root, '.claude'))).toBe(false);
});

test('user-edited AGENTS.md outside the block keeps their edit', async () => {
  const root = await installed();
  const p = join(root, 'AGENTS.md');
  writeFileSync(p, '# Top edit\n' + readFileSync(p, 'utf8') + 'tail edit\n');
  const r = await un(root, ['--yes']);
  expect(r.code).toBe(0);
  const now = readFileSync(p, 'utf8');
  expect(now).toContain('# Top edit');
  expect(now).toContain('tail edit');
  expect(now).not.toContain('harness:start');
});

test('edited created file kept without --force, deleted with it', async () => {
  const root = await installed();
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '# mine\n');
  const r = await un(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('`.harness/config.yaml`');
  expect(existsSync(p)).toBe(true);
  const root2 = await installed();
  writeFileSync(join(root2, '.harness/config.yaml'), 'x\n');
  await un(root2, ['--yes', '--force']);
  expect(existsSync(join(root2, '.harness'))).toBe(false);
});

test('no manifest: says harness is not installed, exit 1', async () => {
  const r = await un(makeRepo(REPO), ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain('not installed');
  expect(r.out).toContain('Run harness init');
});

test('edited settings.json: structural removal keeps the user hooks and deny rules', async () => {
  const root = await installed({ ...REPO, '.claude/settings.json': '{\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine"}]}]},\n  "permissions": {"deny": ["Mine"]}\n}\n' });
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.extra = 1;
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  expect((await un(root, ['--yes'])).code).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, permissions: { deny: ['Mine'] }, extra: 1 });
});

test('edited settings.json created by init: harness parts removed, user key kept; unedited-to-empty deleted', async () => {
  const root = await installed();
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.extra = 1;
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  await un(root, ['--yes']);
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ extra: 1 });
  const root2 = await installed();
  const p2 = join(root2, '.claude/settings.json');
  writeFileSync(p2, JSON.stringify(JSON.parse(readFileSync(p2, 'utf8'))) + '\n'); // reformatted, so hash differs
  await un(root2, ['--yes']);
  expect(existsSync(p2)).toBe(false);
});

test('asks before deleting .harness and keeps logs on no', async () => {
  const root = await installed();
  writeFileSync(join(root, '.harness/logs.txt'), 'log');
  const prompt = fake([false]);
  const r = await un(root, [], prompt);
  expect(prompt.asked).toEqual(['Delete .harness/ including logs? (y/N)']);
  expect(r.code).toBe(0);
  expect(existsSync(join(root, '.harness/logs.txt'))).toBe(true);
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(false);
  // N8: the .gitignore lines stay, so nothing left in .harness/ shows up for git add -A
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.harness/backup/');
  expect(r.out).toContain('Kept the `.harness/` lines in `.gitignore`');
  expect(git(root, 'status', '--porcelain', '--', '.harness/backup', '.harness/logs', '.harness/state')).toBe('');
});

test('never removes a non-empty parent directory', async () => {
  const root = await installed();
  writeFileSync(join(root, '.claude/agents/mine.md'), 'mine');
  await un(root, ['--yes']);
  expect(existsSync(join(root, '.claude/agents/mine.md'))).toBe(true);
  expect(existsSync(join(root, '.claude/skills'))).toBe(false);
});

test('bad flag prints usage, exit 2', async () => {
  const r = await un(makeRepo(REPO), ['--nope']);
  expect(r.code).toBe(2);
});

test('edited config.yaml: fully uninstalled, the edited file kept, and init, status and doctor agree', async () => {
  const root = await installed();
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '# mine\n');
  const prompt = fake();
  const r = await un(root, ['--yes'], prompt);
  expect(r.code).toBe(0);
  expect(prompt.asked).toEqual([]);
  expect(r.out).toContain('Kept `.harness/config.yaml` because you edited them. Harness no longer tracks them');
  expect(readFileSync(p, 'utf8')).toContain('# mine');
  // Everything else is gone: no manifest, hooks, backups, logs or settings.
  expect(readdirSync(join(root, '.harness'))).toEqual(['config.yaml']);
  expect(existsSync(join(root, '.claude'))).toBe(false);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(REPO['.gitignore']);
  const quiet = { env: {}, root, out: () => {} };
  expect(status([], quiet)).toBe(1); // not installed
  expect(await doctor([], quiet)).toBe(1);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'kept config');
  let out = '';
  expect(await init(['--yes'], { ...base, root, out: (s) => (out += s), prompt: fake() })).toBe(0); // installs again
  expect(out).not.toContain('already installed');
});

test('edited config.yaml, --force: removed with the rest', async () => {
  const root = await installed();
  writeFileSync(join(root, '.harness/config.yaml'), 'edited\n');
  expect((await un(root, ['--yes', '--force'])).code).toBe(0);
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test('edited created settings.json uses recorded blocks', async () => {
  const root = await installed();
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
  expect(m.files.find((f: { rel: string }) => f.rel === '.claude/settings.json').blocks.length).toBeGreaterThan(0);
});

test('uninstall --dry-run lists what it would do and writes nothing', async () => {
  const root = await installed();
  const before = hashes(root);
  const r = await un(root, ['--dry-run']);
  expect(r.code).toBe(0);
  expect(r.out).toContain('Would remove `.harness/hooks/dispatch.mjs`');
  expect(r.out).toContain('`.harness/` is deleted too, including its logs');
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(hashes(root)).toEqual(before);
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(true);
});

test('jest repo: uninstall removes the reporter and restores the test script byte for byte', async () => {
  const files = {
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest --silent' }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n',
    'package-lock.json': '{}\n',
    '.gitignore': 'node_modules\n',
  };
  const root = makeRepo(files);
  await init(['--yes'], { ...base, root, out: () => {}, prompt: fake() });
  expect(existsSync(join(root, '.harness/hooks/jest-results.cjs'))).toBe(true);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'h');
  expect((await un(root, ['--yes'])).code).toBe(0);
  expect(existsSync(join(root, '.harness'))).toBe(false);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(files['package.json']);
});

// A teammate with core.autocrlf=true checks out every installed file with CRLF and has no .harness/backup (gitignored).
const toCrlf = (root: string) => {
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8'));
  for (const f of m.files) {
    const p = join(root, f.rel);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  rmSync(join(root, '.harness/backup'), { recursive: true, force: true });
};

test('CRLF checkout: uninstall removes the created files and the harness blocks', async () => {
  const root = await installed();
  toCrlf(root);
  const r = await un(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('because you edited them');
  expect(r.out).not.toContain('was not found');
  expect(existsSync(join(root, '.harness'))).toBe(false);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('# Mine\r\n');
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\r\n');
});

test('AGENTS.md created by init and then edited: harness block removed, user text kept, even with --force', async () => {
  const { 'AGENTS.md': _, ...noAgents } = REPO;
  for (const args of [['--yes'], ['--yes', '--force']]) {
    const root = await installed(noAgents);
    const p = join(root, 'AGENTS.md');
    writeFileSync(p, readFileSync(p, 'utf8') + 'my rule\n');
    expect((await un(root, args)).code).toBe(0);
    expect(readFileSync(p, 'utf8')).toContain('my rule');
    expect(readFileSync(p, 'utf8')).not.toContain('harness:start');
  }
});

const alwaysCfg = () => {
  const p = join(mkdtempSync(join(tmpdir(), 'h-cfg-')), 'config.yaml');
  writeFileSync(p, 'sandbox: always\n');
  return p;
};

test('init with always then uninstall is byte-identical', async () => {
  const pre = { '.claude/settings.json': JSON.stringify({ sandbox: { network: { allowedDomains: ['x'] } } }, null, 2) + '\n' };
  for (const files of [REPO, { ...REPO, ...pre }]) {
    const root = makeRepo(files);
    const before = hashes(root);
    await init(['--yes', '--config', alwaysCfg()], { ...base, root, out: () => {}, prompt: fake() });
    expect(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).sandbox.enabled).toBe(true);
    expect((await un(root, ['--yes'])).code).toBe(0);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(hashes(root)).toEqual(before);
  }
});

test("an edited settings file keeps the person's sandbox keys", async () => {
  const root = makeRepo(REPO);
  await init(['--yes', '--config', alwaysCfg()], { ...base, root, out: () => {}, prompt: fake() });
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.sandbox.network = { allowedDomains: ['x'] };
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  const r = await un(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('was changed');
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ sandbox: { network: { allowedDomains: ['x'] } } });
});

test('uninstall leaves a changed sandbox key, with a note', async () => {
  const root = makeRepo(REPO);
  await init(['--yes', '--config', alwaysCfg()], { ...base, root, out: () => {}, prompt: fake() });
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.sandbox.enabled = false;
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  const r = await un(root, ['--yes']);
  expect(r.out).toContain('Note: `.claude/settings.json`: `sandbox.enabled` was changed; left as is.');
  expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ sandbox: { enabled: false } });
});
