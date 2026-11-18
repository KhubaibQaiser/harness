import { expect, test } from 'vitest';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { diffTamper, WORKFLOW_PATH } from '../../src/done/tamper-diff.js';
import { git, repoWith } from '../review/repo.js';
import { dirs, run, findings, T, own, src, src2 } from './tamper-diff-helpers.js';

test('a change to .harness/config.yaml or another contract is a protected-file finding', () => {
  const f = findings({ 'a.txt': '1' }, { '.harness/config.yaml': 'x: 1\n', '.harness/tasks/other.json': '{}', [WORKFLOW_PATH]: 'on: x\n' });
  expect(f).toEqual(expect.arrayContaining(['protected file changed: .harness/config.yaml', 'protected file changed: .harness/tasks/other.json', `protected file changed: ${WORKFLOW_PATH}`]));
});

test('the attended own contract, added with its approved hash, is not a finding', () => {
  const { text, own: o } = own('t1');
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t1.json': text }, { ownContract: o })).toEqual([]);
});

test('own contract: a modification, a different hash, or another id is a finding', () => {
  const { text, own: o } = own('t1');
  const mod = findings({ '.harness/tasks/t1.json': text }, { '.harness/tasks/t1.json': text.replace('"t"', '"u"') }, { ownContract: o });
  expect(mod).toEqual(['protected file changed: .harness/tasks/t1.json']);
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t1.json': text.replace('"t"', '"u"') }, { ownContract: o })).toEqual(['protected file changed: .harness/tasks/t1.json']);
  expect(findings({ 'a.txt': '1' }, { '.harness/tasks/t2.json': text }, { ownContract: o })).toEqual(['protected file changed: .harness/tasks/t2.json']);
});

test('own contract: a rename onto the path is a delete plus an add, so the delete is a finding', () => {
  const { text, own: o } = own('t1');
  const f = findings({ '.harness/tasks/old.json': text }, { '.harness/tasks/old.json': null, '.harness/tasks/t1.json': text }, { ownContract: o });
  expect(f).toEqual(['protected file changed: .harness/tasks/old.json']);
});

test('hostile paths Windows allows: unicode, space, leading dash', () => {
  const name = '-we ird é.test.ts';
  expect(run({ 'a.txt': '1' }, { [name]: 'test.skip("a", () => {});\n' }).findings).toEqual([`${name}: .skip( added`]);
});

test.skipIf(process.platform === 'win32')('hostile paths: newline and quote', () => {
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
  expect(diffTamper(r.root, defaultExec, r.base, tree, {}).findings).toContain('a.test.ts: 1 assertion removed');
});

test('fail closed: git failure, timeout, unreadable blob, binary, oversize', () => {
  const r = repoWith({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'y\n' });
  dirs.push(r.root);
  const o = {};
  expect(() => diffTamper(r.root, defaultExec, 'nope', r.head, o)).toThrow(/git/);
  expect(() => diffTamper(r.root, () => ({ status: 0, stdout: '', timedOut: true }), r.base, r.head, o)).toThrow(/timed out/);
  expect(() => diffTamper(r.root, () => ({ status: 127, stdout: '', missing: true }), r.base, r.head, o)).toThrow(/git/);
  const missing: Exec = (c, a, x) => (a.includes('cat-file') ? { status: 0, stdout: (x?.input ?? '').split('\n').filter(Boolean).map((l) => `${l} missing\n`).join('') } : defaultExec(c, a, x));
  expect(() => diffTamper(r.root, missing, r.base, r.head, o)).toThrow(/a\.test\.ts/);
  expect(() => diffTamper(r.root, (c, a, x) => (a.includes('cat-file') ? { status: 128, stdout: '' } : defaultExec(c, a, x)), r.base, r.head, o)).toThrow(/git/);
  expect(() => run({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'a\0b' })).toThrow(/a\.test\.ts.*binary/);
  expect(() => run({ 'a.test.ts': 'x\n' }, { 'a.test.ts': 'a'.repeat(2_000_000) })).toThrow(/a\.test\.ts.*large/);
  expect(() => diffTamper(r.root, () => ({ status: 0, stdout: 'R100\0a\0b\0' }), r.base, r.head, o)).toThrow(/R100/);
});

test('N1: an unchanged package.json that is invalid, a symlink, binary or oversize is skipped, not a throw', () => {
  const bad = { 'test/fixtures/bad/package.json': '{ not json', 'sub/package.json': { link: '../x' }, 'bin/package.json': 'a\0b', 'big/package.json': JSON.stringify({ scripts: { t: 'a'.repeat(2_000_000) } }) };
  expect(findings({ ...bad, ...src }, { ...src2, 'sub/package.json': { link: '../x' } })).toEqual([]); // the helper drops a link it isn't given again
});

test('N1: a changed package.json that cannot be read is a finding, not a throw', () => {
  expect(findings({ 'package.json': '{}' }, { 'package.json': '{ not json' })).toEqual(['package.json: package.json unreadable']);
  expect(findings({ 'sub/package.json': '{ not json' }, { 'sub/package.json': '{}' })).toEqual(['sub/package.json: package.json unreadable']);
  expect(findings({ 'package.json': '{}' }, { 'package.json': JSON.stringify({ x: 'a'.repeat(2_000_000) }) })).toEqual(['package.json: package.json unreadable']);
  expect(findings({ 'package.json': '{}' }, { 'package.json': '{"a":"\0"}' })).toEqual(['package.json: package.json unreadable']);
});

test('N2: overrides, resolutions, pnpm.overrides and pnpm.patchedDependencies changes are findings', () => {
  const f = (a: object) => findings({ 'package.json': '{}' }, { 'package.json': JSON.stringify(a) });
  expect(f({ overrides: { vitest: '1.0.0' } })).toEqual(['package.json: overrides changed']);
  expect(f({ resolutions: { vitest: 'portal:../fake' } })).toEqual(['package.json: resolutions changed']);
  expect(f({ pnpm: { overrides: { vitest: 'link:../fake' } } })).toEqual(['package.json: pnpm.overrides changed']);
  expect(f({ pnpm: { patchedDependencies: { vitest: 'p.patch' } } })).toEqual(['package.json: pnpm.patchedDependencies changed']);
});

test('N2: workspace:, npm: alias, tarball, URL and user/repo specs are findings', () => {
  const f = (spec: string) => findings({ 'package.json': '{}' }, { 'package.json': JSON.stringify({ devDependencies: { vitest: spec } }) });
  for (const spec of ['workspace:*', 'npm:fake-vitest@1', 'fake.tgz', 'sub/fake.tar.gz', 'https://x.io/a.tgz', 'http://x.io/a', 'user/repo']) expect(f(spec)).toEqual([`package.json: dependency "vitest" points at ${spec}`]);
});
