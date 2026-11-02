import * as realFs from 'node:fs';
import type { FsLike } from '../../src/install/apply.js';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { latestVersion } from '../../src/core/registry.js';
import { readManifest } from '../../src/install/apply.js';
import { sha256 } from '../../src/install/text.js';
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
const fake = (answers: boolean[] = []): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return answers.length ? answers.shift()! : false; }, async edit(_l, v) { return v; } };
};
/** A copy of dist whose dispatcher differs, standing in for the next release. */
const newDist = () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-dist-'));
  cpSync(join(pkgDir, 'dist'), d, { recursive: true });
  const p = join(d, 'hooks', 'dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// v2\n');
  return d;
};
const installed = async () => {
  const root = makeRepo(REPO);
  await init(['--yes'], { env: {}, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') });
  return root;
};
const up = async (root: string, args: string[], over: { distDir?: string; version?: string; prompt?: Prompt; fetchImpl?: typeof fetch; fs?: FsLike } = {}) => {
  let out = '';
  const code = await update(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: over.prompt ?? fake(), version: over.version ?? '1.1.0', templatesDir, distDir: over.distDir ?? join(pkgDir, 'dist'), fetchImpl: over.fetchImpl, fs: over.fs });
  return { code, out };
};
const DISPATCH = '.harness/hooks/dispatch.mjs';

test('update re-renders the dispatcher and rewrites the manifest version', async () => {
  const root = await installed();
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, DISPATCH), 'utf8')).toContain('// v2');
  const m = readManifest(root)!;
  expect(m.version).toBe('1.1.0');
  const f = m.files.find((x) => x.rel === DISPATCH)!;
  expect(f.kind).toBe('create');
  expect(f.hash).toBe(sha256(readFileSync(join(root, DISPATCH), 'utf8')));
  expect(m.files.map((x) => x.rel)).toContain('.claude/settings.json'); // untouched entries carried over
  // uninstall still removes everything and restores merged files
  const u = await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() });
  expect(u).toBe(0);
  expect(() => readFileSync(join(root, DISPATCH))).toThrow();
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(REPO['AGENTS.md']);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(REPO['.gitignore']);
});

const manifestFails = (): FsLike => { let n = 0; return ({ ...realFs, renameSync: (a: any, b: any) => { if (/[\\/]\.harness[\\/]manifest\.json$/.test(String(b)) && !n++) throw new Error('boom'); realFs.renameSync(a, b); } }) as FsLike; };
const snapshot = (root: string) => [DISPATCH, '.harness/manifest.json', 'AGENTS.md', '.claude/settings.json'].map((r) => readFileSync(join(root, r), 'utf8'));

test('manifest write failure in update rolls back every file', async () => {
  const root = await installed();
  const before = snapshot(root);
  const r = await up(root, ['--yes'], { distDir: newDist(), fs: manifestFails() });
  expect(r.code).toBe(1);
  expect(r.out).toContain('rolled back');
  expect(snapshot(root)).toEqual(before);
});

test('manifest write failure in uninstall (kept path) rolls back every file', async () => {
  const root = await installed();
  const p = join(root, DISPATCH);
  writeFileSync(p, readFileSync(p, 'utf8') + '// mine\n'); // edited created file -> kept
  const before = snapshot(root);
  let out = '';
  const code = await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s), prompt: fake(), fs: manifestFails() });
  expect(code).toBe(1);
  expect(snapshot(root)).toEqual(before);
});

test('edited-files copy differs for merged files', async () => {
  const root = await installed();
  writeFileSync(join(root, DISPATCH), 'x\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Mine\nedit\n');
  // a changed template makes the merged AGENTS.md block update too
  const t = mkdtempSync(join(tmpdir(), 'harness-tpl-'));
  cpSync(templatesDir, t, { recursive: true });
  writeFileSync(join(t, 'agents-block.md'), readFileSync(join(t, 'agents-block.md'), 'utf8') + '\nNew line.\n');
  let out = '';
  await update(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir: t, distDir: newDist() });
  expect(out).toContain(`You edited these harness files; update replaces them: \`${DISPATCH}\`.`);
  expect(out).toMatch(/You edited these files; update changes only the harness parts: `AGENTS.md`\./);
});

test('update keeps user config', async () => {
  const root = await installed();
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '# my comment\n');
  const before = readFileSync(p, 'utf8');
  const entry = readManifest(root)!.files.find((x) => x.rel === '.harness/config.yaml')!;
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(readFileSync(p, 'utf8')).toBe(before);
  expect(readManifest(root)!.files.find((x) => x.rel === '.harness/config.yaml')).toEqual(entry);
});

test('lists user-edited harness files, even with --yes, and asks once', async () => {
  const root = await installed();
  const p = join(root, DISPATCH);
  writeFileSync(p, readFileSync(p, 'utf8') + '// mine\n');
  const pr = fake([true]);
  const r = await up(root, [], { distDir: newDist(), prompt: pr });
  expect(r.out).toContain(`You edited these harness files; update replaces them: \`${DISPATCH}\`.`);
  expect(pr.asked).toHaveLength(1);
  const y = await up(await (async () => { const x = await installed(); writeFileSync(join(x, DISPATCH), 'x\n'); return x; })(), ['--yes'], { distDir: newDist() });
  expect(y.out).toContain('You edited these harness files');
});

test('declining writes nothing', async () => {
  const root = await installed();
  const r = await up(root, [], { distDir: newDist(), prompt: fake([false]) });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Cancelled. Nothing was written.');
  expect(readFileSync(join(root, DISPATCH), 'utf8')).not.toContain('// v2');
});

test('no-op when current', async () => {
  const root = await installed();
  const m = readFileSync(join(root, '.harness/manifest.json'), 'utf8');
  const r = await up(root, ['--yes'], { version: '1.0.0' });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Harness 1.0.0 is up to date.');
  expect(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).toBe(m);
});

test('same files, newer version: manifest version is bumped', async () => {
  const root = await installed();
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readManifest(root)!.version).toBe('1.1.0');
});

test('refuses when not installed, bad flag, or invalid config', async () => {
  expect((await up(makeRepo(REPO), [])).out).toContain('harness init');
  expect((await up(makeRepo(REPO), ['--bogus'])).code).toBe(2);
  const root = await installed();
  writeFileSync(join(root, '.harness/config.yaml'), 'bogus_key: 1\n');
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(1);
  expect(r.out).toContain('bogus_key');
  expect(r.out).toContain('harness doctor');
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
test('--check with a fake fetch: newer, same, unreachable', async () => {
  const root = await installed();
  const n = await up(root, ['--check'], { version: '1.0.0', fetchImpl: reply(200, { version: '2.0.0' }) });
  expect(n.out).toContain('Harness 2.0.0 is available (you have 1.0.0). Plugin users: update the plugin, then run /harness:update. CLI users: npx @khubaibqaiser/harness@latest update.');
  const s = await up(root, ['--check'], { version: '2.0.0', fetchImpl: reply(200, { version: '2.0.0' }) });
  expect(s.out).toContain('Harness 2.0.0 is the latest.');
  const u = await up(root, ['--check'], { fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
  expect(u.out).toContain('Could not reach npm');
  expect(u.code).toBe(1);
});

test('latestVersion: URL-encoded scope, null on bad status or body', async () => {
  let url = '';
  const f = (async (u: string) => ((url = u), new Response('{"version":"3.1.0"}'))) as unknown as typeof fetch;
  expect(await latestVersion('@khubaibqaiser/harness', f)).toBe('3.1.0');
  expect(url).toBe('https://registry.npmjs.org/@khubaibqaiser%2fharness/latest');
  expect(await latestVersion('x', reply(404, {}))).toBeNull();
  expect(await latestVersion('x', reply(200, { version: 3 }))).toBeNull();
  expect(await latestVersion('x', (async () => new Response('not json')) as unknown as typeof fetch)).toBeNull();
});

test('update --dry-run prints the plan and writes nothing', async () => {
  const root = await installed();
  const before = snapshot(root);
  const r = await up(root, ['--dry-run'], { distDir: newDist(), prompt: { async confirm() { throw new Error('prompted'); }, async edit(_l, v) { return v; } } });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`  update ${DISPATCH}`);
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(snapshot(root)).toEqual(before);
});

test('CRLF checkout: update with the same version finds nothing edited and nothing to change', async () => {
  const root = await installed();
  const m = readManifest(root)!;
  for (const f of m.files) writeFileSync(join(root, f.rel), readFileSync(join(root, f.rel), 'utf8').replace(/\r?\n/g, '\r\n'));
  const r = await up(root, ['--dry-run'], { version: '1.0.0' });
  expect(r.out).not.toContain('You edited');
  expect(r.out).toContain('Harness 1.0.0 is up to date.');
});

test('CRLF checkout: a real update does not call the files edited, and records LF-normalized hashes', async () => {
  const root = await installed();
  for (const f of readManifest(root)!.files) writeFileSync(join(root, f.rel), readFileSync(join(root, f.rel), 'utf8').replace(/\r?\n/g, '\r\n'));
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('You edited');
  const agents = readManifest(root)!.files.find((x) => x.rel === DISPATCH)!;
  expect(agents.hash).toBe(sha256(readFileSync(join(root, DISPATCH), 'utf8').replace(/\r\n/g, '\n')));
});

test('update keeps the packages init left out of TDD in the manifest', async () => {
  const root = makeRepo({ ...REPO, 'vitest.config.ts': "export default { test: { root: './src' } };\n" });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') });
  expect(readManifest(root)!.tddOff).toEqual(['.']);
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readManifest(root)!.tddOff).toEqual(['.']);
});

// A Jest install from before the reporter: `--json --outputFile=...` appended to the test script.
const oldJestInstall = async () => {
  const pkg = JSON.stringify({ name: 'app', scripts: { test: 'jest --silent' }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n';
  const root = makeRepo({ 'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n' });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') });
  const oldBlock = ' --json --outputFile=.harness/state/test-results/root.json --coverage';
  const oldPkg = pkg.replace('"jest --silent"', `"jest --silent${oldBlock}"`);
  writeFileSync(join(root, 'package.json'), oldPkg);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === 'package.json');
  f.blocks = [oldBlock];
  f.hash = sha256(oldPkg);
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  return { root, pkg };
};

test('update migrates the old Jest --json script to the reporter form, and uninstall restores the original', async () => {
  const { root, pkg } = await oldJestInstall();
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  expect(script).toBe('jest --silent --reporters=default --reporters=./.harness/hooks/jest-results.cjs "--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=.harness/state/test-results/root.json --coverage');
  expect(r.out).not.toContain('You edited');
  expect((await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() }))).toBe(0);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkg);
});

test('migrated Jest script: uninstall without a backup (teammate clone) removes the block cleanly', async () => {
  const { root, pkg } = await oldJestInstall();
  expect((await up(root, ['--yes'])).code).toBe(0);
  realFs.rmSync(join(root, '.harness/backup'), { recursive: true, force: true });
  let out = '';
  expect(await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake() })).toBe(0);
  expect(out).not.toContain('was not found');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkg);
});

test('CRLF checkout: a multi-line block still in the file stays in the manifest after update', async () => {
  const root = await installed();
  // AGENTS.md lost the harness block (so update changes it) but still holds another recorded block, now with CRLF.
  writeFileSync(join(root, 'AGENTS.md'), '# Mine\r\nkept line 1\r\nkept line 2\r\n');
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === 'AGENTS.md');
  f.blocks = [...f.blocks, 'kept line 1\nkept line 2\n'];
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readManifest(root)!.files.find((x) => x.rel === 'AGENTS.md')!.blocks).toContain('kept line 1\nkept line 2\n');
});
