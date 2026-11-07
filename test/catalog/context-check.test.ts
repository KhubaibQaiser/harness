import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { measureItemContext, setContextTokens } from '../../src/catalog/context-check.js';
import type { CatalogItem } from '../../src/catalog/schema.js';
import type { ExecBytes } from '../../src/core/exec.js';
import { tarGz } from '../fixtures/vet/tar.js';

const SHA = 'b'.repeat(40);
const item = (source: unknown, kind = 'plugin') => ({ id: 'a', kind, source }) as unknown as CatalogItem;
const tar: ExecBytes = () => ({ status: 0, stdout: tarGz([{ name: 'skills/s/SKILL.md', body: '---\nname: s\ndescription: Does a useful thing for you.\n---\nBody text here.\n' }]) });
const tmps = () => readdirSync(tmpdir()).filter((n) => n.startsWith('harness-vet-')).length;

test('measures tokens at the pinned sha and cleans the temp folder', () => {
  const calls: string[][] = [];
  const before = tmps();
  const r = measureItemContext(item({ type: 'github', repo: 'o/r', plugin: 'a', sha: SHA }), (c, a, m) => (calls.push(a), tar(c, a, m)));
  expect(r).toSatisfy((x: { tokens?: number }) => Number.isInteger(x.tokens) && x.tokens! > 0);
  expect(calls[0]).toEqual(['api', `repos/o/r/tarball/${SHA}`]);
  expect(tmps()).toBe(before);
});

test('a fetch error is returned as an error, and nothing is left behind', () => {
  const before = tmps();
  const r = measureItemContext(item({ type: 'git-subdir', repo: 'o/r', path: 'p', plugin: 'a', sha: SHA }), () => ({ status: 1, stdout: Buffer.alloc(0), stderr: 'HTTP 500' }));
  expect(r).toHaveProperty('error');
  expect(tmps()).toBe(before);
});

const T = { block: 'cost:\n  context: low\n  setup: none\nstance: x\n', spaced: 'cost: {"context": "low", "setup": "low"}\nstance: x\n', compact: 'cost: {"context":"low","setup":"low"}\nstance: x\n', bare: 'cost: { context: low, setup: none }\nstance: x\n' };
test.each([
  ['block', 'cost:\n  context: low\n  setup: none\n  context_tokens: 42\nstance: x\n'],
  ['spaced', 'cost: {"context": "low", "setup": "low", "context_tokens": 42}\nstance: x\n'],
  ['compact', 'cost: {"context":"low","setup":"low","context_tokens":42}\nstance: x\n'],
  ['bare', 'cost: { context: low, setup: none, context_tokens: 42 }\nstance: x\n'],
] as const)('adds context_tokens to a %s cost, changing only that line', (k, want) => {
  expect(setContextTokens(T[k], 42)).toBe(want);
});

test.each([
  ['block', 'cost:\n  context: low\n  context_tokens: null\n  setup: none\nstance: x\n', 'cost:\n  context: low\n  context_tokens: 7\n  setup: none\nstance: x\n'],
  ['spaced', 'cost: {"context": "low", "context_tokens": null, "setup": "low"}\nstance: x\n', 'cost: {"context": "low", "context_tokens": 7, "setup": "low"}\nstance: x\n'],
  ['compact', 'cost: {"context":"low","setup":"low","context_tokens":123}\nstance: x\n', 'cost: {"context":"low","setup":"low","context_tokens":7}\nstance: x\n'],
])('replaces an existing %s value', (_k, from, want) => {
  expect(setContextTokens(from, 7)).toBe(want);
});
