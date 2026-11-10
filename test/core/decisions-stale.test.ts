import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { TeamDecision } from '../../src/core/decision-file.js';
import { isStale, staleness, type Git } from '../../src/core/decisions-stale.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
const repo = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'stale-'));
  roots.push(r);
  git(r, 'init', '-q');
  return r;
};
const put = (r: string, rel: string, text = 'x'): void => {
  mkdirSync(dirname(join(r, rel)), { recursive: true });
  writeFileSync(join(r, rel), text);
};
const commit = (r: string, msg: string): string => { git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', msg); return git(r, 'rev-parse', 'HEAD'); };
const dec = (over: Partial<TeamDecision> = {}): TeamDecision => ({
  id: '2026-11-01-a', title: 't', status: 'active', paths: ['src/**'], verified_at: 'a'.repeat(40), verified_on: '2026-11-01',
  body: 'b', rel: 'docs/decisions/2026-11-01-a.md', ...over,
});
const O = { today: '2026-11-10', expiryDays: 90, cap: 20 };

describe('staleness', () => {
  test('a glob matching nothing is dead', () => {
    const r = repo(); put(r, 'src/a.ts'); const sha = commit(r, 'c');
    const { states, note } = staleness(r, [dec({ verified_at: sha, paths: ['src/**', 'lib/**'] })], O);
    expect(note).toBeNull();
    expect(states[0]!.dead).toEqual(['lib/**']);
    expect(isStale(states[0]!)).toBe(true);
  });
  test('a linked file changed after verified_at is changed', () => {
    const r = repo(); put(r, 'src/a.ts'); put(r, 'docs/decisions/2026-11-01-a.md');
    const sha = commit(r, 'one'); put(r, 'src/a.ts', 'y'); put(r, 'other.ts'); commit(r, 'two');
    const s = staleness(r, [dec({ verified_at: sha })], O).states[0]!;
    expect(s).toMatchObject({ changed: ['src/a.ts'], ref: sha, fallback: false, dead: [] });
  });
  test('a decision committed with its code is not changed (C5)', () => {
    const r = repo(); put(r, 'src/a.ts'); const base = commit(r, 'base');
    put(r, 'src/a.ts', 'y'); put(r, 'docs/decisions/2026-11-01-a.md'); const head = commit(r, 'code and decision');
    const s = staleness(r, [dec({ verified_at: base })], O).states[0]!;
    expect(s.changed).toEqual([]);
    expect(s.ref).toBe(head);
    expect(s.fallback).toBe(false);
  });
  test('the decision file never counts as changed', () => {
    const r = repo(); put(r, 'docs/decisions/2026-11-01-a.md'); const sha = commit(r, 'one'); put(r, 'src/a.ts');
    commit(r, 'two');
    const s = staleness(r, [dec({ verified_at: sha, paths: ['**/*.ts', 'docs/decisions/*.md'] })], O).states[0]!;
    expect(s.changed).toEqual(['src/a.ts']);
  });
  test('a verified_at not in the clone falls back to the file commit (C4)', () => {
    const r = repo(); put(r, 'src/a.ts'); put(r, 'docs/decisions/2026-11-01-a.md'); const first = commit(r, 'one');
    put(r, 'src/a.ts', 'y'); commit(r, 'two');
    const s = staleness(r, [dec()], O).states[0]!;
    expect(s).toMatchObject({ fallback: true, ref: first, changed: ['src/a.ts'] });
  });
  test('a non-git folder gives the note and no throw', () => {
    const d = mkdtempSync(join(tmpdir(), 'nogit-')); roots.push(d);
    const { states, note } = staleness(d, [dec()], O);
    expect(note).toMatch(/^couldn't check decision staleness \(.+\)$/);
    expect(states[0]).toMatchObject({ dead: [], changed: [] });
  });
  test('expiry is strictly more than expiryDays', () => {
    const r = repo(); put(r, 'src/a.ts'); const sha = commit(r, 'c');
    const at = (on: string) => staleness(r, [dec({ verified_at: sha, verified_on: on })], O).states[0]!.expired;
    expect(at('2026-08-12')).toBe(false); // 90 days
    expect(at('2026-08-11')).toBe(true); // 91 days
  });
  test('a 21-line rule over a cap of 20 is oversized', () => {
    const r = repo(); put(r, 'src/a.ts'); const sha = commit(r, 'c');
    const body = Array.from({ length: 16 }, (_, i) => `l${i}`).join('\n');
    const s = staleness(r, [dec({ verified_at: sha, body })], O).states[0]!;
    expect(s.oversized).toEqual({ lines: 21 });
    expect(staleness(r, [dec({ verified_at: sha })], O).states[0]!.oversized).toBeNull();
  });
  test('a failing Git gives the note, no throw, and time-based states still compute', () => {
    const bad: Git = () => ({ ok: false, out: '', reason: 'timeout' });
    const { states, note } = staleness('/x', [dec({ verified_on: '2020-01-01' })], { ...O, git: bad });
    expect(note).toBe("couldn't check decision staleness (timeout)");
    expect(states[0]).toMatchObject({ dead: [], changed: [], expired: true });
  });
  test('one ls-files and one diff per distinct ref', () => {
    const r = repo(); put(r, 'src/a.ts'); put(r, 'docs/decisions/2026-11-01-a.md'); put(r, 'docs/decisions/2026-11-01-b.md');
    const sha = commit(r, 'one'); put(r, 'src/a.ts', 'y'); commit(r, 'two');
    const calls: string[][] = [];
    const spy: Git = (a) => {
      calls.push(a);
      try { return { ok: true, out: git(r, ...a) }; } catch { return { ok: false, out: '' }; }
    };
    const ds = [dec({ verified_at: sha }), dec({ id: '2026-11-01-b', rel: 'docs/decisions/2026-11-01-b.md', verified_at: sha })];
    staleness(r, ds, { ...O, git: spy });
    expect(calls.filter((c) => c[2] === 'ls-files')).toHaveLength(1);
    expect(calls.filter((c) => c[2] === 'diff')).toHaveLength(1);
  });
  test('a timeout on cat-file or merge-base is a git failure, not a "no"', () => {
    for (const cmd of ['cat-file', 'merge-base']) {
      const g: Git = (a) => a.includes(cmd) ? { ok: false, out: '', reason: 'timeout' }
        : a.includes('ls-files') ? { ok: true, out: 'src/a.ts\0' } : a.includes('log') ? { ok: true, out: 'b'.repeat(40) } : { ok: true, out: '' };
      const r = staleness('/x', [dec()], { ...O, git: g });
      expect(r.note).toBe("couldn't check decision staleness (timeout)");
      expect(r.states[0]).toMatchObject({ ref: '', fallback: false, changed: [] });
    }
  });
  test('a large ls-files output works', () => {
    const big = Array.from({ length: 60_000 }, (_, i) => `src/dir${i}/some-long-file-name-${i}.ts`).join('\0') + '\0';
    expect(big.length).toBeGreaterThan(2_000_000);
    const g: Git = (a) => a.includes('ls-files') ? { ok: true, out: big } : a.includes('log') ? { ok: true, out: '' } : { ok: false, out: '' };
    const r = staleness('/x', [dec()], { ...O, git: g });
    expect(r.note).toBeNull();
    expect(r.states[0]).toMatchObject({ dead: [], ref: '', fallback: false });
  });
  test('every git call disables fsmonitor; diff also disables ext-diff and textconv', () => {
    const r = repo(); put(r, 'src/a.ts'); put(r, 'docs/decisions/2026-11-01-a.md'); const sha = commit(r, 'one');
    put(r, 'src/a.ts', 'y'); commit(r, 'two');
    const calls: string[][] = [];
    const spy: Git = (a) => { calls.push(a); try { return { ok: true, out: git(r, ...a) }; } catch { return { ok: false, out: '' }; } };
    staleness(r, [dec({ verified_at: sha })], { ...O, git: spy });
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
    expect(calls.find((c) => c[2] === 'diff')).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
  });
});
