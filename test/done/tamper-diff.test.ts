import { rmSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { contractHash, type Contract } from '../../src/done/contract.js';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { diffTamper, isHarnessOwned, scriptChanges, WORKFLOW_PATH } from '../../src/done/tamper-diff.js';
import { git, repoWith, type Files } from '../review/repo.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const run = (base: Files, head: Files, o: Parameters<typeof diffTamper>[4] = { checkNames: ['test'] }, exec: Exec = defaultExec) => {
  const r = repoWith(base, head);
  dirs.push(r.root);
  return diffTamper(r.root, exec, r.base, r.head, o);
};
const findings = (base: Files, head: Files, o?: Parameters<typeof diffTamper>[4]) => run(base, head, o).findings;
const T = (body: string) => `test('a', () => {\n${body}\n});\n`;

test('a skipped test and a removed assertion are findings', () => {
  const f = findings({ 'a.test.ts': T('expect(1).toBe(1);\nexpect(2).toBe(2);') }, { 'a.test.ts': 'test.skip(\'a\', () => {\nexpect(1).toBe(1);\n});\n' });
  expect(f).toContain('a.test.ts: .skip( added');
  expect(f).toContain('a.test.ts: 1 assertion removed');
});
test('a deleted test file counts its assertions as removed', () =>
  expect(findings({ 'a.test.ts': T('expect(1).toBe(1);') }, { 'a.test.ts': null })).toContain('a.test.ts: 1 assertion removed'));
test('a changed check script is a finding', () =>
  expect(findings({ 'package.json': pkg({ test: 'vitest run' }) }, { 'package.json': pkg({ test: 'echo ok' }) })).toContain('package.json: script "test" changed'));
test('a vanished check script is a finding; an unrelated script is not', () => {
  expect(findings({ 'package.json': pkg({ test: 'x', other: 'a' }) }, { 'package.json': pkg({ other: 'a' }) })).toContain('package.json: script "test" changed');
  expect(findings({ 'package.json': pkg({ test: 'x', other: 'a' }) }, { 'package.json': pkg({ test: 'x', other: 'b' }) })).toEqual([]);
});
test('only the root package.json counts for scripts', () =>
  expect(findings({ 'sub/package.json': pkg({ test: 'a' }) }, { 'sub/package.json': pkg({ test: 'b' }) })).toEqual([]));
test('scriptChanges: names not in scripts or unchanged give nothing', () => {
  expect(scriptChanges(pkg({ a: '1' }), pkg({ a: '1' }), ['a', 'zzz'])).toEqual([]);
  expect(scriptChanges('', pkg({ a: '1' }), ['a'])).toEqual(['package.json: script "a" changed']);
  expect(() => scriptChanges('{', pkg({}), ['a'])).toThrow(/package\.json/);
});
test('a change to .harness/config.yaml or another contract is a protected-file finding', () => {
  const f = findings({ 'a.txt': '1' }, { '.harness/config.yaml': 'x: 1\n', '.harness/tasks/other.json': '{}', [WORKFLOW_PATH]: 'on: x\n' });
  expect(f).toEqual(expect.arrayContaining(['protected file changed: .harness/config.yaml', 'protected file changed: .harness/tasks/other.json', `protected file changed: ${WORKFLOW_PATH}`]));
});

const contract = (id: string): Contract => {
  const c = { id, title: 't', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', criteria: [] } as unknown as Contract;
  return { ...c, sha256: contractHash(c) } as Contract;
};
const own = (id: string) => { const c = contract(id); return { text: JSON.stringify(c, null, 2) + '\n', own: { id, sha256: contractHash(c) } }; };

test('the attended own contract, added with its approved hash, is not a finding', () => {
  const { text, own: o } = own('t1');
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t1.json': text }, { checkNames: [], ownContract: o })).toEqual([]);
});
test('own contract: a modification, a different hash, or another id is a finding', () => {
  const { text, own: o } = own('t1');
  const mod = findings({ '.harness/tasks/t1.json': text }, { '.harness/tasks/t1.json': text.replace('"t"', '"u"') }, { checkNames: [], ownContract: o });
  expect(mod).toEqual(['protected file changed: .harness/tasks/t1.json']);
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t1.json': text.replace('"t"', '"u"') }, { checkNames: [], ownContract: o })).toEqual(['protected file changed: .harness/tasks/t1.json']);
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t2.json': text }, { checkNames: [], ownContract: o })).toEqual(['protected file changed: .harness/tasks/t2.json']);
});
test('own contract: a rename onto the path is a delete plus an add, so the delete is a finding', () => {
  const { text, own: o } = own('t1');
  const f = findings({ '.harness/tasks/old.json': text }, { '.harness/tasks/old.json': null, '.harness/tasks/t1.json': text }, { checkNames: [], ownContract: o });
  expect(f).toEqual(['protected file changed: .harness/tasks/old.json']);
});
test('hostile paths: newline, quote, unicode, leading dash', () => {
  const name = '-we"ird\né.test.ts';
  const r = run({ 'a.txt': '1' }, { [name]: 'test.skip("a", () => {});\n', '-x.txt': '1' });
  expect(r.files).toContain(name);
  expect(r.files).toContain('-x.txt');
  expect(r.findings).toEqual(['-we\\"ird\\né.test.ts: .skip( added']);
});
test('a tree id works as `to`', () => {
  const r = repoWith({ 'a.test.ts': T('expect(1).toBe(1);') }, { 'a.test.ts': T('') });
  dirs.push(r.root);
  const tree = git(r.root, 'rev-parse', `${r.head}^{tree}`).trim();
  expect(diffTamper(r.root, defaultExec, r.base, tree, { checkNames: [] }).findings).toContain('a.test.ts: 1 assertion removed');
});
test('fail closed: git failure, timeout, unreadable blob, binary, oversize', () => {
  const r = repoWith({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'y\n' });
  dirs.push(r.root);
  const o = { checkNames: [] };
  expect(() => diffTamper(r.root, defaultExec, 'nope', r.head, o)).toThrow(/git/);
  expect(() => diffTamper(r.root, () => ({ status: 0, stdout: '', timedOut: true }), r.base, r.head, o)).toThrow(/timed out/);
  expect(() => diffTamper(r.root, () => ({ status: 127, stdout: '', missing: true }), r.base, r.head, o)).toThrow(/git/);
  expect(() => diffTamper(r.root, (c, a, x) => (a.includes('show') ? { status: 128, stdout: '' } : defaultExec(c, a, x)), r.base, r.head, o)).toThrow(/a\.test\.ts/);
  expect(() => run({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'a\0b' })).toThrow(/a\.test\.ts.*binary/);
  expect(() => run({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'a'.repeat(2_000_000) })).toThrow(/a\.test\.ts.*large/);
  expect(() => diffTamper(r.root, () => ({ status: 0, stdout: 'R100\0a\0b\0' }), r.base, r.head, o)).toThrow(/R100/);
});
