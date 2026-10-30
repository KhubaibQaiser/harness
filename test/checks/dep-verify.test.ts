import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseNpmView, verifyPackages } from '../../src/checks/dep-verify.js';

type Look = Parameters<typeof verifyPackages>[1]['lookup'];
const NOW = new Date('2026-10-31T00:00:00Z');
const OLD = { exists: true, created: '2020-01-01T00:00:00.000Z' };
const repo = (files: Record<string, object> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'dep-verify-'));
  for (const [p, json] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), JSON.stringify(json));
  }
  return root;
};
const run = (names: string[], lookup: Look, root = repo()) => verifyPackages(names, { root, now: NOW, lookup });
const reason = (d: ReturnType<typeof run>) => ('reason' in d ? d.reason : '');

test('a name missing from the registry is denied', () => {
  const d = run(['zzz-nope'], () => ({ exists: false }));
  expect(d.kind).toBe('deny');
  expect(reason(d)).toBe('"zzz-nope" is not on the npm registry (possibly a hallucinated name).');
});

test('under 14 days old is denied, exactly 14 is not', () => {
  const young = run(['fresh'], () => ({ exists: true, created: '2026-10-18T00:00:01Z' })); // 12.99 days -> 12
  expect(young.kind).toBe('deny');
  expect(reason(young)).toBe('"fresh" was first published 12 days ago; packages under 14 days old are blocked.');
  expect(run(['edge'], () => ({ exists: true, created: '2026-10-17T00:00:00Z' })).kind).toBe('ask'); // 14 days
  expect(run(['edge'], () => ({ exists: true, created: '2026-10-17T00:00:01Z' })).kind).toBe('deny'); // 13.99 -> 13
});

test('near-duplicate of a dependency in any package.json asks', () => {
  const root = repo({
    'package.json': { dependencies: { lodash: '1' } },
    'apps/web/package.json': { devDependencies: { Zod: '3' }, peerDependencies: { react: '1' }, optionalDependencies: { chalk: '1' } },
  });
  const d = run(['lodsah'], () => OLD, root);
  expect(d.kind).toBe('ask');
  expect(reason(d)).toBe('"lodsah" looks like "lodash" already in this repo. Confirm it isn\'t a typo.');
  expect(reason(run(['zodd'], () => OLD, root))).toContain('"Zod"'); // case-insensitive, reports repo spelling
  expect(reason(run(['chalks'], () => OLD, root))).toContain('"chalk"');
  expect(reason(run(['reakt'], () => OLD, root))).toContain('"react"');
});

test('a name already in the repo (any case) is not a near-duplicate', () => {
  const root = repo({ 'package.json': { dependencies: { react: '1', preact: '1', Zod: '3' } } });
  expect(reason(run(['react'], () => OLD, root))).toBe('Confirm adding react.');
  expect(reason(run(['zod'], () => OLD, root))).toBe('Confirm adding zod.');
});

test('package.json files under node_modules are ignored (walk fallback)', () => {
  const root = repo({ 'node_modules/x/package.json': { dependencies: { lodash: '1' } } });
  expect(reason(run(['lodsah'], () => OLD, root))).toBe('Confirm adding lodsah.');
});

test('git ls-files finds nested package.json', () => {
  const root = repo({ 'a/b/package.json': { dependencies: { lodash: '1' } } });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', 'a/b/package.json'], { cwd: root });
  expect(reason(run(['lodsah'], () => OLD, root))).toContain('"lodash"');
});

test('lookup error asks with could not verify', () => {
  const d = run(['flaky'], () => 'error');
  expect(d.kind).toBe('ask');
  expect(reason(d)).toContain('could not verify on the registry');
});

test('unparseable created date asks instead of passing', () => {
  expect(reason(run(['odd'], () => ({ exists: true, created: 'nonsense' })))).toContain('could not verify on the registry');
});

test('clean packages ask for plain confirmation', () => {
  const d = run(['left-pad', 'express'], () => OLD);
  expect(d.kind).toBe('ask');
  expect(reason(d)).toBe('Confirm adding left-pad, express.');
});

test('strips version specifiers before lookup', () => {
  const seen: string[] = [];
  run(['zod@3', '@scope/pkg@^1', '@scope/bare'], (n) => (seen.push(n), OLD));
  expect(seen).toEqual(['zod', '@scope/pkg', '@scope/bare']);
});

test('specs the registry cannot resolve ask without a lookup', () => {
  const specs = ['file:../x', 'link:../x', 'workspace:*', 'git+https://h/r.git', 'github:o/r', 'https://h/t.tgz', 'http://h/t.tgz', './x', '/abs/x'];
  for (const s of specs) {
    const d = run([s], () => { throw new Error('lookup must not run'); });
    expect(d.kind, s).toBe('ask');
    expect(reason(d), s).toContain('could not verify on the registry');
  }
});

test('several names: all checked, deny beats ask, asks join with "; "', () => {
  const look: Look = (n) => (n === 'ghost' ? { exists: false } : n === 'flaky' ? 'error' : OLD);
  const mixed = run(['flaky', 'ghost', 'fine'], look);
  expect(mixed.kind).toBe('deny');
  expect(reason(mixed)).toContain('"ghost" is not on the npm registry');
  expect(reason(mixed)).not.toContain('flaky');
  const root = repo({ 'package.json': { dependencies: { lodash: '1' } } });
  const asks = run(['flaky', 'lodsah', 'fine'], look, root);
  expect(asks.kind).toBe('ask');
  expect(reason(asks)).toBe('"flaky": could not verify on the registry; "lodsah" looks like "lodash" already in this repo. Confirm it isn\'t a typo.');
});

test('parseNpmView reads npm output', () => {
  expect(parseNpmView('"2020-01-01T00:00:00.000Z"\n', '')).toEqual({ exists: true, created: '2020-01-01T00:00:00.000Z' });
  expect(parseNpmView('', 'npm error code E404\nnpm error 404 Not Found')).toEqual({ exists: false });
  expect(parseNpmView('{"error":{"code":"E404"}}', '')).toEqual({ exists: false });
  expect(parseNpmView('', 'npm error code ETIMEDOUT')).toBe('error');
  expect(parseNpmView('garbage', '')).toBe('error');
});
