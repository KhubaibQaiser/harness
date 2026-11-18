// Task 11: harness verify, attended, without the review. Steps are node scripts run unwrapped (sandbox: off) or a fake runner.
// Shared fixtures for the verify-*.test.ts files.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { RunSteps } from '../../src/checks/stop/steps.js';
import { type Contract, type Criterion, setActiveTask, writeContract } from '../../src/done/contract.js';
import { appendRow } from '../../src/done/ledger.js';
import { treeHash } from '../../src/done/tree.js';
import { type Verdict, verdictPath } from '../../src/done/verdict.js';
import { verify, type VerifyDeps } from '../../src/done/verify.js';
import { git, repoWith, type Files } from '../review/repo.js';

export const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
export type Step = { name: string; run: string[] };
export const RES = "const fs=require('fs'),p=require('path');fs.mkdirSync('.harness/results',{recursive:true});fs.writeFileSync('.harness/results/r.json',JSON.stringify({testResults:[{name:p.resolve(process.argv[3]||'test/a.test.ts'),status:'passed',assertionResults:[{fullName:'a works',status:process.argv[2]}]}]}))\n";
export const run = (id: string, cmd: string, expect_exit = 0): Criterion => ({ id, text: `${id} holds`, check: { run: cmd, expect_exit } });
export interface Opts {
  steps?: Step[]; criteria?: Criterion[]; checks?: string[]; files?: Files; deps?: VerifyDeps; args?: string[]; base?: string;
  filesOnly?: boolean; platform?: NodeJS.Platform; setup?: (root: string, c: Contract) => void;
}
export async function runVerify(o: Opts = {}): Promise<Verdict & { code: number; text: string; root: string }> {
  const steps = o.steps ?? [];
  const cfg = `checks:\n  done: true\nsandbox: off\nstop:\n  steps: ${JSON.stringify(steps)}\n`;
  const { root, head } = repoWith({ '.harness/config.yaml': cfg, '.harness/manifest.json': '{"files":[]}\n', 'pass.js': 'process.exit(0)\n', 'fail.js': 'process.exit(1)\n', 'res.js': RES, 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': "test('a works', () => {});\n", ...o.files }, {});
  dirs.push(root);
  const c = writeContract(root, {
    id: 'add-login', title: 'Add login', base: o.base ?? head, approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
    criteria: o.criteria ?? [run('C1', 'node pass.js')], checks: o.checks ?? steps.map((s) => s.name), review: { model: 'sonnet' }, sha256: null,
  });
  setActiveTask(root, c.id);
  if (!o.filesOnly) writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n'); // the work: not only harness files
  o.setup?.(root, c);
  const lines: string[] = [];
  const code = await verify(o.args ?? [], { root, cwd: root, env: {}, out: (l) => lines.push(l), platform: o.platform }, o.deps);
  const p = join(root, verdictPath(git(root, 'rev-parse', 'HEAD').trim(), 'all'));
  let v = {} as Verdict;
  try { v = JSON.parse(readFileSync(p, 'utf8')) as Verdict; } catch { /* no verdict, or the symlink case's user file */ }
  return { ...v, code, text: lines.join('\n'), root };
}
export const row = (root: string, c: Contract, command: string, tree = treeHash(root), criteria: string[] = []) =>
  appendRow(root, { kind: 'run', ts: '2026-11-16T00:00:00Z', session: 's', command, exit: 0, tree, contract: c.sha256!, criteria });
export const blockedRow = (root: string, c: Contract) =>
  appendRow(root, { kind: 'blocked', ts: '2026-11-16T00:00:00Z', session: 's', task: c.id, reason: 'the API key is missing', failing_criteria: ['C1'], tree: treeHash(root), contract: c.sha256! });
export const fake = (r: Awaited<ReturnType<RunSteps>> | (() => never)): VerifyDeps => ({ runSteps: async () => (typeof r === 'function' ? r() : r) });
export const head = (root: string) => git(root, 'rev-parse', 'HEAD').trim();
