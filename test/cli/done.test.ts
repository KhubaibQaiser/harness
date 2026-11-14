import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { done, DONE_USAGE } from '../../src/cli/done.js';
import { blockedReason } from '../../src/done/commands.js';
import { type Contract, setActiveTask, writeContract } from '../../src/done/contract.js';
import { LEDGER } from '../../src/done/ledger.js';
import { repoWith } from '../review/repo.js';

const contract: Contract = {
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [{ id: 'C1', text: 'it works', check: { test: 'test/a.test.ts::a works' } }, { id: 'C2', text: 'looks right', check: { person: 'open it' } }],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};

function setup(o: { on?: boolean; active?: boolean } = {}) {
  const { root } = repoWith({ 'README.md': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, {});
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  done: ${o.on ?? true}\n`);
  const c = writeContract(root, contract);
  if (o.active ?? true) setActiveTask(root, c.id);
  const lines: string[] = [];
  const call = (args: string[], cwd = root) => ({ code: done(args, { root, cwd, env: {}, out: (l) => lines.push(l) }), text: lines.splice(0).join('\n') });
  return { root, call };
}

test('usage errors exit 2', () => {
  const { call } = setup();
  for (const args of [[], ['--blocked'], ['--blocked', 'a', 'b'], ['--nope', 'a'], ['--blocked', ''], ['--blocked', '  '], ['--blocked', 'a\nb'], ['--blocked', 'x'.repeat(501)]]) {
    const r = call(args);
    expect(r.code, JSON.stringify(args)).toBe(2);
    expect(r.text).toContain(DONE_USAGE);
  }
});

test('a reason the hook would not record exits 2 (round trip with the hook matcher)', () => {
  const { call } = setup();
  const accepted = ['the API key is missing', "can't reach the db", 'x'.repeat(500), 'tests need network, which is off'];
  const rejected = ['a "quoted" word', '$HOME', 'a`b`', 'a;b', 'a&b', 'a|b', 'a>b', 'a<b', '*.ts', '~/x', 'see #12', 'a\\b', '(x)', '{x}', '[x]', 'what?', 'a\tb\nc'];
  for (const r of [...accepted, ...rejected]) {
    const hook = blockedReason(`harness done --blocked "${r}"`) === r;
    expect(call(['--blocked', r]).code === 0, JSON.stringify(r)).toBe(hook);
    expect(hook, JSON.stringify(r)).toBe(accepted.includes(r));
  }
});

test('outside the repo root exits 2, and a symlink to the root is the root', () => {
  const { root, call } = setup();
  mkdirSync(join(root, 'sub'));
  expect(call(['--blocked', 'x'], join(root, 'sub')).code).toBe(2);
  const link = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'r');
  symlinkSync(root, link);
  expect(call(['--blocked', 'x'], link).code).toBe(0);
});

test('checks.done off, or no active contract, exits 1', () => {
  expect(setup({ on: false }).call(['--blocked', 'x']).code).toBe(1);
  expect(setup({ active: false }).call(['--blocked', 'x']).code).toBe(1);
});

test('a valid call prints the failing criteria and the hook note, and writes no ledger', () => {
  const { root, call } = setup();
  const r = call(['--blocked', 'the API key is missing']);
  expect(r.code).toBe(0);
  expect(r.text).toContain('C1');
  expect(r.text).toContain('Blocked is recorded by the harness hook. harness verify now exits 3 (blocked) unless a tamper finding makes it not done.');
  expect(() => readFileSync(join(root, LEDGER))).toThrow();
});
