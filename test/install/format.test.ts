import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { init, type Prompt } from '../../src/cli/init.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { update } from '../../src/cli/update.js';
import { readManifest } from '../../src/install/apply.js';
import { lineHunks, revertHunks } from '../../src/install/diff.js';
import { prettierFormat, repoPrettier } from '../../src/install/format.js';
import { hashText } from '../../src/install/text.js';
import { makeRepo, withPrettier } from './helpers.js';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const prompt: Prompt = { async confirm() { return false; }, async edit(_l, v) { return v; } };
const quiet = { env: {}, out: () => {} };

const VITEST = 'export default {\n  test: { globals: true },\n};\n';
const repo = (files: Record<string, string> = {}) => makeRepo({
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.0.0', '@vitest/coverage-v8': '^2.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'vitest.config.ts': VITEST, ...files,
});
const go = async (root: string) => { let out = ''; await init(['--yes'], { ...quiet, root, out: (s) => (out += s + '\n'), prompt, version: '1.0.0', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') }); return out; };
const un = async (root: string) => { let out = ''; const code = await uninstall(['--yes'], { ...quiet, root, out: (s) => (out += s + '\n'), prompt }); return { code, out }; };
const cfg = (root: string) => readFileSync(join(root, 'vitest.config.ts'), 'utf8');

describe('lineHunks / revertHunks', () => {
  test.each([
    ['one-line object expanded', 'a\n  test: { x },\nb\n', 'a\n  test: {\n    x,\n    y,\n  },\nb\n'],
    ['insert at the start and the end', 'm\n', 'top\nm\nend\n'],
    ['no trailing newline', 'a\nb', 'a\nB\nb'],
    ['two separate hunks', '1\n2\n3\n4\n5\n6\n7\n', '1\nX\n2\n3\n4\n5\n6\nY\n7\n'],
  ])('%s', (_n, a, b) => {
    const h = lineHunks(a, b);
    expect(revertHunks(b, h)).toBe(a);
    expect(revertHunks('user line\n' + b, h)).toBe('user line\n' + a); // an edit outside the hunks survives
  });
  test('a missing hunk is null', () => expect(revertHunks('zzz\n', [{ from: 'a\n', to: 'b\n' }])).toBeNull());
});

test('repoPrettier: the package folder, then parents up to the repo root, never above', () => {
  const root = makeRepo({ ...withPrettier, 'packages/a/x.ts': '' }, { git: false });
  expect(repoPrettier(root, 'packages/a/x.ts')).toBe(join(root, 'node_modules/prettier/bin/prettier.cjs'));
  expect(repoPrettier(makeRepo({ 'x.ts': '' }, { git: false }), 'x.ts')).toBeNull();
});

test('N1: with the repo\'s Prettier, the edit is formatted, and uninstall gives the original back with or without the backup', async () => {
  for (const backup of [true, false]) {
    const root = repo(withPrettier);
    await go(root);
    expect(cfg(root).split('\n').every((l) => l.length <= 80)).toBe(true);
    const e = readManifest(root)!.files.find((f) => f.rel === 'vitest.config.ts')!;
    expect(e.formatted).toBe(true);
    expect(e.replace!.length).toBeGreaterThan(0);
    expect(e.blocks).toEqual([]);
    if (!backup) rmSync(join(root, '.harness/backup'), { recursive: true, force: true }); // a teammate's clone
    expect((await un(root)).code).toBe(0);
    expect(cfg(root)).toBe(VITEST);
  }
});

test('N1: a user edit elsewhere in the formatted file survives uninstall, and the file is formatted again', async () => {
  const root = repo(withPrettier);
  await go(root);
  writeFileSync(join(root, 'vitest.config.ts'), '// mine\n' + cfg(root));
  const r = await un(root);
  expect(r.out).not.toContain('was not found');
  expect(cfg(root)).toBe('// mine\n' + VITEST);
});

test('N1: Prettier failing keeps the edit unformatted, with a note in init and in doctor', async () => {
  const root = repo({ ...withPrettier, 'vitest.config.ts': '// FAIL_FORMAT\n' + VITEST });
  const out = await go(root);
  expect(out).toMatch(/Note: Prettier could not format `vitest\.config\.ts` \(.*\); the edit is left unformatted/);
  expect(cfg(root)).toContain("test: { globals: true, reporters: ['default', 'json']");
  const e = readManifest(root)!.files.find((f) => f.rel === 'vitest.config.ts')!;
  expect(e.unformatted).toBe(true);
  let d = '';
  await doctor([], { ...quiet, root, out: (s) => (d += s + '\n') });
  expect(d).toMatch(/^note Prettier could not format `vitest\.config\.ts` when harness edited it/m);
  expect((await un(root)).code).toBe(0);
  expect(cfg(root)).toBe('// FAIL_FORMAT\n' + VITEST);
});

test('N1: a file that was not Prettier-clean before is left unformatted; no Prettier, no formatting', async () => {
  const long = 'export default {\n  test: { globals: true }, plugins: [], resolve: {}, server: {}, build: {}, define: {}, css: {} };\n';
  const a = repo({ ...withPrettier, 'vitest.config.ts': long });
  await go(a);
  expect(readManifest(a)!.files.find((f) => f.rel === 'vitest.config.ts')!.formatted).toBeUndefined();
  const b = repo();
  await go(b);
  expect(existsSync(join(b, 'node_modules'))).toBe(false);
  const e = readManifest(b)!.files.find((f) => f.rel === 'vitest.config.ts')!;
  expect(e.formatted).toBeUndefined();
  expect(e.blocks!.length).toBeGreaterThan(0);
});

test("update never runs the repo's Prettier on harness's own files: the dispatcher is written as built", async () => {
  const root = repo(withPrettier);
  await go(root);
  // A Prettier-clean old dispatcher, as recorded: update replaces it, and must not format the new one.
  const placeholder = '// old dispatcher\n';
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), placeholder);
  const m = readManifest(root)!;
  m.files.find((f) => f.rel === '.harness/hooks/dispatch.mjs')!.hash = hashText(placeholder);
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify(m, null, 2) + '\n');
  for (const a of [['add', '-A'], ['commit', '-qm', 'old install']]) execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: root });
  let o = '';
  const code = await update(['--yes'], { ...quiet, root, out: (s) => (o += s + '\n'), prompt, version: '1.0.0', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') });
  expect(code, o).toBe(0);
  expect(readFileSync(join(root, '.harness/hooks/dispatch.mjs'), 'utf8')).toBe(readFileSync(join(pkgDir, 'dist/hooks/dispatch.mjs'), 'utf8'));
  expect(readManifest(root)!.files.find((f) => f.rel === '.harness/hooks/dispatch.mjs')!.formatted).toBeUndefined();
});

test('R3: a Prettier that ignores SIGTERM is killed at the timeout, not waited on', () => {
  const root = makeRepo({
    'node_modules/prettier/package.json': JSON.stringify({ name: 'prettier', bin: 'bin/p.cjs' }),
    'node_modules/prettier/bin/p.cjs': "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
  }, { git: false });
  const bin = repoPrettier(root, 'x.ts')!;
  const t0 = Date.now();
  expect(() => prettierFormat(bin, root, 'x.ts', 'x', 500)).toThrow();
  expect(Date.now() - t0).toBeLessThan(5000);
}, 15_000);

test('R1: on a CRLF checkout with no backup, uninstall still undoes the formatted edit and keeps CRLF', async () => {
  const root = repo(withPrettier);
  await go(root);
  const p = join(root, 'vitest.config.ts');
  writeFileSync(p, cfg(root).replace(/\r?\n/g, '\r\n')); // a teammate with core.autocrlf=true
  rmSync(join(root, '.harness/backup'), { recursive: true, force: true });
  const r = await un(root);
  expect(r.out).not.toContain('was not found');
  expect(cfg(root)).toBe(VITEST.replace(/\n/g, '\r\n'));
});
test('R1: revertHunks matches across line endings and writes the text\'s own', () => {
  const h = lineHunks('a\n  test: { x },\nb\n', 'a\n  test: {\n    x,\n    y,\n  },\nb\n');
  expect(revertHunks('a\r\n  test: {\r\n    x,\r\n    y,\r\n  },\r\nb\r\n', h)).toBe('a\r\n  test: { x },\r\nb\r\n');
});
