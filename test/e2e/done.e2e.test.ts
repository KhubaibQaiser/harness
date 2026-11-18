// Task 11: the built CLI's harness verify in a temp repo, attended. Unwrapped (sandbox: off) everywhere; wrapped in real srt only with HARNESS_E2E_SRT=1.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { type Contract, type Criterion, setActiveTask, TASKS_DIR, writeContract } from '../../src/done/contract.js';
import { appendRow, readLedger } from '../../src/done/ledger.js';
import { treeHash } from '../../src/done/tree.js';
import { git } from '../review/repo.js';
import { SRT_ON } from '../srt-real.js';
import { build, cleanup, DISPATCH, npmVitest, PREFIX } from './fixtures.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli.mjs');
const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_PLAIN_INIT: '1' };
for (const k of ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'HARNESS_SANDBOX', 'HARNESS_TASK']) delete env[k];
const made: string[] = [];
afterAll(() => made.splice(0).forEach(cleanup));

const RES = "const fs=require('fs'),p=require('path');fs.mkdirSync('.harness/results',{recursive:true});fs.writeFileSync('.harness/results/r.json',JSON.stringify({testResults:[{name:p.resolve('test/a.test.ts'),status:'passed',assertionResults:[{fullName:'a works',status:process.argv[2]}]}]}))\n";
const TEST = "test('a works', () => {\n  expect(1).toBe(1);\n});\n";
const CRITERIA: Criterion[] = [
  { id: 'C1', text: 'the build passes', check: { run: 'node pass.js', expect_exit: 0 } },
  { id: 'C2', text: 'a works', check: { test: 'test/a.test.ts::a works' } },
  { id: 'C3', text: 'it looks right', check: { person: 'open the page' } },
];

/** A repo whose stop steps are node scripts, with an approved active contract and a change to src/a.ts. */
function task(o: { lint?: string; result?: string; criteria?: Criterion[] } = {}) {
  const steps = [{ name: 'lint', run: ['node', o.lint ?? 'pass.js'] }, { name: 'test', run: ['node', 'res.js', o.result ?? 'passed'] }];
  const root = build({
    name: 'verify', first: 'src/a.ts', steps: false,
    files: { '.harness/manifest.json': '{"files":[]}\n', '.harness/config.yaml': `checks:\n  done: true\nsandbox: off\nstop:\n  steps: ${JSON.stringify(steps)}\n`, 'pass.js': 'process.exit(0)\n', 'fail.js': 'process.exit(1)\n', 'res.js': RES, 'test/a.test.ts': TEST, 'src/a.ts': 'export const a = 1;\n' },
  });
  made.push(root);
  const c = writeContract(root, {
    id: 'add-login', title: 'Add login', base: git(root, 'rev-parse', 'HEAD').trim(), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z',
    closed_at: null, criteria: o.criteria ?? CRITERIA, checks: ['lint', 'test'], review: { model: 'sonnet' }, sha256: null,
  });
  setActiveTask(root, c.id);
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
  return { root, c };
}
const verify = (root: string) => {
  const r = spawnSync('node', [CLI, 'verify'], { cwd: root, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};
const runRow = (root: string, c: Contract, command: string, tree: string) =>
  appendRow(root, { kind: 'run', ts: new Date().toISOString(), session: 's', command, exit: 0, tree, contract: c.sha256!, criteria: [] });

test('a passing task is done, exit 0, with every item, the person item and the sandbox note', () => {
  const { root } = task();
  const r = verify(root);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toMatch(/--- How to verify ---\nVerdict: done at [0-9a-f]{40} \(tree [0-9a-f]{40}\), task add-login, harness verify/);
  for (const l of ['- lint pass: node pass.js exit 0 (re-run)', '- C1 pass: node pass.js exit 0 (re-run)', '- C2 pass: node res.js passed exit 0 (re-run)', '- person: C3: open the page', 'Stop steps ran without the sandbox (sandbox: off).']) expect(r.out).toContain(l);
});

test('each criterion failing is not done, exit 1', () => {
  const cases: [Parameters<typeof task>[0], string][] = [
    [{ lint: 'fail.js' }, '- lint fail: node fail.js exit 1 (re-run)'],
    [{ criteria: [{ ...CRITERIA[0]!, check: { run: 'node fail.js', expect_exit: 0 } }] }, '- C1 fail: node fail.js exit 1 (re-run)'],
    [{ result: 'failed', criteria: [CRITERIA[1]!] }, '- C2 fail: node res.js failed exit 0 (re-run)'],
  ];
  for (const [o, line] of cases) {
    const r = verify(task(o).root);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('Verdict: not-done');
    expect(r.out).toContain(line);
  }
});

test('a stale pass is re-run, a fresh one reused', () => {
  const { root, c } = task({ lint: 'fail.js' });
  runRow(root, c, 'node fail.js', 'f'.repeat(40)); // a pass at another tree: stale
  expect(verify(root).out).toContain('- lint fail: node fail.js exit 1 (re-run)');
  runRow(root, c, 'node fail.js', treeHash(root));
  const r = verify(root);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('- lint pass: node fail.js exit 0 (reused)');
});

test('weakened tests are not done', () => {
  const { root } = task();
  writeFileSync(join(root, 'test/a.test.ts'), TEST.replace("test('a works'", "test.skip('a works'"));
  const r = verify(root);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('tamper: test/a.test.ts: .skip( added');
});

test('an edited contract is not done', () => {
  const { root } = task();
  const f = join(root, TASKS_DIR, 'add-login.json');
  writeFileSync(f, readFileSync(f, 'utf8').replace('Add login', 'Add anything'));
  const r = verify(root);
  expect(r.code, r.out).toBe(1);
  expect(r.out).toContain('changed since it was approved');
});

test('blocked exits 3 and says why', () => {
  const { root, c } = task();
  appendRow(root, { kind: 'blocked', ts: new Date().toISOString(), session: 's', task: c.id, reason: 'the API key is missing', failing_criteria: [], tree: treeHash(root), contract: c.sha256! });
  const r = verify(root);
  expect(r.code, r.out).toBe(3);
  expect(r.out).toContain('Blocked: the API key is missing');
});

// M4 (ship audit 2026-11-18): a real init's .gitignore ignores .harness/state, logs, backup and results, and the tree hash
// failed on them (git 2.46+ refuses an exclude pathspec naming an ignored path), so verify read not-done and the ledger wrote nothing.
test("after a real init, with its .gitignore, verify is done and the ledger hook writes its row", () => {
  const root = build(npmVitest());
  made.push(root);
  const cfgDir = mkdtempSync(join(tmpdir(), PREFIX));
  made.push(cfgDir);
  const cfg = join(cfgDir, 'answers.yaml');
  writeFileSync(cfg, `checks:\n  done: true\nsandbox: off\nstop:\n  steps:\n    - name: ok\n      run: ["node", "pass.js"]\n`);
  const i = spawnSync('node', [CLI, 'init', '--config', cfg, '--yes'], { cwd: root, encoding: 'utf8', env });
  expect(i.status, i.stdout + i.stderr).toBe(0);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.harness/state/');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'install');
  writeFileSync(join(root, 'pass.js'), 'process.exit(0)\n');
  const c = writeContract(root, { id: 'add-login', title: 'Add login', base: git(root, 'rev-parse', 'HEAD').trim(), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null, criteria: [CRITERIA[0]!], checks: ['ok'], review: { model: 'sonnet' }, sha256: null });
  setActiveTask(root, c.id);
  // The ledger path: the installed dispatcher records a matched Bash run, stamped with the tree hash.
  const h = spawnSync('node', [join(root, DISPATCH)], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'node pass.js' }, tool_response: { stdout: '', stderr: '', interrupted: false } }) });
  expect(h.status, h.stdout + h.stderr).toBe(0);
  expect(h.stdout + h.stderr).not.toContain('tree hash');
  expect(readLedger(root).filter((r) => r.kind === 'run')).toMatchObject([{ command: 'node pass.js', exit: 0, tree: treeHash(root), criteria: ['C1'] }]);
  const r = verify(root);
  expect(r.code, r.out).toBe(0);
  expect(r.out).not.toContain('tree hash');
  expect(r.out).toMatch(/Verdict: done at [0-9a-f]{40} \(tree [0-9a-f]{40}\)/);
});

describe.skipIf(!SRT_ON)('harness verify inside real srt', () => {
  test('a passing task runs its checks wrapped and is done', () => {
    const root = build(npmVitest());
    made.push(root);
    const cfgDir = mkdtempSync(join(tmpdir(), PREFIX));
    made.push(cfgDir);
    const cfg = join(cfgDir, 'answers.yaml');
    writeFileSync(cfg, `checks:\n  done: true\nstop:\n  steps:\n    - name: ok\n      run: ["node", "-e", "0"]\n`);
    const i = spawnSync('node', [CLI, 'init', '--config', cfg, '--yes'], { cwd: root, encoding: 'utf8', env });
    expect(i.status, i.stdout + i.stderr).toBe(0);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'install');
    writeFileSync(join(root, 'pass.js'), 'process.exit(0)\n');
    const c = writeContract(root, { id: 'add-login', title: 'Add login', base: git(root, 'rev-parse', 'HEAD').trim(), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null, criteria: [CRITERIA[0]!], checks: ['ok'], review: { model: 'sonnet' }, sha256: null });
    setActiveTask(root, c.id);
    const r = verify(root);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('without the sandbox');
  });
});
