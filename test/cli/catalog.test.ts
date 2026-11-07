import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
source: { type: github, repo: o/r, plugin: ${id}, sha: ${SHA} }
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
  const remote = y('r').replace(/source:.*/, 'source: { type: remote, url: "https://x.dev/m", unpinned: hosted }').replace('kind: plugin', 'kind: mcp') + 'unpinned_runtime: hosted\nmcp: { name: r, config: { command: x } }\n';
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

test('bare catalog prints the load errors and exits 1', () => {
  const r = go([], dir({ bad: 'id: bad\n' }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('bad.yaml');
  expect(r.out).not.toContain('catalog_version');
});

test('check also checks shipped presets, prefixed presets/<id>: ', () => {
  const d = dir({ a: y('a') });
  mkdirSync(join(d, 'presets'));
  cpSync('test/fixtures/presets', join(d, 'presets'), { recursive: true });
  const r = go(['check'], d);
  expect(r.code).toBe(1);
  expect(r.out).toContain('presets/tiny: ');
});

// --context
import { readFileSync, renameSync } from 'node:fs';
import { tarGz } from '../fixtures/vet/tar.js';
import type { ExecBytes } from '../../src/core/exec.js';
import { measureItemContext } from '../../src/catalog/context-check.js';
const tarEx: ExecBytes = () => ({ status: 0, stdout: tarGz([{ name: 'skills/s/SKILL.md', body: '---\nname: s\ndescription: Does a useful thing for you.\n---\nBody.\n' }]) });
const pin: Exec = () => ({ status: 0, stdout: SHA });
const goCtx = (args: string[], d: string, eb: ExecBytes = tarEx) => {
  const lines: string[] = [];
  const code = catalog(args, { root: '/', env: {}, out: (s) => lines.push(s) }, { dir: d, exec: pin, execBytes: eb });
  return { code, out: lines.join('\n') };
};
const measured = (measureItemContext({ kind: 'plugin', source: { type: 'github', repo: 'o/r', plugin: 'a', sha: SHA } } as never, tarEx) as { tokens: number }).tokens;
const withTokens = (n: number | null) => y('a').replace('cost: { context: low, setup: none }', `cost: { context: low, setup: none, context_tokens: ${n} }`);

test('catalog check --context: equal passes, unequal is a mismatch, missing and null are listed', () => {
  expect(goCtx(['check', '--resolve', '--context'], dir({ a: withTokens(measured) }))).toEqual({ code: 0, out: '' });
  const bad = goCtx(['check', '--resolve', '--context'], dir({ a: withTokens(measured + 1) }));
  expect(bad).toEqual({ code: 1, out: `a: cost.context_tokens is ${measured + 1}, measured ${measured} at bbbbbbb` });
  for (const t of [y('a'), withTokens(null)]) expect(goCtx(['check', '--resolve', '--context'], dir({ a: t }))).toEqual({ code: 0, out: 'Not measured:\n  a' });
});

test('catalog check --context skips mcp and own items, and a fetch error is "could not verify"', () => {
  const mcp = y('m').replace(/source:.*/, 'source: { type: remote, url: "https://x.dev/m", unpinned: hosted }').replace('kind: plugin', 'kind: mcp') + 'unpinned_runtime: hosted\nmcp: { name: m, config: { command: x } }\n';
  expect(goCtx(['check', '--resolve', '--context'], dir({ m: mcp })).out).toBe('Unpinned:\n  m: hosted');
  const r = goCtx(['check', '--resolve', '--context'], dir({ a: withTokens(5) }), () => ({ status: 1, stdout: Buffer.alloc(0), stderr: 'HTTP 500' }));
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/^a: could not verify cost\.context_tokens: /);
  expect(r.out).not.toMatch(/measured/);
});

test('--write-context rewrites only the cost line; usage errors', () => {
  const d = dir({ a: y('a') });
  const file = join(d, 'items', 'a.yaml');
  const before = readFileSync(file, 'utf8');
  expect(goCtx(['check', '--resolve', '--context', '--write-context'], d)).toEqual({ code: 0, out: `a: cost.context_tokens none -> ${measured} at bbbbbbb` });
  expect(readFileSync(file, 'utf8')).toBe(before.replace('setup: none }', `setup: none, context_tokens: ${measured} }`));
  expect(goCtx(['check', '--resolve', '--context'], d)).toEqual({ code: 0, out: '' });
  expect(goCtx(['check', '--resolve', '--write-context'], d)).toEqual({ code: 2, out: 'Usage: --write-context needs --context' });
  expect(goCtx(['check', '--context'], d).code).toBe(2);
});

test('--write-context prints an overwrite, and reports an unrewritable or missing file instead of crashing', () => {
  const d = dir({ a: withTokens(1) });
  expect(goCtx(['check', '--resolve', '--context', '--write-context'], d).out).toBe(`a: cost.context_tokens 1 -> ${measured} at bbbbbbb`);
  const odd = dir({ a: y('a').replace('cost: { context: low, setup: none }', 'cost: &c { context: low, setup: none }') });
  const before = readFileSync(join(odd, 'items', 'a.yaml'), 'utf8');
  expect(goCtx(['check', '--resolve', '--context', '--write-context'], odd)).toEqual({ code: 1, out: 'a: could not rewrite cost line' });
  expect(readFileSync(join(odd, 'items', 'a.yaml'), 'utf8')).toBe(before);
  const renamed = dir({ a: y('a') });
  renameSync(join(renamed, 'items', 'a.yaml'), join(renamed, 'items', 'b.yaml'));
  const r = goCtx(['check', '--resolve', '--context', '--write-context'], renamed);
  expect(r.code).toBe(1);
  expect(r.out).toContain('a: items/a.yaml not found, could not rewrite cost line');
});
