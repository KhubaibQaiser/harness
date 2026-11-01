import * as realFs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApplyError, applyChanges, readManifest, type Change, type FsLike } from '../../src/install/apply.js';
import { sha256 } from '../../src/install/text.js';
import { makeRepo } from './helpers.js';

const NOW = () => new Date('2026-11-01T10:20:30.000Z');
const tmpFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.harness-tmp')) out.push(p);
    }
  };
  walk(root);
  return out;
};
const failingRename = (n: number): FsLike => {
  let c = 0;
  return { ...realFs, renameSync: (a, b) => { if (++c === n) throw new Error('boom'); realFs.renameSync(a, b); } } as FsLike;
};

describe('applyChanges', () => {
  it('creates and updates and writes the manifest with hashes', () => {
    const root = makeRepo({ 'a.txt': 'old', 'gone.txt': 'bye' }, { git: false });
    const m = applyChanges(root, [
      { kind: 'create', rel: 'dir/new.sh', content: 'x\r\n', mode: 0o755 },
      { kind: 'update', rel: 'a.txt', before: 'old', after: 'new', blocks: ['new'] },
      { kind: 'delete', rel: 'gone.txt', before: 'bye' },
    ], '1.2.3', NOW);
    expect(readFileSync(join(root, 'dir/new.sh'), 'utf8')).toBe('x\r\n');
    if (process.platform !== 'win32') expect(realFs.statSync(join(root, 'dir/new.sh')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(root, 'gone.txt'))).toBe(false);
    expect(m.version).toBe('1.2.3');
    expect(m.createdAt).toBe('2026-11-01T10:20:30.000Z');
    expect(m.files.map((f) => [f.rel, f.kind])).toEqual([['dir/new.sh', 'create'], ['a.txt', 'update'], ['gone.txt', 'delete']]);
    expect(m.files[0].hash).toBe(sha256('x\r\n'));
    expect(m.files[1].blocks).toEqual(['new']);
    const bk = '.harness/backup/2026-11-01T10-20-30.000Z/';
    expect(m.files[1].backup).toBe(bk + 'a.txt');
    expect(readFileSync(join(root, bk, 'a.txt'), 'utf8')).toBe('old');
    expect(readManifest(root)).toEqual(m);
    expect(tmpFiles(root)).toEqual([]);
  });

  it('writeManifest false skips the manifest but still returns it', () => {
    const root = makeRepo({}, { git: false });
    const m = applyChanges(root, [{ kind: 'create', rel: 'a', content: 'a' }], '1', NOW, undefined, { writeManifest: false });
    expect(m.files).toHaveLength(1);
    expect(readManifest(root)).toBeNull();
  });

  it('failure on the third write restores the first two and removes temp files', () => {
    const root = makeRepo({ 'a.txt': 'A', 'b.txt': 'B', 'c.txt': 'C' }, { git: false });
    const changes: Change[] = [
      { kind: 'update', rel: 'a.txt', before: 'A', after: 'A2', blocks: [] },
      { kind: 'delete', rel: 'b.txt', before: 'B' },
      { kind: 'create', rel: 'n/c.txt', content: 'x' },
      { kind: 'update', rel: 'c.txt', before: 'C', after: 'C2', blocks: [] },
    ];
    // renames: a.txt (1), create n/c.txt (2), c.txt (3 -> boom); delete uses unlink
    expect(() => applyChanges(root, changes, '1', NOW, failingRename(3))).toThrow(ApplyError);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('B');
    expect(readFileSync(join(root, 'c.txt'), 'utf8')).toBe('C');
    expect(existsSync(join(root, 'n/c.txt'))).toBe(false);
    expect(tmpFiles(root)).toEqual([]);
    expect(existsSync(join(root, '.harness/backup'))).toBe(false);
    expect(existsSync(join(root, '.harness/manifest.json'))).toBe(false);
  });

  it('manifest write failure rolls back everything', () => {
    const root = makeRepo({ 'a.txt': 'A' }, { git: false });
    const changes: Change[] = [{ kind: 'update', rel: 'a.txt', before: 'A', after: 'A2', blocks: [] }];
    expect(() => applyChanges(root, changes, '1', NOW, failingRename(2))).toThrow(ApplyError);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A');
    expect(tmpFiles(root)).toEqual([]);
  });

  it('refuses a symlinked target before writing anything', () => {
    if (process.platform === 'win32') return;
    const root = makeRepo({ 'real/x.txt': 'x', 'ok.txt': 'ok' }, { git: false });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    const changes: Change[] = [
      { kind: 'update', rel: 'ok.txt', before: 'ok', after: 'ok2', blocks: [] },
      { kind: 'create', rel: 'link/y.txt', content: 'y' },
    ];
    expect(() => applyChanges(root, changes, '1', NOW)).toThrow(/symlink/);
    expect(readFileSync(join(root, 'ok.txt'), 'utf8')).toBe('ok');
    expect(existsSync(join(root, 'real/y.txt'))).toBe(false);
    expect(existsSync(join(root, '.harness'))).toBe(false);
  });

  it('refuses paths that escape the root', () => {
    const root = makeRepo({}, { git: false });
    for (const rel of ['../evil.txt', '/abs/evil.txt', 'a/../../evil.txt']) {
      expect(() => applyChanges(root, [{ kind: 'create', rel, content: 'x' }], '1', NOW)).toThrow(ApplyError);
    }
  });

  it('fails before any write when the file changed since the plan', () => {
    const root = makeRepo({ 'a.txt': 'A', 'b.txt': 'changed' }, { git: false });
    const changes: Change[] = [
      { kind: 'update', rel: 'a.txt', before: 'A', after: 'A2', blocks: [] },
      { kind: 'delete', rel: 'b.txt', before: 'B' },
    ];
    expect(() => applyChanges(root, changes, '1', NOW)).toThrow('`b.txt` changed since the plan was made. Run the command again.');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A');
    expect(existsSync(join(root, '.harness'))).toBe(false);
  });
});
