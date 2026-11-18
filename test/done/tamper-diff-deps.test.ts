import { expect, test } from 'vitest';
import { defaultExec, type Exec, type ExecOpts } from '../../src/core/exec.js';
import { run, findings, T, src, src2 } from './tamper-diff-helpers.js';

test('N2: a new package whose name is a dependency of any package.json is a finding; another name is not', () => {
  const base = { 'package.json': JSON.stringify({ devDependencies: { vitest: '^1' } }) };
  expect(findings(base, { 'fake/package.json': JSON.stringify({ name: 'vitest' }) })).toEqual(['fake/package.json: package name "vitest" matches a dependency']);
  expect(findings(base, { 'mine/package.json': JSON.stringify({ name: 'mine' }) })).toEqual([]);
});

test('N2: a lockfile line added with a file:, link: or portal: resolution is a finding; a registry bump is not', () => {
  const l = (rel: string, b: string, a: string) => findings({ [rel]: b }, { [rel]: a });
  expect(l('package-lock.json', '"resolved": "https://registry.npmjs.org/v/-/v-1.tgz"\n', '"resolved": "file:../fake"\n')).toEqual(['package-lock.json: lockfile adds a local file, link or portal dependency']);
  expect(l('package-lock.json', '"resolved": "https://r/v-1.tgz"\n', '"resolved": "../fake",\n"link": true\n')).toHaveLength(1);
  expect(l('pnpm-lock.yaml', 'version: 1.0.0\n', 'version: link:../fake\n')).toHaveLength(1);
  expect(l('sub/yarn.lock', 'a\n', '"vitest@portal:../fake":\n')).toHaveLength(1);
  expect(l('bun.lock', 'a\n', '"vitest": ["vitest@file:../fake"]\n')).toHaveLength(1);
  expect(l('package-lock.json', '"resolved": "https://r/v-1.tgz"\n', '"resolved": "https://r/v-2.tgz"\n')).toEqual([]);
});

test('N3: script words are normalised against the package folder, and INIT_CWD or the local prefix mean the root', () => {
  const sc = (t: string) => ({ 'sub/package.json': JSON.stringify({ scripts: { test: t } }) });
  const f = (t: string, rel: string) => findings({ ...sc(t), [rel]: 'a' }, { ...sc(t), [rel]: 'b' });
  expect(f('vitest --config ../shared/ci.ts', 'shared/ci.ts')).toEqual(['shared/ci.ts: file named by a package.json script changed']);
  for (const v of ['$INIT_CWD', '${INIT_CWD}', '$npm_config_local_prefix']) expect(f(`vitest --config "${v}/tests/ci.ts"`, 'tests/ci.ts')).toHaveLength(1);
});

test('N6: a file named only by a script gets its own text; package.yaml and package.json5 are package files', () => {
  const start = JSON.stringify({ scripts: { start: 'node server.js' } });
  expect(findings({ 'package.json': start, 'server.js': 'a' }, { 'server.js': 'b' })).toEqual(['server.js: file named by a package.json script changed']);
  expect(findings({ 'package.yaml': 'scripts:\n  test: vitest\n' }, { 'package.yaml': 'scripts:\n  test: "true"\n' })).toEqual(['package.yaml: scripts changed (test)']);
  expect(findings({ 'package.yaml': 'scripts:\n  test: vitest -c ci.ts\n', 'ci.ts': 'a' }, { 'ci.ts': 'b' })).toEqual(['ci.ts: file named by a package.json script changed']);
  expect(findings({ 'package.json5': '{"scripts":{"test":"a"}}' }, { 'package.json5': '{"scripts":{"test":"b"}}' })).toEqual(['package.json5: scripts changed (test)']);
  expect(findings({ 'package.json5': '{}' }, { 'package.json5': '{ // c\n}' })).toEqual(['package.json5: package.json unreadable']);
  expect(findings({ 'x/package.json5': '{ // c\n}', ...src }, src2)).toEqual([]);
});

test('namedPaths from T11 steps are treated like script-named paths', () => {
  expect(findings({ 'scripts/ci.sh': 'a', 'ci.mk': 'a' }, { 'scripts/ci.sh': 'b', 'ci.mk': 'b' }, { namedPaths: ['./scripts/ci.sh', 'ci.mk'] }).sort()).toEqual(['ci.mk: file named by a package.json script changed', 'scripts/ci.sh: file named by a package.json script changed']);
  expect(findings({ 'scripts/ci.sh': 'a' }, { 'scripts/ci.sh': 'b' })).toEqual([]);
});

test('N4: one cat-file read keeps its byte framing across multibyte and non-UTF-8 blobs', () => {
  const f = findings({ 'p/package.json': Buffer.concat([Buffer.from('{"name":"é€"} '), Buffer.from([0xff, 0xfe])]), 'b.test.ts': T('expect("é").toBe("é");') }, { 'b.test.ts': 'test.skip("é€", () => {});\n' });
  expect(f).toEqual(['b.test.ts: .skip( added', 'b.test.ts: 1 assertion removed']);
});

test('M1: cat-file reads are split at about 32 MiB of ls-tree sizes, and ls-tree gets a 256 MiB buffer', () => {
  const MiB = 1024 * 1024, calls: { args: string[]; x: ExecOpts }[] = [];
  // Real blobs are small; ls-tree is told they are 12 MiB each, which is what the batching goes by.
  const ex: Exec = (c, a, x = {}) => {
    calls.push({ args: a, x });
    const r = defaultExec(c, a, x);
    return a.includes('ls-tree') ? { ...r, stdout: r.stdout.replace(/ +\d+\t([^\0]*package-lock\.json)/g, ` ${12 * MiB}\t$1`) } : r;
  };
  const lock = (s: string) => Object.fromEntries(['a', 'b', 'c'].map((d) => [`${d}/package-lock.json`, `"resolved": "${s}${d}"\n`]));
  const f = run(lock('https://r/v-1.tgz'), { ...lock('https://r/v-2.tgz'), 'b/package-lock.json': '"resolved": "file:../fake"\n' }, {}, ex).findings;
  expect(f).toEqual(['b/package-lock.json: lockfile adds a local file, link or portal dependency']);
  const reads = calls.filter((c) => c.args.includes('cat-file'));
  expect(reads.length).toBe(3);
  for (const r of reads) expect(r.x.input!.trim().split('\n').length * 12 * MiB).toBeLessThanOrEqual(32 * MiB);
  expect(calls.filter((c) => c.args.includes('ls-tree')).every((c) => c.x.maxBuffer === 256 * MiB)).toBe(true);
});
