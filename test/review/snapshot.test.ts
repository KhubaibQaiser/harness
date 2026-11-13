import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultExecBytes } from '../../src/core/exec.js';
import { harnessIgnoreText } from '../../src/install/harnessignore.js';
import { writeSnapshot } from '../../src/review/snapshot.js';
import { repoWith } from './repo.js';

const KEY = `${homedir()}/.ssh/id_rsa`;
function snap(files: Parameters<typeof repoWith>[1], o: { ignore?: string; only?: Set<string> } = {}) {
  const r = repoWith({ 'k.txt': 'k\n' }, files);
  const dir = join(mkdtempSync(join(tmpdir(), 'h-snap-')), 'head');
  const s = writeSnapshot(defaultExecBytes, r.root, r.head, dir, { ignore: harnessIgnoreText(o.ignore ?? ''), ...(o.only && { only: o.only }) });
  return { ...s, dir, read: (p: string) => readFileSync(join(dir, ...s.map[p]!.split('/')), 'utf8') };
}

describe('writeSnapshot', () => {
  test('a symlink becomes a regular file holding its target', () => {
    const s = snap({ 'key': { link: KEY } });
    expect(lstatSync(join(s.dir, 'key.pr-snapshot')).isFile()).toBe(true);
    expect(s.read('key')).toBe(KEY);
  });
  test('dotenv files and .harnessignore matches are absent and listed', () => {
    const s = snap({ '.env.local': 'SECRET=1\n', 'cfg/.env': 'S=2\n', 'private/x.ts': 'p\n', 'ok.ts': 'o\n' }, { ignore: 'private/\n' });
    expect(existsSync(join(s.dir, 'cfg'))).toBe(false);
    expect(existsSync(join(s.dir, 'private'))).toBe(false);
    expect(Object.keys(s.map)).toEqual(['k.txt', 'ok.ts']);
    expect(s.omitted).toEqual(expect.arrayContaining([
      { path: '.env.local', why: 'dotenv file, not read' }, { path: 'cfg/.env', why: 'dotenv file, not read' }, { path: 'private/x.ts', why: 'matches .harnessignore, not read' },
    ]));
    expect(s.read('ok.ts')).toBe('o\n');
  });
  test('instruction names are stored vetted, and every file is mapped', () => {
    const s = snap({ 'CLAUDE.md': 'c\n', '.claude/x.md': 'x\n' });
    expect(s.read('CLAUDE.md')).toBe('c\n');
    expect(s.read('.claude/x.md')).toBe('x\n');
    expect(existsSync(join(s.dir, 'CLAUDE.md'))).toBe(false);
    expect(s.map).toEqual({ 'CLAUDE.md': 'CLAUDE.md.vetted.pr-snapshot', '.claude/x.md': '.claude.vetted/x.md.pr-snapshot', 'k.txt': 'k.txt.pr-snapshot' });
  });
  test('no snapshot file keeps a runnable or test name, so no test runner or tool picks one up', () => {
    const s = snap({ 'src/a.test.ts': 'test()\n', '__tests__/b.js': 'x\n', 'package.json': '{}\n', 'vitest.config.ts': 'x\n', 'run.sh': { exec: 'echo\n' }, 'tsconfig.json': '{}\n' });
    const all = readdirSync(s.dir, { recursive: true, withFileTypes: true }).filter((d) => !d.isDirectory()).map((d) => d.name);
    expect(all.length).toBe(7);
    for (const n of all) expect(n, n).toMatch(/\.pr-snapshot$/);
  });
  test('over 1 MB and binary files are not read', () => {
    const s = snap({ 'big.txt': 'a'.repeat(1024 * 1024 + 1), 'b.bin': Buffer.from([0, 1, 2]) });
    expect(s.omitted).toEqual(expect.arrayContaining([{ path: 'big.txt', why: 'over 1 MB, not read' }, { path: 'b.bin', why: 'binary, not read' }]));
    expect(s.map['big.txt']).toBeUndefined();
    expect(existsSync(join(s.dir, 'big.txt.pr-snapshot'))).toBe(false);
  });
  test('submodules are skipped and listed', () => {
    expect(snap({ sub: { gitlink: 'a'.repeat(40) } }).omitted).toContainEqual({ path: 'sub', why: 'submodule, not read' });
  });
  test('hostile names: a leading dash and a colon', () => {
    const s = snap({ '-rf': 'dash\n', 'a:b.ts': { indexOnly: 'colon\n' }, 'sp é.txt': 'u\n' });
    expect(s.read('-rf')).toBe('dash\n');
    expect(s.read('sp é.txt')).toBe('u\n');
    if (process.platform === 'win32') expect(s.omitted).toContainEqual({ path: 'a:b.ts', why: 'name not valid on Windows' });
    else expect(s.read('a:b.ts')).toBe('colon\n');
  });
  test('only limits the files written', () => {
    const s = snap({ 'a/x.ts': 'x\n', 'b/y.ts': 'y\n' }, { only: new Set(['a/x.ts']) });
    expect(s.files).toBe(1);
    expect(existsSync(join(s.dir, 'b'))).toBe(false);
  });
});
