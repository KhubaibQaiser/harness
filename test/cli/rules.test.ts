import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { init } from '../../src/cli/init.js';
import type { Prompt } from '../../src/cli/prompt.js';
import { oldNodeHint, rules } from '../../src/cli/rules.js';
import { uninstall } from '../../src/cli/uninstall.js';
import type { Exec } from '../../src/core/exec.js';
import { makeRepo, withPrettier } from '../install/helpers.js';

const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => { throw new Error('no network in tests'); }) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = { env: { HARNESS_PLAIN_INIT: '1' }, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist') };
const HARNESS_FILE = '.harness/eslint/harness.config.mjs';
const STOP_LINE = (n: number) => `The stop gate's lint and typecheck steps will fail until these ${n} violations are fixed. CI fails too if it runs them.`;
const ESLINT_CFG = "import js from '@eslint/js';\n\nexport default [\n  js.configs.recommended,\n];\n";
const pkg = JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, dependencies: { next: '^15.0.0', react: '^19.0.0' }, devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0', eslint: '^9.0.0' } }, null, 2) + '\n';
const NEXT = (eslint: Record<string, string>) => ({
  'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'AGENTS.md': '# Mine\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  'app/page.tsx': 'export default function Page() { return null; }\n',
  ...eslint,
});
const git = (root: string, ...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
const prompt = (answer: string | Error = ''): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    async confirm(q) { asked.push(q); return false; },
    async edit(l) { asked.push(l); if (answer instanceof Error) throw answer; return answer; },
  };
};
/** A fake eslint in the repo's node_modules (resolveBin needs it), answered by `exec`. */
const fakeEslint = (root: string) => {
  const dir = join(root, 'node_modules', 'eslint');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'eslint', version: '9.0.0', bin: { eslint: 'bin/eslint.js' } }));
  writeFileSync(join(dir, 'bin', 'eslint.js'), '');
};
const report = (ids: string[]) => JSON.stringify([{ filePath: 'a.ts', messages: ids.map((ruleId) => ({ ruleId })) }]);
const execWith = (r: ReturnType<Exec>): Exec => (_cmd, [bin = '']) => (bin.endsWith('eslint.js') ? r : { status: 0, stdout: '' });

async function installed(eslint: Record<string, string>) {
  const root = makeRepo(NEXT(eslint));
  const original = Object.fromEntries(Object.keys(eslint).map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  await init(['--yes'], { ...base, root, out: () => {}, prompt: prompt() });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'harness');
  fakeEslint(root);
  return { root, original };
}
const run = async (root: string, args: string[], p: Prompt, exec: Exec, tty = true) => {
  const lines: string[] = [];
  const code = await rules(args, { root, env: {}, tty, out: (s) => lines.push(s), prompt: p, exec });
  return { code, out: lines.join('\n') };
};
const snapshot = (root: string) => git(root, 'status', '--porcelain', '--untracked-files=all', '--ignored=no') + git(root, 'diff');

test('preview shows counts, safe rules and the stop-gate line; --apply + yes writes both files; uninstall restores the repo', async () => {
  const { root, original } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const exec = execWith({ status: 1, stdout: report(['max-depth', 'max-depth', 'no-empty', 'other/x']) });

  const preview = await run(root, [], prompt(), exec);
  expect(preview.code).toBe(0);
  const lines = preview.out.split('\n');
  expect(lines.indexOf('  max-depth: 2')).toBeLessThan(lines.indexOf('  no-empty: 1'));
  expect(preview.out).toMatch(/Safe to add now \(0 violations\):[\s\S]*max-params/);
  expect(preview.out).toContain(STOP_LINE(3));
  expect(preview.out).toMatch(/needs `eslint-plugin-react-hooks`/);
  expect(preview.out).toContain('No lint equivalent:');
  expect(preview.out).toContain(`+++ b/${HARNESS_FILE}`);
  expect(preview.out).toContain('+  ...harnessRules,');
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
  expect(snapshot(root)).toBe('');

  const p = prompt('yes');
  const applied = await run(root, ['--apply'], p, exec);
  expect(applied.code).toBe(0);
  expect(p.asked).toHaveLength(1);
  expect(readFileSync(join(root, HARNESS_FILE), 'utf8')).toContain('"max-depth"');
  expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  const manifest = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string }[] };
  expect(manifest.files.map((f) => f.rel)).toEqual(expect.arrayContaining([HARNESS_FILE, 'eslint.config.mjs']));

  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'rules');
  const un = await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: prompt() });
  expect(un).toBe(0);
  expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(original['eslint.config.mjs']);
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test.each([
  ['a legacy .eslintrc.json', { '.eslintrc.json': '{ "extends": "next" }\n' }],
  ['no ESLint config', {}],
])('--apply on %s is refused with manual steps and nothing is written', async (_n, eslint) => {
  const { root } = await installed(eslint);
  const before = snapshot(root);
  const p = prompt('yes');
  const r = await run(root, ['--apply'], p, execWith({ status: 0, stdout: '[]' }));
  expect(r.code).toBe(1);
  expect(r.out).toMatch(/eslint\.config\.mjs/);
  expect(r.out).toMatch(/needs `eslint-plugin-react-hooks`/);
  expect(r.out).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  expect(p.asked).toEqual([]);
  expect(snapshot(root)).toBe(before);
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
});

test('an ESLint timeout shows the gate impact as unknown, never 0', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const r = await run(root, [], prompt(), execWith({ status: 1, stdout: '', timedOut: true }));
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/unknown/i);
  expect(r.out).toContain('The effect on the stop gate is unknown.');
  expect(r.out).not.toMatch(/: 0\b|\b0 violations/);
  expect(r.out).not.toContain('Safe to add now');
});

test.each([['y'], ['no'], ['YES'], [''], [new Error('input closed before an answer')]])('answer %s writes nothing', async (answer) => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const before = snapshot(root);
  const r = await run(root, ['--apply'], prompt(answer), execWith({ status: 0, stdout: '[]' }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('Nothing was written.');
  expect(snapshot(root)).toBe(before);
});

test('--apply without a terminal and bad flags are refused', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const exec = execWith({ status: 0, stdout: '[]' });
  expect((await run(root, ['--apply'], prompt('yes'), exec, false)).code).toBe(2);
  expect((await run(root, ['--yes'], prompt('yes'), exec)).code).toBe(2);
  expect(existsSync(join(root, HARNESS_FILE))).toBe(false);
});

test.each([
  ['not recorded in the manifest', false],
  ['edited since harness wrote it', true],
])('--apply refuses when %s, naming the file, and writes nothing', async (_n, recorded) => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  const exec = execWith({ status: 0, stdout: '[]' });
  if (recorded) {
    expect((await run(root, ['--apply'], prompt('yes'), exec)).code).toBe(0);
    writeFileSync(join(root, HARNESS_FILE), '// mine\nexport default [];\n');
  } else {
    mkdirSync(join(root, '.harness/eslint'), { recursive: true });
    writeFileSync(join(root, HARNESS_FILE), '// mine\nexport default [];\n');
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'mine');
  const before = snapshot(root) + readFileSync(join(root, '.harness/manifest.json'), 'utf8');
  const p = prompt('yes');
  let linted = 0;
  const r = await run(root, ['--apply'], p, (c, a, o) => (a[0]?.endsWith('eslint.js') && linted++, exec(c, a, o)));
  expect(linted).toBe(0); // the cheap check runs before the slow ESLint run
  expect(r.code).toBe(1);
  expect(r.out).toContain(`\`${HARNESS_FILE}\``);
  expect(r.out).toContain('Nothing was written.');
  expect(p.asked).toEqual([]);
  expect(readFileSync(join(root, HARNESS_FILE), 'utf8')).toBe('// mine\nexport default [];\n');
  expect(snapshot(root) + readFileSync(join(root, '.harness/manifest.json'), 'utf8')).toBe(before);
});

test('--apply rewrites its own unedited file when the proposal changed', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  expect((await run(root, ['--apply'], prompt('yes'), execWith({ status: 0, stdout: '[]' }))).code).toBe(0);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'rules');
  const err = { status: 2, stdout: '', stderr: "Definition for rule 'no-await-in-loop' not found." };
  let calls = 0;
  const exec: Exec = (_c, [bin = '']) => (bin.endsWith('eslint.js') ? (calls++ ? { status: 0, stdout: '[]' } : err) : { status: 0, stdout: '' });
  const r = await run(root, ['--apply'], prompt('yes'), exec);
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, HARNESS_FILE), 'utf8')).toContain('const drop = new Set(["no-await-in-loop"])');
});

test('the old-Node hint shows for eslint.config.ts below Node 22.18 only', () => {
  expect(oldNodeHint('eslint.config.ts', '22.17.1')).toBe('Counting loads eslint.config.ts through Node, which needs Node 22.18 or later (this is Node 22.17.1).');
  expect(oldNodeHint('eslint.config.ts', '20.19.0')).toMatch(/needs Node 22\.18/);
  expect(oldNodeHint('eslint.config.ts', '22.18.0')).toBeNull();
  expect(oldNodeHint('eslint.config.ts', '24.0.0')).toBeNull();
  expect(oldNodeHint('eslint.config.mjs', '20.0.0')).toBeNull();
  expect(oldNodeHint(undefined, '20.0.0')).toBeNull();
});

const unOut = async (root: string) => {
  const lines: string[] = [];
  const code = await uninstall(['--yes'], { env: {}, root, out: (s) => lines.push(s), prompt: prompt() });
  return { code, out: lines.join('\n') };
};
const applied = async (eslint: Record<string, string>, extra: Record<string, string> = {}) => {
  const r = await installed({ ...eslint, ...extra });
  expect((await run(r.root, ['--apply'], prompt('yes'), execWith({ status: 0, stdout: '[]' }))).code).toBe(0);
  git(r.root, 'add', '-A');
  git(r.root, 'commit', '-q', '-m', 'rules');
  return r;
};

test('--apply with an uncommitted ESLint config is refused before ESLint runs', async () => {
  const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
  writeFileSync(join(root, 'eslint.config.mjs'), ESLINT_CFG + '// wip\n');
  let linted = 0;
  const r = await run(root, ['--apply'], prompt('yes'), (_c, [bin = '']) => (bin.endsWith('eslint.js') && linted++, { status: 0, stdout: '[]' }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('eslint.config.mjs');
  expect(linted).toBe(0);
});

test('uninstall after an element is appended past the closing marker removes both lines', async () => {
  const { root } = await applied({ 'eslint.config.mjs': ESLINT_CFG });
  const cfg = join(root, 'eslint.config.mjs');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/(  \/\/ harness:rules\n)(\];)/, '$1  { rules: {} },\n$2'));
  git(root, 'commit', '-qam', 'mine');
  expect((await unOut(root)).code).toBe(0);
  const after = readFileSync(cfg, 'utf8');
  expect(after).not.toContain('harnessRules');
  expect(after).not.toContain('harness:rules');
  expect(after).toContain('{ rules: {} },');
});

test('uninstall after an edit inside a harness block removes none of its blocks and names the lines', async () => {
  const { root } = await applied({ 'eslint.config.mjs': ESLINT_CFG });
  const cfg = join(root, 'eslint.config.mjs');
  const edited = readFileSync(cfg, 'utf8').replace('  ...harnessRules,\n', '  ...harnessRules, // mine\n');
  writeFileSync(cfg, edited);
  git(root, 'commit', '-qam', 'mine');
  const r = await unOut(root);
  expect(r.code).toBe(0);
  expect(readFileSync(cfg, 'utf8')).toBe(edited); // no half removal: the import stays with its spread
  expect(r.out).toContain('`eslint.config.mjs`');
  expect(r.out).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  expect(r.out).toContain('...harnessRules,');
  // the kept config still imports the harness file, so it is kept too and lint keeps loading
  expect(existsSync(join(root, HARNESS_FILE))).toBe(true);
  expect(r.out).toContain(`Kept \`${HARNESS_FILE}\``);
  expect(r.out).toContain('kept because your edited eslint config still imports them');
  expect(r.out).not.toMatch(/harness\.config\.mjs`[^\n]*because you edited them/);

  // init again, then uninstall again: the config still imports the file, so it stays
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'uninstalled');
  await init(['--yes'], { ...base, root, out: () => {}, prompt: prompt() });
  expect(existsSync(join(root, '.harness/manifest.json'))).toBe(true);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'again');
  const again = await unOut(root);
  expect(again.code).toBe(0);
  expect(readFileSync(cfg, 'utf8')).toContain('harnessRules');
  expect(existsSync(join(root, HARNESS_FILE))).toBe(true);
  expect(again.out).toContain('kept because your edited eslint config still imports them');
});

const TS_CFG = "import js from '@eslint/js';\n\nexport default [\n  js.configs.recommended,\n];\n";
const DTS = '.harness/eslint/harness.config.d.mts';
test('an eslint.config.ts also gets a declaration file, recorded and removed by uninstall', async () => {
  const { root, original } = await applied({ 'eslint.config.ts': TS_CFG });
  expect(readFileSync(join(root, DTS), 'utf8')).toContain('Linter.Config[]');
  const manifest = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string }[] };
  expect(manifest.files.map((f) => f.rel)).toEqual(expect.arrayContaining([HARNESS_FILE, DTS, 'eslint.config.ts']));
  expect((await unOut(root)).code).toBe(0);
  expect(readFileSync(join(root, 'eslint.config.ts'), 'utf8')).toBe(original['eslint.config.ts']);
  expect(existsSync(join(root, '.harness'))).toBe(false);
});

test('a strict tsconfig typechecks the edited eslint.config.ts', async () => {
  const { root } = await applied({ 'eslint.config.ts': TS_CFG });
  const d = mkdtempSync(join(tmpdir(), 'rules-tsc-'));
  const put = (rel: string, text: string) => (mkdirSync(dirname(join(d, rel)), { recursive: true }), writeFileSync(join(d, rel), text));
  for (const rel of ['eslint.config.ts', HARNESS_FILE, DTS]) put(rel, readFileSync(join(root, rel), 'utf8'));
  put('package.json', '{ "type": "module" }');
  put('node_modules/eslint/package.json', JSON.stringify({ name: 'eslint', type: 'module', types: 'index.d.ts' }));
  put('node_modules/eslint/index.d.ts', 'export declare namespace Linter { interface Config { rules?: Record<string, unknown> } }\n');
  put('node_modules/@eslint/js/package.json', JSON.stringify({ name: '@eslint/js', type: 'module', types: 'index.d.ts' }));
  put('node_modules/@eslint/js/index.d.ts', 'declare const js: { configs: { recommended: object } };\nexport default js;\n');
  put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', noEmit: true, skipLibCheck: false }, include: ['eslint.config.ts'] }));
  const tsc = join(pkgDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', d], { encoding: 'utf8' });
  expect(r.stdout + r.stderr).toBe('');
  expect(r.status).toBe(0);
  rmSync(d, { recursive: true, force: true });
});

test('the config edit goes through the repo\'s Prettier, and uninstall still restores it', async () => {
  // A stand-in Prettier that indents the lines a one-line array expansion leaves at column 0.
  const fmt = "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>process.stdout.write(s.replace(/^(\\/\\/ harness:rules|\\.\\.\\.harnessRules,)$/gm,'  $1')));\n";
  const one = "export default [{ ignores: ['.harness/'] }, { rules: {} }];\n";
  const { root, original } = await applied({ 'eslint.config.mjs': one }, { ...withPrettier, 'node_modules/prettier/bin/prettier.cjs': fmt });
  const after = readFileSync(join(root, 'eslint.config.mjs'), 'utf8');
  expect(after).toContain('\n  ...harnessRules,\n');
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string; formatted?: true }[] };
  expect(m.files.find((f) => f.rel === 'eslint.config.mjs')?.formatted).toBe(true);
  expect((await unOut(root)).code).toBe(0);
  expect(readFileSync(join(root, 'eslint.config.mjs'), 'utf8')).toBe(original['eslint.config.mjs']);
});

test('a two-hunk Prettier-formatted config with an edit in the spread is kept whole, and still loads', async () => {
  const fmt = "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>process.stdout.write(s.replace(/^(\\/\\/ harness:rules|\\.\\.\\.harnessRules,)$/gm,'  $1')));\n";
  const src = "const x = { rules: {} };\nconst y = 1;\nconst z = y + 1;\n\nexport default [{ ignores: ['.harness/'] }, x];\n";
  const { root } = await applied({ 'eslint.config.mjs': src }, { ...withPrettier, 'node_modules/prettier/bin/prettier.cjs': fmt });
  const cfg = join(root, 'eslint.config.mjs');
  const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string; replace?: unknown[] }[] };
  expect(m.files.find((f) => f.rel === 'eslint.config.mjs')?.replace).toHaveLength(2);
  const edited = readFileSync(cfg, 'utf8').replace('  ...harnessRules,\n', '  ...harnessRules, // mine\n');
  writeFileSync(cfg, edited);
  git(root, 'commit', '-qam', 'mine');
  const r = await unOut(root);
  expect(r.code).toBe(0);
  expect(readFileSync(cfg, 'utf8')).toBe(edited);
  expect(r.out).toContain('Remove these by hand');
  expect(r.out).toContain("import harnessRules from './.harness/eslint/harness.config.mjs';");
  const loaded = (await import(`${pathToFileURL(cfg).href}?t=${Date.now()}`)) as { default: unknown[] };
  expect(Array.isArray(loaded.default)).toBe(true);
});

describe('TS options', () => {
  const TSCONFIG = '{\n  "compilerOptions": {\n    "target": "es2022"\n  },\n  "include": ["app"]\n}\n';
  const ERRORS: Record<string, number> = { noUncheckedIndexedAccess: 4, noImplicitReturns: 2 }; // baseline 1
  /** A fake tsc next to the fake eslint, answered per project file; `seen` gets each project tsc was run on. */
  const withTsc = (root: string, seen: string[] = []): Exec => {
    const dir = join(root, 'node_modules', 'typescript');
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.0.0', bin: { tsc: 'bin/tsc' } }));
    writeFileSync(join(dir, 'bin', 'tsc'), '');
    return (_c, a) => {
      if (a[0]?.endsWith('eslint.js')) return { status: 0, stdout: '[]' };
      const project = a[a.indexOf('-p') + 1] ?? '';
      seen.push(project);
      const o = /tsconfig\.(\w+)\.json$/.exec(project)?.[1];
      return { status: 2, stdout: 'a.ts(1,1): error TS2322: x\n'.repeat(o ? (ERRORS[o] ?? 1) : 1) };
    };
  };
  const tsOpt = (k: string) => `    "${k}": true`;

  test('the preview shows per-option counts; --apply sets the five options; uninstall restores tsconfig byte-identically', async () => {
    const { root, original } = await installed({ 'eslint.config.mjs': ESLINT_CFG, 'tsconfig.json': TSCONFIG });
    const exec = withTsc(root);
    const preview = await run(root, [], prompt(), exec);
    const lines = preview.out.split('\n');
    expect(lines.indexOf('  tsconfig noUncheckedIndexedAccess: 3')).toBeGreaterThan(-1);
    expect(lines.indexOf('  tsconfig noUncheckedIndexedAccess: 3')).toBeLessThan(lines.indexOf('  tsconfig noImplicitReturns: 1'));
    expect(preview.out).toContain(STOP_LINE(4));
    expect(preview.out).toMatch(/Safe to add now \(0 violations\):[^\n]*\n[^\n]*tsconfig noImplicitOverride/);
    expect(preview.out).toContain('+++ b/tsconfig.json');
    expect(snapshot(root)).toBe('');

    expect((await run(root, ['--apply'], prompt('yes'), exec)).code).toBe(0);
    const after = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(after.compilerOptions).toEqual({ target: 'es2022', strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true, noImplicitReturns: true });
    const m = JSON.parse(readFileSync(join(root, '.harness/manifest.json'), 'utf8')) as { files: { rel: string; blocks?: string[] }[] };
    expect(m.files.find((f) => f.rel === 'tsconfig.json')?.blocks).toHaveLength(5);

    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'rules');
    expect((await unOut(root)).code).toBe(0);
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe(original['tsconfig.json']);
  });

  test('an existing strict: false stays, is listed, and is not counted', async () => {
    const cfg = '{\n  "compilerOptions": {\n    "strict": false\n  }\n}\n';
    const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG, 'tsconfig.json': cfg });
    const seen: string[] = [];
    const r = await run(root, ['--apply'], prompt('yes'), withTsc(root, seen));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Left as is, already set in `tsconfig.json`: strict (false)');
    expect(seen.some((s) => s.endsWith('tsconfig.strict.json'))).toBe(false);
    const after = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    expect(after.compilerOptions.strict).toBe(false);
    expect(after.compilerOptions.noImplicitReturns).toBe(true);
  });

  test('a tsconfig with comments gets the lines as a manual step and is not written', async () => {
    const cfg = '{\n  // mine\n  "compilerOptions": {}\n}\n';
    const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG, 'tsconfig.json': cfg });
    const r = await run(root, ['--apply'], prompt('yes'), withTsc(root));
    expect(r.code).toBe(0); // the ESLint part still applies
    expect(r.out).toMatch(/can't edit `tsconfig\.json` safely/);
    expect(r.out).toContain(tsOpt('noUncheckedIndexedAccess'));
    expect(r.out).toContain('  tsconfig noUncheckedIndexedAccess: 3'); // tsc reads comments, so the counts still show
    expect(r.out).not.toContain('+++ b/tsconfig.json');
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe(cfg);
  });

  test('a symlinked tsconfig is never read or written', async () => {
    const { root } = await installed({ 'eslint.config.mjs': ESLINT_CFG });
    const outside = join(mkdtempSync(join(tmpdir(), 'rules-link-')), 'tsconfig.json');
    writeFileSync(outside, TSCONFIG);
    symlinkSync(outside, join(root, 'tsconfig.json'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'link');
    const seen: string[] = [];
    const r = await run(root, ['--apply'], prompt('yes'), withTsc(root, seen));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/`tsconfig\.json` is a symlink/);
    expect(r.out).not.toContain('+++ b/tsconfig.json');
    expect(seen).toEqual([]);
    expect(readFileSync(outside, 'utf8')).toBe(TSCONFIG);
  });
});
