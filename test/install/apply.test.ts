import * as realFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { ApplyError, ManifestError, applyChanges, readManifest, type Change, type FsLike } from '../../src/install/apply.js';
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
    expect(m.files[0].hash).toBe(sha256('x\n')); // LF-normalized: a CRLF checkout must hash the same
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

  it('create over an existing file fails before any write', () => {
    const root = makeRepo({ 'a.txt': 'A', 'mine.txt': 'mine' }, { git: false });
    const changes: Change[] = [
      { kind: 'update', rel: 'a.txt', before: 'A', after: 'A2', blocks: [] },
      { kind: 'create', rel: 'mine.txt', content: 'x' },
    ];
    expect(() => applyChanges(root, changes, '1', NOW)).toThrow('`mine.txt` already exists. Run the command again.');
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'mine.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(root, '.harness'))).toBe(false);
  });

  it('rollback restores the original mode', () => {
    if (process.platform === 'win32') return;
    const root = makeRepo({ 'run.sh': 'sh', 'del.sh': 'd', 'z.txt': 'z' }, { git: false });
    realFs.chmodSync(join(root, 'run.sh'), 0o755);
    realFs.chmodSync(join(root, 'del.sh'), 0o700);
    const changes: Change[] = [
      { kind: 'update', rel: 'run.sh', before: 'sh', after: 'sh2', blocks: [] },
      { kind: 'delete', rel: 'del.sh', before: 'd' },
      { kind: 'update', rel: 'z.txt', before: 'z', after: 'z2', blocks: [] },
    ];
    const mode = (r: string) => realFs.statSync(join(root, r)).mode & 0o777;
    expect(() => applyChanges(root, changes, '1', NOW, failingRename(2))).toThrow(ApplyError);
    expect(mode('run.sh')).toBe(0o755);
    expect(mode('del.sh')).toBe(0o700);
    const root2 = makeRepo({ 'run.sh': 'sh' }, { git: false });
    realFs.chmodSync(join(root2, 'run.sh'), 0o755);
    applyChanges(root2, [{ kind: 'update', rel: 'run.sh', before: 'sh', after: 'sh2', blocks: [] }], '1', NOW);
    expect(realFs.statSync(join(root2, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('rollback removes created directories', () => {
    const root = makeRepo({ 'keep/x.txt': 'x', 'a.txt': 'A' }, { git: false });
    const changes: Change[] = [
      { kind: 'create', rel: '.claude/agents/a.md', content: 'x' },
      { kind: 'create', rel: 'n/deep/b.txt', content: 'x' },
      { kind: 'create', rel: 'keep/y.txt', content: 'x' },
      { kind: 'update', rel: 'a.txt', before: 'A', after: 'A2', blocks: [] },
    ];
    expect(() => applyChanges(root, changes, '1', NOW, failingRename(4))).toThrow(ApplyError);
    for (const d of ['.claude', 'n', '.harness']) expect(existsSync(join(root, d))).toBe(false);
    expect(readdirSync(join(root, 'keep'))).toEqual(['x.txt']);
  });

  it('rollback restores a read-only file', () => {
    if (process.platform === 'win32') return;
    const root = makeRepo({ 'ro.txt': 'R', 'z.txt': 'z' }, { git: false });
    realFs.chmodSync(join(root, 'ro.txt'), 0o444);
    const changes: Change[] = [
      { kind: 'update', rel: 'ro.txt', before: 'R', after: 'R2', blocks: [] },
      { kind: 'update', rel: 'z.txt', before: 'z', after: 'z2', blocks: [] },
    ];
    expect(() => applyChanges(root, changes, '1', NOW, failingRename(2))).toThrow(ApplyError);
    expect(readFileSync(join(root, 'ro.txt'), 'utf8')).toBe('R');
    expect(realFs.statSync(join(root, 'ro.txt')).mode & 0o777).toBe(0o444);
  });

  it('failed restore names the backup', () => {
    const root = makeRepo({ 'a.json': 'A', 'b.json': 'B' }, { git: false });
    let c = 0;
    // rename #1 is a no-op, every later rename throws, so the restores fail too
    const fs2 = { ...realFs, renameSync: () => { if (++c >= 2) throw new Error('boom'); } } as unknown as FsLike;
    const changes: Change[] = [
      { kind: 'update', rel: 'a.json', before: 'A', after: 'A2', blocks: [] },
      { kind: 'update', rel: 'b.json', before: 'B', after: 'B2', blocks: [] },
    ];
    const bk = '.harness/backup/2026-11-01T10-20-30.000Z';
    expect(() => applyChanges(root, changes, '1', NOW, fs2)).toThrow(
      `Rollback failed for \`b.json\`; its original is in \`${bk}/b.json\`. Restore it by hand.`,
    );
    expect(readFileSync(join(root, bk, 'b.json'), 'utf8')).toBe('B');
  });

  it('wraps unreadable files in ApplyError', () => {
    const root = makeRepo({ 'd/x': 'x' }, { git: false });
    for (const rel of ['missing.txt', 'd']) {
      expect(() => applyChanges(root, [{ kind: 'update', rel, before: 'x', after: 'y', blocks: [] }], '1', NOW)).toThrow(
        `Could not read \`${rel}\`. Check it exists and is readable, then run the command again.`,
      );
    }
    expect(() => applyChanges(root, [{ kind: 'delete', rel: 'missing.txt', before: 'x' }], '1', NOW)).toThrow(ApplyError);
  });

  it('never writes dotenv files', () => {
    const root = makeRepo({}, { git: false });
    for (const rel of ['.env', 'sub/.env.local']) {
      expect(() => applyChanges(root, [{ kind: 'create', rel, content: 'x' }], '1', NOW)).toThrow(
        `Harness never writes \`${rel}\`. Remove it from the plan.`,
      );
    }
    expect(existsSync(join(root, '.harness'))).toBe(false);
  });

  it('readManifest throws ManifestError on corrupt manifests', () => {
    for (const body of ['{nope', '[]', '"x"', 'null', '{}']) {
      const root = makeRepo({ '.harness/manifest.json': body }, { git: false });
      expect(() => readManifest(root)).toThrow(ManifestError);
    }
    const root = makeRepo({ '.harness/manifest.json': '{nope' }, { git: false });
    expect(() => readManifest(root)).toThrow(
      '`.harness/manifest.json` is unreadable. Restore it from git or delete `.harness/` and run /harness:init again.',
    );
  });
});

test('N5: a manifest that cannot be read is a read error, never "unreadable, delete .harness/"', async () => {
  const { RETRY } = await import('../../src/core/atomic.js');
  const saved = { ...RETRY };
  Object.assign(RETRY, { platform: 'win32', sleep: () => {} });
  const root = mkdtempSync(join(tmpdir(), 'h-mf-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ version: '1', createdAt: 'x', files: [] }));
  const eperm = () => { throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }); };
  try {
    let e: unknown;
    try { readManifest(root, eperm); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ManifestError);
    expect((e as Error).message).toMatch(/could not be read \(EPERM/);
    expect((e as Error).message).not.toMatch(/delete/);
    let n = 0;
    expect(readManifest(root, (p) => { if (n++ < 2) eperm(); return readFileSync(p, 'utf8'); })!.version).toBe('1');
    writeFileSync(join(root, '.harness/manifest.json'), '{bad');
    expect(() => readManifest(root)).toThrow(/unreadable/); // a real parse error keeps its message
  } finally {
    Object.assign(RETRY, saved);
  }
});
