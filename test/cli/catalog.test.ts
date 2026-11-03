import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { catalog } from '../../src/cli/catalog.js';
import type { Exec } from '../../src/core/exec.js';
import { packageDir } from '../../src/core/package-dir.js';

const SHA = 'b'.repeat(40);
const y = (id: string, extra = '') => `id: ${id}
kind: plugin
title: T
source: { type: github, repo: o/r, plugin: p, sha: ${SHA} }
license: MIT
min_claude_code: 2.1.0
applies_when: { always: true }
cost: { context: low, setup: none }
stance: optional
why: w
${extra}`;
function dir(items: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'harness-cli-cat-'));
  mkdirSync(join(d, 'items'));
  writeFileSync(join(d, 'catalog.yaml'), 'version: 1\n');
  for (const [id, text] of Object.entries(items)) writeFileSync(join(d, 'items', `${id}.yaml`), text);
  return d;
}
const go = (args: string[], d: string, exec?: Exec) => {
  const lines: string[] = [];
  const code = catalog(args, { root: '/', env: {}, out: (s) => lines.push(s) }, { dir: d, exec });
  return { code, out: lines.join('\n') };
};

afterEach(() => {
  delete process.env.HARNESS_CATALOG_DIR;
  delete process.env.HARNESS_PLAIN_INIT;
});

test('catalog prints compact JSON with catalog_version 1', () => {
  const r = go([], dir({ a: y('a') }));
  expect(r.code).toBe(0);
  const j = JSON.parse(r.out);
  expect(j.catalog_version).toBe(1);
  expect(j.items.map((i: { id: string }) => i.id)).toEqual(['a']);
  expect(j.items[0].source).toBeUndefined();
});

test('catalog check exits 1 and prints each problem', () => {
  const r = go(['check'], dir({ a: y('a', 'requires: [x]'), b: y('b', 'requires: [y]') }));
  expect(r.code).toBe(1);
  expect(r.out.split('\n')).toEqual(['a: requires "x", which is not in the catalog', 'b: requires "y", which is not in the catalog']);
  expect(go(['check'], dir({ a: y('a') })).code).toBe(0);
});

test('catalog check --resolve prints unpinned items and --only filters', () => {
  const remote = y('r').replace(/source:.*/, 'source: { type: remote, url: "https://x.dev/m", unpinned: hosted }').replace('kind: plugin', 'kind: mcp') + 'mcp: { name: r, config: { command: x } }\n';
  const d = dir({ a: y('a'), r: remote });
  const r = go(['check', '--resolve'], d, () => ({ status: 0, stdout: SHA }));
  expect(r.code).toBe(0);
  expect(r.out).toBe('Unpinned:\n  r: hosted');
  const bad = go(['check', '--resolve', '--only', 'a'], d, () => ({ status: 1, stdout: '', stderr: 'HTTP 404' }));
  expect(bad.code).toBe(1);
  expect(bad.out).toBe(`a: commit ${SHA} not found in o/r`);
});

test('catalog rejects bad arguments', () => {
  expect(go(['check', '--only'], dir({})).code).toBe(2);
  expect(go(['nope'], dir({})).code).toBe(2);
  expect(go(['check', '--resolve', '--only', ','], dir({}), () => ({ status: 0, stdout: '' })).code).toBe(2);
});

test('catalog works without CLAUDECODE and through run()', () => {
  const lines: string[] = [];
  expect(run(['catalog'], { root: '/', env: { CLAUDECODE: '1' }, out: (s) => lines.push(s) })).toBe(0);
  expect(JSON.parse(lines[0]).catalog_version).toBe(1);
  const plain: string[] = [];
  expect(run(['catalog'], { root: '/', env: {}, out: (s) => plain.push(s) })).toBe(0);
});

test('HARNESS_CATALOG_DIR is ignored without HARNESS_PLAIN_INIT', () => {
  process.env.HARNESS_CATALOG_DIR = '/elsewhere';
  expect(packageDir('catalog')).not.toBe('/elsewhere');
  process.env.HARNESS_PLAIN_INIT = '1';
  expect(packageDir('catalog')).toBe('/elsewhere');
});
