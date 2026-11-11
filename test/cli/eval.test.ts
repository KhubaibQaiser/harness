import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { evalCmd } from '../../src/cli/eval.js';
import type { Exec } from '../../src/core/exec.js';
import { mergeAgents, mergeAgentsPreset } from '../../src/install/merge.js';

const RESULT = { schemaVersion: 1, costUsd: 0.6, cases: [{ name: 'tdd-rules', aggregates: { score: 1 }, arms: { with: [{ score: 1 }] } }] };
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'evc-root-'));
  writeFileSync(join(root, 'AGENTS.md'), mergeAgentsPreset(mergeAgents(null).after, 'Rule text.').after);
  return root;
}
function harness(answers: string[], env: NodeJS.ProcessEnv = {}, tty?: boolean) {
  const root = setup();
  const lines: string[] = [];
  const calls: string[][] = [];
  const asked: string[] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const out = args[args.indexOf('--output-dir') + 1]!;
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'result.json'), JSON.stringify(RESULT));
    writeFileSync(join(out, 'report.html'), '<html></html>');
    return { status: 0, stdout: '' };
  };
  const q = [...answers];
  const prompt = { confirm: async () => false, edit: async (l: string, v: string) => { asked.push(l); return q.shift() ?? v; } };
  const cli = { root, env, out: (s: string) => lines.push(s), prompt, exec, tmp: mkdtempSync(join(tmpdir(), 'evc-tmp-')), ...(tty === undefined ? {} : { tty }) };
  return { root, lines, calls, asked, run: (a: string[]) => evalCmd(a, cli) };
}

test('yes runs claude with the pinned flags', async () => {
  const h = harness(['claude-x', 'yes']);
  expect(await h.run(['--kind', 'rules'])).toBe(0);
  expect(h.calls).toHaveLength(1);
  const a = h.calls[0]!.join(' ');
  for (const s of ['claude plugin eval', '--ablation none', '--no-publish', '--model claude-x', '--max-cost-usd 2', '--runs 3', '--allow-tools Bash Write Edit']) expect(a).toContain(s);
  const dir = join(h.root, '.harness/reports/evals');
  expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\d-claude-x-rules$/)]);
  expect(existsSync(join(dir, readdirSync(dir)[0]!, 'result.json'))).toBe(true);
  expect(h.lines.join('\n')).toContain('No estimate yet');
});

test.each(['y', 'YES ', '', 'no'])('answer %j does not run claude', async (ans) => {
  const h = harness(['claude-x', ans]);
  expect(await h.run(['--kind', 'rules'])).toBe(1);
  expect(h.calls).toHaveLength(0);
});

test.each([[{ CLAUDECODE: '1' }, undefined], [{ CI: 'true' }, undefined], [{ CI: '1' }, undefined], [{}, false]] as const)('refuses unattended %j %j', async (env, tty) => {
  const h = harness(['claude-x', 'yes'], env, tty);
  expect(await h.run([])).toBe(1);
  expect(h.calls).toHaveLength(0);
  expect(h.asked).toHaveLength(0);
});

test('gates runs with the scaffold and the hooked plugin, after the same yes', async () => {
  const h = harness(['claude-x', 'yes']);
  expect(await h.run(['--kind', 'gates'])).toBe(0);
  expect(h.calls).toHaveLength(1);
  const a = h.calls[0]!;
  expect(a).toContain('--scaffold');
  expect(existsSync(join(a[3]!, 'hooks/dispatch.mjs'))).toBe(true);
  expect(readdirSync(join(h.root, '.harness/reports/evals'))).toEqual([expect.stringMatching(/-claude-x-gates$/)]);
  expect(h.lines.join('\n')).toContain('cases: 4');
});

test('gates: no yes, no run', async () => {
  const h = harness(['claude-x', 'no']);
  expect(await h.run(['--kind', 'gates'])).toBe(1);
  expect(h.calls).toHaveLength(0);
});

test('skills and rules never get the scaffold flag', async () => {
  const h = harness(['claude-x', 'yes']);
  await h.run(['--kind', 'rules']);
  expect(h.calls[0]).not.toContain('--scaffold');
});

test('no kind runs all three', async () => {
  const h = harness(['claude-x', 'yes']);
  await h.run([]);
  expect(h.calls.map((c) => c[3]!.split('/').pop())).toEqual(['skills', 'rules', 'gates']);
});

test('model flag skips the question; earlier result gives an estimate', async () => {
  const h = harness(['yes']);
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x', '--runs', '2'])).toBe(0);
  expect(h.asked).toHaveLength(1);
  const h2 = harness(['yes']);
  const dir = join(h2.root, '.harness/reports/evals/2026-01-01-claude-x-rules');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ costUsd: 0.6, cases: Array.from({ length: 6 }, (_, i) => ({ name: `r${i}-rules`, arms: { with: [{ score: 1 }] } })) }));
  await h2.run(['--kind', 'rules', '--model', 'claude-x']);
  expect(h2.lines.join('\n')).toContain('Estimate from your last run: ~$');
});
