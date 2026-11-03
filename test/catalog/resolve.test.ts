import { expect, test } from 'vitest';
import { resolvePins } from '../../src/catalog/resolve.js';
import type { Exec } from '../../src/core/exec.js';
import type { Catalog, CatalogItem } from '../../src/catalog/schema.js';

const SHA = 'a'.repeat(40);
const item = (id: string, source: CatalogItem['source']): CatalogItem => ({
  id, kind: 'plugin', title: id, source, license: 'MIT', min_claude_code: '2.1.0', applies_when: { always: true }, conflicts_with: [], requires: [],
  cost: { context: 'low', setup: 'none' }, stance: 'optional', stance_reason: '', side_effects: [], why: 'w', evidence: [],
});
const cat = (...items: CatalogItem[]): Catalog => ({ version: 1, items });
const fake = (answer: (cmd: string, args: string[]) => ReturnType<Exec>) => {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => (calls.push([cmd, ...args]), answer(cmd, args));
  return { exec, calls };
};
const gh = (n: string) => item(n, { type: 'github', repo: 'o/r', plugin: n, sha: SHA });

test('github pin resolves', () => {
  const { exec, calls } = fake(() => ({ status: 0, stdout: `${SHA}\n` }));
  const r = resolvePins(cat(gh('p')), exec);
  expect(calls).toEqual([['gh', 'api', `repos/o/r/commits/${SHA}`, '--jq', '.sha']]);
  expect(r).toEqual({ problems: [], unpinned: [] });
});

test('git-subdir pin also checks the path', () => {
  const { exec, calls } = fake((_c, a) => ({ status: 0, stdout: a[1].includes('/contents/') ? 'dir\n' : SHA }));
  const r = resolvePins(cat(item('p', { type: 'git-subdir', repo: 'o/r', path: 'plugins/p', plugin: 'p', sha: SHA })), exec);
  expect(calls[1]).toEqual(['gh', 'api', `repos/o/r/contents/plugins/p?ref=${SHA}`, '--jq', '.type']);
  expect(r.problems).toEqual([]);
});

test('git-subdir path that is not a dir is a problem', () => {
  const { exec } = fake((_c, a) => ({ status: 0, stdout: a[1].includes('/contents/') ? 'file' : SHA }));
  expect(resolvePins(cat(item('p', { type: 'git-subdir', repo: 'o/r', path: 'x', plugin: 'p', sha: SHA })), exec).problems).toEqual([`p: path x is not a directory in o/r at ${SHA}`]);
});

test('npm pin resolves', () => {
  const { exec, calls } = fake(() => ({ status: 0, stdout: '1.2.3\n' }));
  const r = resolvePins(cat(item('m', { type: 'npm', package: 'pkg', version: '1.2.3' })), exec);
  expect(calls).toEqual([['npm', 'view', 'pkg@1.2.3', 'version']]);
  expect(r.problems).toEqual([]);
  expect(resolvePins(cat(item('m', { type: 'npm', package: 'pkg', version: '1.2.4' })), exec).problems).toEqual(['m: pkg@1.2.4 not found on npm']);
});

test('unpinned items are listed with their reason', () => {
  const { exec, calls } = fake(() => ({ status: 0, stdout: '' }));
  const r = resolvePins(cat(item('r', { type: 'remote', url: 'https://x.dev/mcp', unpinned: 'hosted service' })), exec);
  expect(calls).toEqual([]);
  expect(r).toEqual({ problems: [], unpinned: [{ id: 'r', reason: 'hosted service' }] });
});

test('a 404 names the item and the source', () => {
  const { exec } = fake(() => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }));
  const r = resolvePins(cat(item('gsap-skills', { type: 'github', repo: 'greensock/gsap-skills', plugin: 'g', sha: SHA })), exec);
  expect(r.problems).toEqual([`gsap-skills: commit ${SHA} not found in greensock/gsap-skills`]);
});

test('gh missing is one problem', () => {
  const { exec } = fake(() => ({ status: 127, stdout: '', missing: true }));
  expect(resolvePins(cat(gh('a'), gh('b')), exec).problems).toEqual(['gh not found on PATH; install GitHub CLI to check pins']);
});

test('only limits which items are checked and unknown ids are problems', () => {
  const { exec, calls } = fake(() => ({ status: 0, stdout: SHA }));
  const r = resolvePins(cat(gh('a'), gh('b')), exec, ['b', 'zz']);
  expect(calls).toHaveLength(1);
  expect(r.problems).toEqual(['--only: no catalog item "zz"']);
});

test('a non-404 failure is "could not verify", not "not found"', () => {
  const { exec } = fake(() => ({ status: 1, stdout: '', stderr: 'HTTP 403: rate limit exceeded\nmore' }));
  expect(resolvePins(cat(gh('a')), exec).problems).toEqual([`a: could not verify commit ${SHA} in o/r (gh exited 1): HTTP 403: rate limit exceeded`]);
  const npm = item('m', { type: 'npm', package: 'pkg', version: '1.2.3' });
  const net = fake(() => ({ status: 1, stdout: '', stderr: 'npm ERR! network timeout' }));
  expect(resolvePins(cat(npm), net.exec).problems).toEqual(['m: could not verify pkg@1.2.3 (npm exited 1): npm ERR! network timeout']);
  const gone = fake(() => ({ status: 1, stdout: '', stderr: 'npm ERR! code E404' }));
  expect(resolvePins(cat(npm), gone.exec).problems).toEqual(['m: pkg@1.2.3 not found on npm']);
});

test('git-subdir path segments are URL-encoded', () => {
  const { exec, calls } = fake((_c, a) => ({ status: 0, stdout: a[1].includes('/contents/') ? 'dir' : SHA }));
  resolvePins(cat(item('p', { type: 'git-subdir', repo: 'o/r', path: 'a b/c?d', plugin: 'p', sha: SHA })), exec);
  expect(calls[1][2]).toBe(`repos/o/r/contents/a%20b/c%3Fd?ref=${SHA}`);
});
