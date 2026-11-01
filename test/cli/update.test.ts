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
const up = async (root: string, args: string[], over: { distDir?: string; version?: string; prompt?: Prompt; fetchImpl?: typeof fetch } = {}) => {
  let out = '';
  const code = await update(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: over.prompt ?? fake(), version: over.version ?? '1.1.0', templatesDir, distDir: over.distDir ?? join(pkgDir, 'dist'), fetchImpl: over.fetchImpl });
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
  // uninstall still removes everything
  const u = await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() });
  expect(u).toBe(0);
  expect(() => readFileSync(join(root, DISPATCH))).toThrow();
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
  expect(n.out).toContain('Harness 2.0.0 is available (you have 1.0.0). Run: npx @khubaibqaiser/harness@latest update');
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
