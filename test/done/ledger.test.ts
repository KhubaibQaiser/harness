import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type Contract, contractHash } from '../../src/done/contract.js';
import { appendRow, type BlockedRow, freshEvidence, latestBlocked, LEDGER, readLedger, type RunRow } from '../../src/done/ledger.js';

const base: Contract = {
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [
    { id: 'C1', text: 'it works', check: { test: 'test/a.test.ts::a works' } },
    { id: 'C2', text: 'builds', check: { run: 'node build.mjs', expect_exit: 0 } },
    { id: 'C3', text: 'looks right', check: { person: 'open the login page' } },
  ],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};
const c: Contract = { ...base, sha256: contractHash(base) };
const T = 'b'.repeat(40);
const run = (patch: Partial<RunRow> = {}): RunRow => ({ kind: 'run', ts: '2026-11-14T00:00:00Z', session: 's', command: 'pnpm run test', exit: 0, tree: T, contract: c.sha256!, criteria: [], ...patch });
const blocked = (patch: Partial<BlockedRow> = {}): BlockedRow => ({ kind: 'blocked', ts: '2026-11-14T00:00:00Z', session: 's', task: c.id, reason: 'r', failing_criteria: ['C1'], tree: T, contract: c.sha256!, ...patch });
const argvOf = (name: string) => (name === 'test' ? ['pnpm', 'run', 'test'] : null);
const ids = (r: ReturnType<typeof freshEvidence>) => r.gaps.map((g) => `${g.kind}:${g.id}`);

test('freshEvidence: a row from an older tree or contract hash is a gap; person criteria never are', () => {
  expect(ids(freshEvidence(c, [], T, argvOf))).toEqual(['check:test', 'criterion:C1', 'criterion:C2']);
  const stale = [run({ tree: 'c'.repeat(40), criteria: ['C1', 'C2'] }), run({ contract: 'd'.repeat(64), criteria: ['C1', 'C2'] })];
  expect(ids(freshEvidence(c, stale, T, argvOf))).toEqual(['check:test', 'criterion:C1', 'criterion:C2']);
  const r = freshEvidence(c, [run({ criteria: ['C1'] }), run({ command: 'node build.mjs', criteria: ['C2'] })], T, argvOf);
  expect(r.gaps).toEqual([]);
  expect([...r.pass.keys()]).toEqual(['check:test', 'criterion:C1', 'criterion:C2']);
  expect(r.pass.get('criterion:C2')!.command).toBe('node build.mjs');
});

test('freshEvidence: a check passes only on its exact argv with exit 0; an unknown exit never passes', () => {
  for (const row of [run({ exit: 1 }), run({ exit: null }), run({ command: 'pnpm test' }), run({ command: 'pnpm run test --watch' })])
    expect(ids(freshEvidence(c, [row], T, argvOf))).toContain('check:test');
  expect(freshEvidence(c, [run({ command: "pnpm run 'test'" })], T, argvOf).pass.has('check:test')).toBe(true);
  // A check with no resolvable command never passes, and its gap names it.
  expect(freshEvidence(c, [run()], T, () => null).gaps[0]).toEqual({ kind: 'check', id: 'test', label: 'test' });
});

test('freshEvidence: gap labels are the commands to run (F14)', () => {
  expect(freshEvidence(c, [], T, argvOf).gaps.map((g) => g.label)).toEqual(['pnpm run test', 'test/a.test.ts::a works', 'node build.mjs']);
});

test('latestBlocked: the newest fresh blocked row of this task', () => {
  expect(latestBlocked([], c, T)).toBeNull();
  expect(latestBlocked([blocked({ tree: 'c'.repeat(40) }), blocked({ task: 'other' }), blocked({ contract: 'e'.repeat(64) }), run()], c, T)).toBeNull();
  expect(latestBlocked([blocked({ reason: 'one' }), run(), blocked({ reason: 'two' })], c, T)!.reason).toBe('two');
});

test('readLedger: rows round-trip through appendRow; malformed lines are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-ledger-'));
  expect(readLedger(root)).toEqual([]);
  appendRow(root, run());
  appendFileSync(join(root, LEDGER), 'not json\n{"kind":"run"}\n{"kind":"other","tree":"x","contract":"y"}\n[]\n');
  appendRow(root, blocked());
  expect(readLedger(root)).toEqual([run(), blocked()]);
});
