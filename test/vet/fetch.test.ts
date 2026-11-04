import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecBytes } from '../../src/core/exec.js';
import { LIMITS, cleanTmp, fetchTarball, type Fetched } from '../../src/vet/fetch.js';
import type { Resolved } from '../../src/vet/target.js';
import { tarGz, type TarSpec } from '../fixtures/vet/tar.js';

const sha = 'a'.repeat(40);
const r: Resolved = { repo: 'o/r', ref: 'main', sha, path: '' };
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) cleanTmp(d); });
const ok = (entries: TarSpec[]): ExecBytes => () => ({ status: 0, stdout: tarGz(entries) });
const run = (entries: TarSpec[]): Fetched => {
  const f = fetchTarball(r, ok(entries));
  if ('error' in f) throw new Error(f.error);
  made.push(f.dir);
  return f;
};
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const onDisk = (f: Fetched) => walk(f.dir).map((p) => p.slice(f.dir.length + 1).split(sep).join('/')).filter((p) => p !== '.gitignore').sort();
const why = (f: Fetched) => Object.fromEntries(f.skipped.map((s) => [s.path, s.why]));

describe('fetchTarball', () => {
  it('calls gh with the size cap and unpacks outside the project, with a gitignore', () => {
    const calls: unknown[][] = [];
    const f = fetchTarball(r, (...a) => { calls.push(a); return { status: 0, stdout: tarGz([{ name: 'skills/a/SKILL.md', body: 'x' }, { name: 'README.md', body: 'y' }]) }; });
    if ('error' in f) throw new Error(f.error);
    made.push(f.dir);
    expect(calls).toEqual([['gh', ['api', `repos/o/r/tarball/${sha}`], LIMITS.compressed + 1]]);
    expect(dirname(f.dir)).toBe(tmpdir());
    expect(basename(f.dir)).toMatch(/^harness-vet-o-r-aaaaaaa-/);
    expect(f.files).toEqual(['README.md', 'skills/a/SKILL.md']);
    expect(readFileSync(join(f.dir, 'skills', 'a', 'SKILL.md'), 'utf8')).toBe('x');
    expect(readFileSync(join(f.dir, '.gitignore'), 'utf8')).toBe('*\n');
  });
  it('uses a fresh folder per run', () => {
    expect(run([{ name: 'a', body: '1' }]).dir).not.toBe(run([{ name: 'a', body: '1' }]).dir);
  });
  it('stops on a too-big archive, too many files, and corrupt data, writing nothing', () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('harness-vet-')).length;
    expect(fetchTarball(r, () => ({ status: 1, stdout: Buffer.alloc(0), tooBig: true }))).toEqual({ error: 'o/r@aaaaaaa: the archive is over 25 MB; vet stops.' });
    const many = Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}`, body: '' }));
    expect(fetchTarball(r, ok(many))).toEqual({ error: 'o/r@aaaaaaa: the archive has over 5000 files; vet stops.' });
    expect(fetchTarball(r, () => ({ status: 0, stdout: Buffer.from('nope') }))).toEqual({ error: 'o/r@aaaaaaa: archive is corrupt; vet stops.' });
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('harness-vet-')).length).toBe(before);
  });
  it('skips hostile entries, reports each, and writes nothing outside dir', () => {
    const f = run([
      { name: '../evil', body: 'e' }, { name: '/abs', body: 'e' }, { name: 'sym', type: '2', link: '/etc/passwd' }, { name: 'hard', type: '1', link: 'ok.md' },
      { name: 'a\\b.md', body: 'e' }, { name: 'aux.md', body: 'e' }, { name: 'x:y.md', body: 'e' }, { name: 'trail.', body: 'e' },
      { name: 'COM¹.md', body: 'e' }, { name: 'CONIN$', body: 'e' }, { name: 'dev', type: '3' }, { name: 'ok.md', body: 'fine' },
    ]);
    expect(f.files).toEqual(['ok.md']);
    expect(why(f)).toEqual({
      '../evil': 'parent path (..)', '/abs': 'absolute path', sym: 'symlink', hard: 'hard link', dev: 'special file',
      'a\\b.md': 'name not valid on Windows', 'aux.md': 'name not valid on Windows', 'x:y.md': 'name not valid on Windows', 'trail.': 'name not valid on Windows',
      'COM¹.md': 'name not valid on Windows', 'CONIN$': 'name not valid on Windows',
    });
    expect(onDisk(f)).toEqual(['ok.md']);
    expect(existsSync(join(f.dir, '..', 'evil'))).toBe(false);
  });
  it('lists a file over 1 MB without writing it', () => {
    const f = run([{ name: 'big.bin', body: Buffer.alloc(LIMITS.fileBytes + 1) }, { name: 'small.md', body: 's' }]);
    expect(f.large).toEqual(['big.bin']);
    expect(f.files).toEqual(['small.md']);
    expect(onDisk(f)).toEqual(['small.md']);
  });
  it('skips every entry of a case collision, so the scan never reads the wrong bytes', () => {
    const f = run([{ name: 'skills/x/SKILL.md', body: 'EVIL' }, { name: 'skills/x/skill.md', body: 'benign' }, { name: 'ok.md', body: 'k' }]);
    expect(f.files).toEqual(['ok.md']);
    expect(why(f)).toEqual({ 'skills/x/SKILL.md': 'name collides with skills/x/skill.md', 'skills/x/skill.md': 'name collides with skills/x/SKILL.md' });
    expect(onDisk(f)).toEqual(['ok.md']);
  });
  it('skips every entry of a Unicode normalisation collision', () => {
    const f = run([{ name: 'café.md', body: 'a' }, { name: 'café.md', body: 'b' }]);
    expect(f.files).toEqual([]);
    expect(f.skipped.map((s) => s.why.startsWith('name collides with'))).toEqual([true, true]);
    expect(onDisk(f)).toEqual([]);
  });
  it('skips both copies of an exact duplicate', () => {
    const f = run([{ name: 'a.md', body: '1' }, { name: 'a.md', body: '2' }]);
    expect(f.files).toEqual([]);
    expect(f.skipped).toEqual([{ path: 'a.md', why: 'duplicate entry a.md' }, { path: 'a.md', why: 'duplicate entry a.md' }]);
  });
  it('renames instruction-bearing names and maps them back', () => {
    const f = run([
      { name: 'CLAUDE.md', body: 'IGNORE PREVIOUS' }, { name: 'sub/claude.local.md', body: 'x' }, { name: 'Agents.md', body: 'x' },
      { name: '.claude/skills/x/SKILL.md', body: 'hostile' }, { name: 'p/.Claude/settings.json', body: '{}' }, { name: 'skills/x/SKILL.md', body: 'fine' },
    ]);
    expect(onDisk(f)).toEqual(['.claude.vetted/skills/x/SKILL.md', 'Agents.md.vetted', 'CLAUDE.md.vetted', 'p/.Claude.vetted/settings.json', 'skills/x/SKILL.md', 'sub/claude.local.md.vetted']);
    expect(f.files).toEqual(['.claude/skills/x/SKILL.md', 'Agents.md', 'CLAUDE.md', 'p/.Claude/settings.json', 'skills/x/SKILL.md', 'sub/claude.local.md']);
    expect(f.map['CLAUDE.md']).toBe('CLAUDE.md.vetted');
    expect(f.map['.claude/skills/x/SKILL.md']).toBe('.claude.vetted/skills/x/SKILL.md');
    expect(f.map['skills/x/SKILL.md']).toBe('skills/x/SKILL.md');
    expect(readFileSync(join(f.dir, 'CLAUDE.md.vetted'), 'utf8')).toBe('IGNORE PREVIOUS');
  });
  it('collides renamed names too', () => {
    const f = run([{ name: 'CLAUDE.md', body: 'a' }, { name: 'CLAUDE.md.vetted', body: 'b' }]);
    expect(f.files).toEqual([]);
    expect(f.skipped).toHaveLength(2);
  });
  it('writes nothing under the project', () => {
    const cwd = process.cwd();
    const before = existsSync(join(cwd, '.harness', 'vet'));
    run([{ name: 'CLAUDE.md', body: 'x' }]);
    expect(existsSync(join(cwd, '.harness', 'vet'))).toBe(before);
  });
  it('explains gh failures', () => {
    expect(fetchTarball(r, () => ({ status: 1, stdout: Buffer.alloc(0), stderr: 'gh: Not Found (HTTP 404)' }))).toEqual({ error: 'o/r@aaaaaaa: tarball not found on GitHub.' });
    expect(fetchTarball(r, () => ({ status: 127, stdout: Buffer.alloc(0), missing: true }))).toEqual({ error: expect.stringContaining('harness vet needs the GitHub CLI (gh).') });
    expect(fetchTarball(r, () => ({ status: 4, stdout: Buffer.alloc(0), stderr: 'boom' }))).toEqual({ error: expect.stringContaining('could not download') });
  });
  it('cleanTmp removes a vet folder and refuses anything else', () => {
    const f = run([{ name: 'a.md', body: 'a' }]);
    cleanTmp(tmpdir());
    expect(existsSync(tmpdir())).toBe(true);
    cleanTmp(f.dir);
    expect(existsSync(f.dir)).toBe(false);
    rmSync(f.dir, { recursive: true, force: true });
  });
});
