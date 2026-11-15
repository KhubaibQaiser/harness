import { rmSync } from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { contractHash, type Contract } from '../../src/done/contract.js';
import { defaultExec, type Exec, type ExecOpts } from '../../src/core/exec.js';
import { diffTamper, isHarnessOwned, WORKFLOW_PATH } from '../../src/done/tamper-diff.js';
import { git, repoWith, type Files } from '../review/repo.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const run = (base: Files, head: Files, o: Parameters<typeof diffTamper>[4] = {}, exec: Exec = defaultExec) => {
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
  expect(findings({ 'package.json': pkg({ test: 'vitest run' }) }, { 'package.json': pkg({ test: 'echo ok' }) })).toContain('package.json: scripts changed (test)'));
test('any scripts or config key change in any package.json is a finding, however the script is reached', () => {
  const f = (b: object, a: object, rel = 'package.json') => findings({ [rel]: JSON.stringify(b) }, { [rel]: JSON.stringify(a) });
  expect(f({ scripts: { test: 'x' } }, { scripts: { test: 'x', docs: 'b' } })).toEqual(['package.json: scripts changed (docs)']);
  expect(f({ scripts: { test: 'x' }, config: { suite: 'real' } }, { scripts: { test: 'x' }, config: { suite: 'fake' } })).toEqual(['package.json: config changed']);
  expect(f({ scripts: { 'test:ci': 'x' } }, { scripts: { 'test:ci': 'true' } }, 'sub/package.json')).toEqual(['sub/package.json: scripts changed (test:ci)']);
  expect(f({ scripts: { t: 'concurrently "npm:unit"', unit: 'a' } }, { scripts: { t: 'concurrently "npm:unit"', unit: 'true' } })).toEqual(['package.json: scripts changed (unit)']);
  expect(f({ name: 'x' }, { name: 'y', version: '2' })).toEqual([]);
});
test('a dependency that points at a path, file, link, git or github spec is a finding; a version range is not', () => {
  const f = (d: object) => findings({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }) }, { 'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0', ...d } }) });
  for (const spec of ['file:../fake', 'link:../fake', 'portal:../fake', 'git+https://x/y.git', 'github:a/b', './fake', '../fake', '/abs/fake']) expect(f({ vitest: spec })).toEqual([`package.json: dependency "vitest" points at ${spec}`]);
  expect(f({ lodash: '^4.0.0' })).toEqual([]);
});
test('a path named in a script is a finding, in either side of the diff', () => {
  const sc = (c: string) => JSON.stringify({ scripts: { test: `vitest run --config ${c}` } });
  expect(findings({ 'package.json': sc('tests/ci.ts'), 'tests/ci.ts': 'a' }, { 'package.json': sc('tests/ci.ts'), 'tests/ci.ts': 'b' })).toEqual(['tests/ci.ts: file named by a package.json script changed']);
  expect(findings({ 'package.json': sc('tests/ci.ts'), 'src/x.ts': 'a' }, { 'package.json': sc('tests/ci.ts'), 'src/x.ts': 'b' })).toEqual([]);
});
test('a path named in a nested package.json script is a finding, resolved against its folder and the root', () => {
  const sc = JSON.stringify({ scripts: { test: 'vitest --config ci.config.ts' } });
  expect(findings({ 'sub/package.json': sc, 'sub/ci.config.ts': 'a' }, { 'sub/package.json': sc, 'sub/ci.config.ts': 'b' })).toEqual(['sub/ci.config.ts: file named by a package.json script changed']);
  expect(findings({ 'sub/package.json': sc, 'ci.config.ts': 'a' }, { 'sub/package.json': sc, 'ci.config.ts': 'b' })).toEqual(['ci.config.ts: file named by a package.json script changed']);
  expect(findings({ 'sub/package.json': sc, 'other/ci.config.ts': 'a' }, { 'sub/package.json': sc, 'other/ci.config.ts': 'b' })).toEqual([]);
});
test('Yarn and other tool files and configs are findings at any depth', () => {
  const names = ['.pnp.cjs', 'sub/.pnp.loader.mjs', '.yarn/releases/yarn-4.cjs', 'babel.config.js', '.babelrc.json', '.mocharc.yml', 'turbo.json', 'nx.json', 'tsconfig.json', 'sub/tsconfig.test.json', '.pnpmfile.cjs', 'pnpm-workspace.yaml'];
  const f = findings({ 'a.txt': '1' }, Object.fromEntries(names.map((n) => [n, 'x'])));
  expect(f).toHaveLength(names.length);
  expect(f.every((x) => /changed$/.test(x))).toBe(true);
});
test('a directory symlink retarget and a submodule bump are findings', () => {
  const f = findings({ tests: { link: 'real' }, sub: { gitlink: 'a'.repeat(40) } }, { tests: { link: 'fake' }, sub: { gitlink: 'b'.repeat(40) }, 'docs/x': { link: 'y' } });
  expect(f.sort()).toEqual(['docs/x: symlink or submodule changed', 'sub: symlink or submodule changed', 'tests: symlink or submodule changed']);
});
test('package manager config and test config changes are findings, at any depth', () => {
  const f = findings({ 'a.txt': '1' }, { '.npmrc': 'a=1', 'sub/.yarnrc.yml': 'a', 'bunfig.toml': 'b', 'vite.config.ts': 'x', 'sub/jest.config.js': 'y', 'package.json': JSON.stringify({ jest: { roots: ['x'] } }) }, {});
  expect(f).toEqual(expect.arrayContaining(['.npmrc: package manager config changed', 'sub/.yarnrc.yml: package manager config changed', 'bunfig.toml: package manager config changed', 'vite.config.ts: test config changed', 'sub/jest.config.js: test config changed', 'package.json: test config changed']));
});
test('symlink or submodule entries: in-scope ones and anything linked under .harness or .claude are findings', () => {
  const f = findings({ 'real.ts': 'x\n', 'a.test.ts': T('expect(1).toBe(1);') }, { 'a.test.ts': { link: 'real.ts' }, '.claude/x': { link: 'y' }, 'x.test.ts': { gitlink: 'a'.repeat(40) } }, {});
  expect(f).toEqual(expect.arrayContaining(['a.test.ts: symlink or submodule changed', 'x.test.ts: symlink or submodule changed', 'protected file changed: .claude/x']));
  expect(findings({ 'a.txt': '1' }, { '.harness': { link: 'elsewhere' } }, {})).toEqual(['protected file changed: .harness']);
});
test('the git budget is passed through, the environment blocks grafts and replace refs, stderr is escaped', () => {
  const seen: ExecOpts[] = [];
  const ex: Exec = (c, a, x) => { seen.push(x ?? {}); return defaultExec(c, a, x); };
  run({ 'a.txt': '1' }, { 'a.txt': '2' }, { timeoutMs: 1234 }, ex);
  expect(seen.every((x) => x.timeoutMs === 1234)).toBe(true);
  expect(seen[0]!.env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/harness-no-grafts' });
  expect(() => diffTamper('/', () => ({ status: 1, stdout: '', stderr: 'bad\nforged line' }), 'a', 'b', {})).toThrow(/bad\\nforged line/);
});
test('a replace ref on the tree does not change what is diffed', () => {
  const r = repoWith({ 'a.test.ts': T('expect(1).toBe(1);') }, { 'a.test.ts': T('') });
  dirs.push(r.root);
  const tree = git(r.root, 'rev-parse', `${r.head}^{tree}`).trim(), other = git(r.root, 'rev-parse', `${r.base}^{tree}`).trim();
  git(r.root, 'replace', '-f', tree, other);
  expect(diffTamper(r.root, defaultExec, r.base, tree, {}).findings).toContain('a.test.ts: 1 assertion removed');
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

// Round 4
const src = { 'src/a.ts': 'a' }, src2 = { 'src/a.ts': 'b' };
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
