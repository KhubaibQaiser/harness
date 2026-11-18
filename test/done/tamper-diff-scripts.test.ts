import { expect, test } from 'vitest';
import { defaultExec, type Exec, type ExecOpts } from '../../src/core/exec.js';
import { diffTamper } from '../../src/done/tamper-diff.js';
import { git, repoWith } from '../review/repo.js';
import { dirs, run, findings, T } from './tamper-diff-helpers.js';

const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });

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
