import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep, win32 } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { MAX_ATTEMPTS, MAX_HOPS, MAX_IMPORTED, expandImports, inside, insideWith, realIO, relPosix, type RepoIO } from '../../src/budget/imports.js';
import { MAX_FILE_BYTES } from '../../src/budget/text.js';

const ROOT = resolve('/repo'); // 'C:\\repo' on Windows
const ENV_SKIP = (rel: string): boolean => /(^|\/)\.env/.test(rel);
const fake = (files: Record<string, string>, sizes: Record<string, number> = {}, realOf?: (p: string) => string | null) => {
  const asked: string[] = [];
  const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');
  const io: RepoIO = {
    read: (p) => { asked.push(`read ${rel(p)}`); return files[rel(p)] ?? null; },
    size: (p) => { asked.push(`size ${rel(p)}`); return sizes[rel(p)] ?? files[rel(p)]?.length ?? null; },
    lsFiles: () => null,
    real: realOf ?? ((p) => p),
  };
  return { io, asked };
};
const run = (files: Record<string, string>, text: string, extra: { skip?: (r: string) => boolean; sizes?: Record<string, number>; real?: (p: string) => string | null } = {}) => {
  const f = fake(files, extra.sizes, extra.real);
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
  expect(r.files).toHaveLength(MAX_IMPORTED);
  expect(r.skipped.filter((x) => x.reason === 'cap')).toHaveLength(1);
});

test('skipped reports oversize, binary, unreadable, ignored; a missing file is silent', () => {
  const r = run({ 'bin.md': 'a\0b', 'big.md': 'x', 'sec.md': 'x' }, '@big.md @bin.md @un.md @sec.md @gone.md', { sizes: { 'big.md': MAX_FILE_BYTES + 1, 'un.md': 5 }, skip: (rel) => rel === 'sec.md' });
  expect(r.skipped).toEqual([
    { path: 'big.md', by: 'CLAUDE.md', reason: 'oversize' },
    { path: 'bin.md', by: 'CLAUDE.md', reason: 'binary' },
    { path: 'un.md', by: 'CLAUDE.md', reason: 'unreadable' },
    { path: 'sec.md', by: 'CLAUDE.md', reason: 'ignored' },
  ]);
});

test('every attempt counts toward the cap, not only successes', () => {
  const text = Array.from({ length: MAX_ATTEMPTS * 2 }, (_, i) => `@m${i}.md`).join('\n');
  const r = run({}, text);
  expect(r.asked.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
  expect(r.skipped.filter((x) => x.reason === 'cap')).toHaveLength(1);
});

test('without real(), every import is external (fails closed)', () => {
  const f = fake({ 'a.md': 'x' });
  const io: RepoIO = { read: f.io.read, size: f.io.size, lsFiles: f.io.lsFiles } as RepoIO;
  const r = expandImports(ROOT, { path: 'CLAUDE.md', text: '@a.md' }, io, new Set(), () => false);
  expect(r.files).toEqual([]);
  expect(r.external).toEqual(['a.md']);
  expect(f.asked).toEqual([]);
});

test('an existing file whose real path cannot be resolved is external', () => {
  const r = run({ 'a.md': 'x' }, '@a.md @gone.md', { real: () => null });
  expect(r.files).toEqual([]);
  expect(r.external).toEqual(['a.md']);
});

test('a backslash-escaped space is part of the path', () => {
  const r = run({ 'Design Docs/x.md': 'x' }, '@Design\\ Docs/x.md');
  expect(paths(r)).toEqual(['Design Docs/x.md']);
});

test('an absolute path inside the repo is an import; outside is external', () => {
  const r = run({ 'a.md': 'x' }, `@${ROOT}/a.md @/elsewhere/b.md`);
  expect(paths(r)).toEqual(['a.md']);
  expect(r.external).toEqual(['/elsewhere/b.md']);
});

test.skipIf(process.platform === 'win32')('a POSIX path starting with a backslash is not treated as a Windows absolute', () => {
  const r = run({}, '@\\foo.md');
  expect(r.external).toEqual([]);
  expect(r.asked).toEqual(['size \\foo.md']);
});

test('realIO provides real()', () => {
  expect(typeof realIO.real).toBe('function');
});

test('external, missing and duplicate tokens after the file cap do not trigger a false cap skip', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < MAX_IMPORTED; i++) files[`f${i}.md`] = 'x';
  const text = Object.keys(files).map((k) => `@${k}`).join('\n') + '\n@~/x.md @gone.md @f0.md';
  const r = run(files, text);
  expect(r.files).toHaveLength(MAX_IMPORTED);
  expect(r.skipped).toEqual([]);
  expect(r.external).toEqual(['~/x.md']);
});

test('inside', () => {
  expect(inside(ROOT, join(ROOT, 'a', 'b'))).toBe(true);
  expect(inside(ROOT, `${ROOT}2${sep}a`)).toBe(false);
  expect(inside(ROOT, join(ROOT, '..', 'x'))).toBe(false);
});

// win32 rules, run on any OS by injecting path.win32.
test('win32: containment is separator-, case- and drive-safe', () => {
  const root = 'C:\\Users\\me\\repo';
  expect(insideWith(win32, root, 'C:\\Users\\me\\repo\\sub\\a.md')).toBe(true);
  expect(insideWith(win32, root, 'c:\\users\\ME\\repo\\a.md')).toBe(true);
  expect(insideWith(win32, root, 'C:\\Users\\me\\repo2\\a.md')).toBe(false);
  expect(insideWith(win32, root, 'C:\\Users\\me\\repo\\..\\x.md')).toBe(false);
  expect(insideWith(win32, root, 'D:\\Users\\me\\repo\\a.md')).toBe(false);
  expect(insideWith(win32, root, '\\\\server\\share\\a.md')).toBe(false);
});

test('win32: repo-relative paths come out with forward slashes', () => {
  const root = 'C:\\repo';
  expect(relPosix(win32, root, win32.resolve(root, 'sub', 'a.md'))).toBe('sub/a.md');
  expect(relPosix(win32, root, win32.resolve(root, 'sub\\deep/b.md'))).toBe('sub/deep/b.md');
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
