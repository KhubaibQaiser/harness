import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecBytes } from '../../src/core/exec.js';
import { LIMITS, cleanTmp, fetchTarball } from '../../src/vet/fetch.js';
import type { Resolved } from '../../src/vet/target.js';
import { tarGz, type TarSpec } from '../fixtures/vet/tar.js';

const sha = 'a'.repeat(40);
const r: Resolved = { repo: 'o/r', ref: 'main', sha, path: '' };
const roots: string[] = [];
const root = () => { const d = mkdtempSync(join(tmpdir(), 'vet-fetch-')); roots.push(d); return d; };
afterEach(() => { for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true }); });
const ok = (entries: TarSpec[]): ExecBytes => () => ({ status: 0, stdout: tarGz(entries) });
const key = `o-r-${sha}`;
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

describe('fetchTarball', () => {
  it('calls gh with the size cap and writes files plus a gitignore', () => {
    const calls: unknown[][] = [];
    const rt = root();
    const f = fetchTarball(rt, r, (...a) => { calls.push(a); return { status: 0, stdout: tarGz([{ name: 'skills/a/SKILL.md', body: 'x' }, { name: 'README.md', body: 'y' }]) }; });
    expect(calls).toEqual([['gh', ['api', `repos/o/r/tarball/${sha}`], LIMITS.compressed + 1]]);
    if ('error' in f) throw new Error(f.error);
    expect(f.rel).toBe(`.harness/vet/tmp/${key}`);
    expect(f.files).toEqual(['README.md', 'skills/a/SKILL.md']);
    expect(readFileSync(join(f.dir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('x');
    expect(readFileSync(join(rt, '.harness', 'vet', 'tmp', '.gitignore'), 'utf8')).toBe('*\n');
  });
  it('clears a stale folder first', () => {
    const rt = root();
    const stale = join(rt, '.harness', 'vet', 'tmp', key);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'old.md'), 'old');
    const f = fetchTarball(rt, r, ok([{ name: 'new.md', body: 'n' }]));
    expect(existsSync(join(stale, 'old.md'))).toBe(false);
    expect('error' in f).toBe(false);
  });
  it('stops on a too-big archive, too many files, bombs and corrupt data', () => {
    expect(fetchTarball(root(), r, () => ({ status: 1, stdout: Buffer.alloc(0), tooBig: true }))).toEqual({ error: 'o/r@aaaaaaa: the archive is over 25 MB; vet stops.' });
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, body: '' }));
    const rt = root();
    expect(fetchTarball(rt, r, ok(many))).toEqual({ error: 'o/r@aaaaaaa: the archive has over 5000 files; vet stops.' });
    expect(existsSync(join(rt, '.harness'))).toBe(false);
    expect(fetchTarball(root(), r, () => ({ status: 0, stdout: Buffer.from('nope') }))).toEqual({ error: 'o/r@aaaaaaa: archive is corrupt; vet stops.' });
  });
  it('skips hostile entries, reports each, and writes nothing outside dir', () => {
    const rt = root();
    const f = fetchTarball(rt, r, ok([
      { name: '../evil', body: 'e' }, { name: '/abs', body: 'e' }, { name: 'sym', type: '2', link: '/etc/passwd' }, { name: 'hard', type: '1', link: 'ok.md' },
      { name: 'a\\b.md', body: 'e' }, { name: 'aux.md', body: 'e' }, { name: 'x:y.md', body: 'e' }, { name: 'trail.', body: 'e' }, { name: 'ok.md', body: 'fine' },
    ]));
    if ('error' in f) throw new Error(f.error);
    expect(f.files).toEqual(['ok.md']);
    expect(Object.fromEntries(f.skipped.map((s) => [s.path, s.why]))).toEqual({
      '../evil': 'parent path (..)', '/abs': 'absolute path', sym: 'symlink', hard: 'hard link',
      'a\\b.md': 'name not valid on Windows', 'aux.md': 'name not valid on Windows', 'x:y.md': 'name not valid on Windows', 'trail.': 'name not valid on Windows',
    });
    expect(walk(rt).map((p) => p.slice(rt.length)).sort()).toEqual([join(sep, '.harness', 'vet', 'tmp', '.gitignore'), join(sep, '.harness', 'vet', 'tmp', key, 'ok.md')].sort());
  });
  it('lists a file over 1 MB without writing it', () => {
    const f = fetchTarball(root(), r, ok([{ name: 'big.bin', body: Buffer.alloc(LIMITS.fileBytes + 1) }, { name: 'small.md', body: 's' }]));
    if ('error' in f) throw new Error(f.error);
    expect(f.large).toEqual(['big.bin']);
    expect(f.files).toEqual(['small.md']);
    expect(existsSync(join(f.dir, 'big.bin'))).toBe(false);
  });
  it('explains gh failures', () => {
    expect(fetchTarball(root(), r, () => ({ status: 1, stdout: Buffer.alloc(0), stderr: 'gh: Not Found (HTTP 404)' }))).toEqual({ error: 'o/r@aaaaaaa: tarball not found on GitHub.' });
    expect(fetchTarball(root(), r, () => ({ status: 127, stdout: Buffer.alloc(0), missing: true }))).toEqual({ error: expect.stringContaining('harness vet needs the GitHub CLI (gh).') });
    expect(fetchTarball(root(), r, () => ({ status: 4, stdout: Buffer.alloc(0), stderr: 'boom' }))).toEqual({ error: expect.stringContaining('could not download') });
  });
  it('cleanTmp removes one key or everything', () => {
    const rt = root();
    fetchTarball(rt, r, ok([{ name: 'a.md', body: 'a' }]));
    cleanTmp(rt, key);
    expect(existsSync(join(rt, '.harness', 'vet', 'tmp', key))).toBe(false);
    expect(existsSync(join(rt, '.harness', 'vet', 'tmp'))).toBe(true);
    cleanTmp(rt);
    expect(existsSync(join(rt, '.harness', 'vet', 'tmp'))).toBe(false);
  });
});
