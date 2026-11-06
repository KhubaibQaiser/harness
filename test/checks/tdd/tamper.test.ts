import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { afterContent, tamper, tamperFindings } from '../../../src/checks/tdd/tamper.js';
import { dispatch, registry } from '../../../src/hooks/dispatch.js';

const T = 'src/a.test.ts';
const setup = (cfg = 'checks:\n  tdd: true\n', files: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'h-tp-'));
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), cfg);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  const run = async (tool: string, tool_input: Record<string, unknown>) => {
    const out = await dispatch(JSON.stringify({ session_id: 's', cwd: root, hook_event_name: 'PreToolUse', tool_name: tool, tool_input }), [tamper], {});
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  return { root, run };
};
const SUITE = "it('a', () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(4);\n});\n";

test('registered after redFirst, PreToolUse, not fail-closed', () => {
  expect(registry.map((c) => c.name).slice(0, 6)).toEqual(['guard', 'pr-size', 'protect', 'sandbox-required', 'redFirst', 'tamper']);
  expect(tamper.failClosed).toBeFalsy();
  expect(tamper.events).toEqual(['PreToolUse']);
});

test.each(['.skip(', '.only(', 'xit(', 'xdescribe(', 'xtest(', '.todo(', 'fit(', 'fdescribe('])('%s added is a finding', (m) => {
  expect(tamperFindings('', `it${m.startsWith(".") ? "" : " "}${m}'x')`, T)).toContain(`${m} added`);
});

test('an existing skip is not a new finding; a commented-out skip is ignored', () => {
  expect(tamperFindings("it.skip('a')", "it.skip('a')\n", T)).toEqual([]);
  expect(tamperFindings('', "// it.skip('a')\n/* it.only('b') */", T)).toEqual([]);
});

test('fewer assertions is a finding, counting expect, expect., assert( and assert.', () => {
  expect(tamperFindings(SUITE, "it('a', () => {\n  expect(add(1, 2)).toBe(3);\n});\n", T)).toEqual(['1 assertion removed']);
  expect(tamperFindings('expect.assertions(1); assert(x); assert.ok(y); expect(z)', '', T)).toEqual(['4 assertions removed']);
});

test('commenting out an expect is a finding', () => {
  expect(tamperFindings(SUITE, SUITE.replace('  expect(add(2, 2)).toBe(4);', '  // expect(add(2, 2)).toBe(4);'), T)).toEqual(['1 assertion removed']);
});

test('no-op assertions added are a finding', () => {
  for (const noop of ['expect(true).toBeTruthy()', 'expect(false).toBe(false)', 'expect(1).toBe(1)', "expect('a').toEqual('a')"]) {
    expect(tamperFindings(SUITE, SUITE + noop + ';\n', T)).toEqual(['no-op assertion added']);
  }
  expect(tamperFindings('', 'expect(1).toBe(2); expect(x).toBe(x);', T)).toEqual([]);
});

test('adding a new test with expect is allowed; renaming a variable is allowed', () => {
  expect(tamperFindings(SUITE, SUITE + "it('b', () => { expect(sub(3, 1)).toBe(2); });\n", T)).toEqual([]);
  expect(tamperFindings(SUITE, SUITE.replaceAll('add', 'plus'), T)).toEqual([]);
});

test('config coverage thresholds: lowered and removed are findings, raised is fine', () => {
  const cfg = (b: string) => `coverage: { thresholds: { ${b} } }`;
  const f = 'vitest.config.ts';
  expect(tamperFindings(cfg('lines: 80, branches: 70'), cfg('lines: 70, branches: 70'), f)).toEqual(['coverage threshold lines lowered 80→70']);
  expect(tamperFindings(cfg('lines: 80, branches: 70'), cfg('branches: 70'), f)).toEqual(['coverage threshold lines removed']);
  expect(tamperFindings(cfg('lines: 80'), cfg('lines: 90'), f)).toEqual([]);
  expect(tamperFindings(cfg('lines: 80'), cfg('lines: 10'), T)).toEqual([]);
});

test('afterContent: Write, Edit (first / replace_all / missing), MultiEdit in order', () => {
  const cur = 'a b a';
  expect(afterContent({ tool_name: 'Write', tool_input: { content: 'new' } } as never, cur)).toBe('new');
  expect(afterContent({ tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'x' } } as never, cur)).toBe('x b a');
  expect(afterContent({ tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'x', replace_all: true } } as never, cur)).toBe('x b x');
  expect(afterContent({ tool_name: 'Edit', tool_input: { old_string: 'zz', new_string: 'x' } } as never, cur)).toBe(cur);
  const edits = [{ old_string: 'a', new_string: 'b' }, { old_string: 'b b', new_string: 'c' }];
  expect(afterContent({ tool_name: 'MultiEdit', tool_input: { edits } } as never, cur)).toBe('c a');
  expect(afterContent({ tool_name: 'MultiEdit', tool_input: { edits: [...edits, { old_string: 'nope', new_string: '' }] } } as never, cur)).toBe(cur);
});

test('Edit that comments out an expect is denied with the exact reason', async () => {
  const t = setup(undefined, { [T]: SUITE });
  const d = await t.run('Edit', { file_path: join(t.root, T), old_string: '  expect(add(2, 2)).toBe(4);', new_string: '  // expect(add(2, 2)).toBe(4);' });
  expect(d.permissionDecision).toBe('deny');
  expect(d.permissionDecisionReason).toBe("Tests can't be weakened to pass: 1 assertion removed. Fix the code instead, or ask the user.");
});

test('Write of a weakened test and MultiEdit adding .skip are denied', async () => {
  const t = setup(undefined, { [T]: SUITE });
  expect((await t.run('Write', { file_path: T, content: "it('a', () => {});\n" })).permissionDecisionReason).toContain('2 assertions removed');
  const edits = [{ old_string: "it('a'", new_string: "it.skip('a'" }];
  expect((await t.run('MultiEdit', { file_path: T, edits })).permissionDecisionReason).toContain('.skip( added');
});

test('Write to a missing test file treats before as empty and allows new tests', async () => {
  const t = setup();
  expect((await t.run('Write', { file_path: T, content: SUITE })).permissionDecision).toBe('allow');
});

test('Edit whose old_string is missing is allowed', async () => {
  const t = setup(undefined, { [T]: SUITE });
  expect((await t.run('Edit', { file_path: T, old_string: 'nope', new_string: 'x' })).permissionDecision).toBe('allow');
});

test('applies to any test file regardless of tdd.paths, and to configs at any depth', async () => {
  const t = setup('checks:\n  tdd: true\ntdd:\n  paths: ["lib/**"]\n', { 'pkg/x/vitest.config.ts': 'lines: 80', 'jest.config.js': 'lines: 80', 'vitest.workspace.ts': 'lines: 80' });
  expect((await t.run('Write', { file_path: 'pkg/x/vitest.config.ts', content: 'lines: 70' })).permissionDecisionReason).toContain('coverage threshold lines lowered 80→70');
  expect((await t.run('Write', { file_path: 'jest.config.js', content: '' })).permissionDecisionReason).toContain('coverage threshold lines removed');
  expect((await t.run('Write', { file_path: 'vitest.workspace.ts', content: 'lines: 1' })).permissionDecision).toBe('deny');
  expect((await t.run('Write', { file_path: 'other/x.spec.ts', content: 'it.skip(1)' })).permissionDecision).toBe('deny');
  expect((await t.run('Write', { file_path: 'src/__tests__/y.ts', content: 'it.skip(1)' })).permissionDecision).toBe('deny');
});

test('non-test files, outside-root paths, other tools and tdd off are allowed', async () => {
  const t = setup(undefined, { 'src/a.ts': 'expect(1)' });
  expect((await t.run('Write', { file_path: 'src/a.ts', content: '' })).permissionDecision).toBe('allow');
  expect((await t.run('Write', { file_path: join(tmpdir(), 'zz.test.ts'), content: 'it.skip(1)' })).permissionDecision).toBe('allow');
  expect((await t.run('Read', { file_path: T })).permissionDecision).toBe('allow');
  const off = setup('checks:\n  tdd: false\n', { [T]: SUITE });
  expect((await off.run('Write', { file_path: T, content: '' })).permissionDecision).toBe('allow');
});

test('a symlink into the repo cannot dodge the check', async () => {
  const t = setup(undefined, { [T]: SUITE });
  symlinkSync(join(t.root, T), join(t.root, 'link.ts'));
  expect((await t.run('Write', { file_path: 'link.ts', content: '' })).permissionDecision).toBe('deny');
});

test('a TDD pause does not disable it', async () => {
  const t = setup(undefined, { [T]: SUITE });
  mkdirSync(join(t.root, '.harness/state'), { recursive: true });
  writeFileSync(join(t.root, '.harness/state/tdd-pause.json'), JSON.stringify({ createdAt: Date.now() }));
  expect((await t.run('Write', { file_path: T, content: '' })).permissionDecision).toBe('deny');
});

// Fix round 1
test.each([
  ["it.skipIf(true)('a', f)", '.skipIf( added'],
  ["it.runIf(false)('a', f)", '.runIf( added'],
  ["describe.skip.each([1])('x', f)", '.skip( added'],
  ["test.only.each([1])('x', f)", '.only( added'],
  ["it.fails('a', f)", '.fails( added'],
])('skip variant %s is a finding', (src, finding) => {
  expect(tamperFindings('', src, T)).toContain(finding);
});

test('quoted and decimal thresholds are compared as numbers', () => {
  expect(tamperFindings('{"lines": 80}', '{"lines": 70}', 'jest.config.json')).toEqual(['coverage threshold lines lowered 80→70']);
  expect(tamperFindings('lines: 80.5', 'lines: 80.1', 'vitest.config.ts')).toEqual(['coverage threshold lines lowered 80.5→80.1']);
  expect(tamperFindings("'lines': 80", "'lines': 90", 'vitest.config.ts')).toEqual([]);
});

test('package.json at any depth is checked for thresholds only', async () => {
  const pkg = (n: number) => `{"jest":{"coverageThreshold":{"global":{"lines":${n}}}}}`;
  expect(tamperFindings(pkg(80), pkg(70), 'pkg/a/package.json')).toEqual(['coverage threshold lines lowered 80→70']);
  expect(tamperFindings(pkg(80), '{"jest":{}}', 'package.json')).toEqual(['coverage threshold lines removed']);
  expect(tamperFindings('{"scripts":{"t":"x"}}', '{"scripts":{"t":"x.skip(1)"}}', 'package.json')).toEqual([]);
  const t = setup(undefined, { 'pkg/a/package.json': pkg(80) });
  expect((await t.run('Write', { file_path: 'pkg/a/package.json', content: pkg(10) })).permissionDecision).toBe('deny');
});

test('config weakening: passWithNoTests, disabled coverage, test selection', () => {
  const f = 'vitest.config.ts';
  expect(tamperFindings('passWithNoTests: false', 'passWithNoTests: true', f)).toEqual(['passWithNoTests enabled']);
  expect(tamperFindings('passWithNoTests: true', 'passWithNoTests: true', f)).toEqual([]);
  expect(tamperFindings('coverage: { enabled: true }', 'coverage: { enabled: false }', f)).toEqual(['coverage disabled']);
  expect(tamperFindings('coverage: { thresholds: {lines: 1} }', 'coverage: { thresholds: false }', f).sort()).toEqual(['coverage disabled', 'coverage threshold lines removed']);
  expect(tamperFindings("include: ['src/**']", "include: ['src/a/**']", f)).toEqual(['test selection changed (include)']);
  expect(tamperFindings("exclude: ['x']", "exclude: ['x', 'y']", f)).toEqual(['test selection changed (exclude)']);
  expect(tamperFindings('include: [\n  "a",\n  "b",\n]', 'include: [\n  "a",\n]', f)).toEqual(['test selection changed (include)']);
  expect(tamperFindings('testMatch: ["a"]', 'testMatch: []', 'jest.config.js')).toEqual(['test selection changed (testMatch)']);
  expect(tamperFindings('testPathIgnorePatterns: []', 'testPathIgnorePatterns: ["a"]', 'jest.config.js')).toEqual(['test selection changed (testPathIgnorePatterns)']);
  expect(tamperFindings('coveragePathIgnorePatterns: []', 'coveragePathIgnorePatterns: ["a"]', 'jest.config.js')).toEqual(['test selection changed (coveragePathIgnorePatterns)']);
  expect(tamperFindings("include: ['a']", "include: ['a']\n", f)).toEqual([]);
  expect(tamperFindings('', 'passWithNoTests: true', T)).toEqual([]); // config-only rules
});

test('expect.any / anything / objectContaining / extend do not count as assertions', () => {
  const before = 'expect(a).toBe(1);\nexpect(b).toEqual(expect.any(Number));';
  expect(tamperFindings(before, 'expect(b).toEqual(expect.any(Number));\nexpect.extend({});', T)).toEqual(['1 assertion removed']);
  expect(tamperFindings('expect(a).toBe(1);', 'expect.any(Number); expect.anything(); expect.objectContaining({})', T)).toEqual(['1 assertion removed']);
  expect(tamperFindings('expect.hasAssertions(); expect.soft(1)', 'expect.hasAssertions(); expect.soft(1)', T)).toEqual([]);
});

// Fix round 2
test('a glob in a string does not start a comment: later rules still see the text', () => {
  const cfg = (lines: number, ex: string) => `include: ["src/*.ts"],\nexclude: [${ex}],\nlines: ${lines}`;
  const f = 'vitest.config.ts';
  expect(tamperFindings(cfg(80, '"**/x"'), cfg(70, '"**/x"'), f)).toEqual(['coverage threshold lines lowered 80→70']);
  expect(tamperFindings(cfg(80, '"**/x"'), cfg(80, '"**/x", "y"'), f)).toEqual(['test selection changed (exclude)']);
  expect(tamperFindings('const p = "a/*b";\n', 'const p = "a/*b";\nit.skip("a"); // c */\n', T)).toEqual(['.skip( added']);
  expect(tamperFindings('', 'const u = "https://x";\nit.only("a");\n', T)).toEqual(['.only( added']);
  expect(tamperFindings('const q = "it\\"//";\nexpect(1)', 'const q = "it\\"//";\n', T)).toEqual(['1 assertion removed']);
  expect(tamperFindings('x', '/* expect(a) */ x', T)).toEqual([]);
  expect(tamperFindings('expect(a)', '/* expect(a) */', T)).toEqual(['1 assertion removed']);
});

test('package.json thresholds are compared from parsed JSON, even on one line with a URL', () => {
  const pkg = (g: number, p: number) => `{"homepage":"https://x/*y","jest":{"coverageThreshold":{"global":{"lines":${g}},"./src/":{"branches":${p}}}}}`;
  expect(tamperFindings(pkg(80, 70), pkg(70, 70), 'package.json')).toEqual(['coverage threshold lines lowered 80→70']);
  expect(tamperFindings(pkg(80, 70), pkg(80, 60), 'package.json')).toEqual(['coverage threshold branches lowered 70→60']);
  expect(tamperFindings(pkg(80, 70), '{"homepage":"https://x/*y","jest":{}}', 'package.json').sort()).toEqual(['coverage threshold branches removed', 'coverage threshold lines removed']);
  expect(tamperFindings(pkg(80, 70), pkg(90, 70), 'package.json')).toEqual([]);
  expect(tamperFindings('{"a":1}', '{"jest":{"coverageThreshold":{"global":{"lines":1}}}}', 'package.json')).toEqual([]);
});

test('a selection value that starts on the next line is compared', () => {
  expect(tamperFindings('include:\n  ["src/**"]', 'include:\n  ["src/a/**"]', 'vitest.config.ts')).toEqual(['test selection changed (include)']);
});

test('NotebookEdit is read via notebook_path and allowed: afterContent leaves notebook content unchanged', async () => {
  const t = setup(undefined, { [T]: SUITE });
  const d = await t.run('NotebookEdit', { notebook_path: join(t.root, T), new_source: 'x' });
  expect(d.permissionDecision).toBe('allow');
});
