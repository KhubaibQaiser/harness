import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { MAX_HOPS, expandImports, inside, realIO, type RepoIO } from '../../src/budget/imports.js';
import { MAX_FILE_BYTES } from '../../src/budget/text.js';

const ROOT = '/repo';
const ENV_SKIP = (rel: string): boolean => /(^|\/)\.env/.test(rel);
const fake = (files: Record<string, string>, sizes: Record<string, number> = {}) => {
  const asked: string[] = [];
  const rel = (p: string): string => p.slice(ROOT.length + 1);
  const io: RepoIO = {
    read: (p) => { asked.push(`read ${rel(p)}`); return files[rel(p)] ?? null; },
    size: (p) => { asked.push(`size ${rel(p)}`); return sizes[rel(p)] ?? files[rel(p)]?.length ?? null; },
    lsFiles: () => null,
  };
  return { io, asked };
};
const run = (files: Record<string, string>, text: string, extra: { skip?: (r: string) => boolean; sizes?: Record<string, number> } = {}) => {
  const f = fake(files, extra.sizes);
  const seen = new Set<string>(['CLAUDE.md']);
  const out = expandImports(ROOT, { path: 'CLAUDE.md', text }, f.io, seen, extra.skip ?? (() => false));
  return { ...out, asked: f.asked };
};
const paths = (r: { files: { path: string }[] }) => r.files.map((f) => f.path);

test('a chain: hops 1 to 4 are read, the 5th is not', () => {
  expect(MAX_HOPS).toBe(4);
  const files = { 'c1.md': '@c2.md', 'c2.md': '@c3.md', 'c3.md': '@c4.md', 'c4.md': '@c5.md', 'c5.md': 'end' };
  const r = run(files, '@c1.md');
  expect(paths(r)).toEqual(['c1.md', 'c2.md', 'c3.md', 'c4.md']);
  expect(r.asked.some((p) => p.endsWith('c5.md'))).toBe(false);
  expect(r.files[1]).toMatchObject({ by: 'c1.md' });
});

test('a cycle stops', () => {
  const r = run({ 'a.md': '@b.md', 'b.md': '@a.md @CLAUDE.md' }, '@a.md');
  expect(paths(r)).toEqual(['a.md', 'b.md']);
});

test('a file imported twice is listed once', () => {
  const r = run({ 'a.md': '@c.md', 'b.md': '@c.md', 'c.md': 'x' }, '@a.md\n@b.md');
  expect(paths(r).filter((p) => p === 'c.md')).toHaveLength(1);
});

test('imports resolve relative to the importing file', () => {
  const r = run({ 'sub/a.md': '@b.md', 'sub/b.md': 'x' }, '@sub/a.md');
  expect(paths(r)).toEqual(['sub/a.md', 'sub/b.md']);
});

test('external imports are listed and never read', () => {
  const r = run({}, '@~/x.md\n@/etc/passwd\n@../../out.md\n@C:\\win\\x.md');
  expect(r.external).toEqual(['~/x.md', '/etc/passwd', '../../out.md', 'C:\\win\\x.md']);
  expect(r.files).toEqual([]);
  expect(r.asked).toEqual([]);
});

test('code spans, fences and mid-word @ are not imports', () => {
  const r = run({ 'a.md': 'x', 'b.md': 'x' }, 'see `@a.md` and ``@a.md`` here\n```\n@b.md\n```\nmail me@a.md');
  expect(r.files).toEqual([]);
  expect(r.asked).toEqual([]);
});

test('a dotenv import and skipped paths are dropped without a read', () => {
  const r = run({ '.env': 'S=1', 'x/.env.local': 'S=1', 'ok.md': 'x' }, '@.env @x/.env.local @ok.md', { skip: ENV_SKIP });
  expect(paths(r)).toEqual(['ok.md']);
  expect(r.asked.some((p) => p.includes('.env'))).toBe(false);
});

test('an oversize file is sized but not read; binary text is dropped', () => {
  const r = run({ 'big.md': 'x', 'bin.md': 'a\0b' }, '@big.md @bin.md', { sizes: { 'big.md': MAX_FILE_BYTES + 1 } });
  expect(r.files).toEqual([]);
  expect(r.asked).toEqual(['size big.md', 'size bin.md', 'read bin.md']);
});

test('imported files lose their comments and CRLF', () => {
  const r = run({ 'a.md': 'x\r\n<!-- c -->\r\ny' }, '@a.md');
  expect(r.files[0].text).toBe('x\ny');
});

test('the number of files is capped', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 300; i++) files[`f${i}.md`] = 'x';
  const r = run(files, Object.keys(files).map((k) => `@${k}`).join('\n'));
  expect(r.files.length).toBeLessThanOrEqual(100);
  expect(r.files.length).toBeGreaterThan(0);
});

test('inside', () => {
  expect(inside('/repo', '/repo/a/b')).toBe(true);
  expect(inside('/repo', '/repo2/a')).toBe(false);
  expect(inside('/repo', '/repo/../x')).toBe(false);
});

// Real filesystem: symlinks and the git listing.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'imp-')); dirs.push(d); return d; };

test.skipIf(process.platform === 'win32')('a symlink out of the repo is not followed', () => {
  const outside = tmp();
  writeFileSync(join(outside, 'secret.md'), 'SECRET');
  const root = tmp();
  mkdirSync(join(root, 'real'));
  symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));
  symlinkSync(outside, join(root, 'dir'));
  writeFileSync(join(root, 'real', 'ok.md'), 'ok');
  const r = expandImports(root, { path: 'CLAUDE.md', text: '@link.md @dir/secret.md @real/ok.md' }, realIO, new Set(), () => false);
  expect(r.files.map((f) => f.path)).toEqual(['real/ok.md']);
  expect(r.external).toEqual(expect.arrayContaining(['link.md', 'dir/secret.md']));
  expect(JSON.stringify(r)).not.toContain('SECRET');
});

test('realIO: a missing file is null; lsFiles is null outside a git repo', () => {
  const root = tmp();
  expect(realIO.read(join(root, 'none.md'))).toBeNull();
  expect(realIO.size(join(root, 'none.md'))).toBeNull();
  expect(realIO.lsFiles(root)).toBeNull();
});
