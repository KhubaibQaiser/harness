import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { evalCmd } from '../../src/cli/eval.js';
import type { Exec } from '../../src/core/exec.js';
import { mergeAgents, mergeAgentsPreset } from '../../src/install/merge.js';

type Writer = (n: number, out: string) => void;
/** A result.json with `runs` runs spending `cost` in total. */
const spend = (cost: number, runs = 10): Writer => (_n, out) =>
  writeFileSync(join(out, 'result.json'), JSON.stringify({ costUsd: cost, cases: Array.from({ length: runs }, (_, i) => ({ name: `c${i}`, arms: { with: [{ score: 1 }] } })) }));

function harness(write: Writer | null, over: { status?: number; missing?: true } = {}, answers: string[] = ['yes']) {
  const root = mkdtempSync(join(tmpdir(), 'evb-root-'));
  writeFileSync(join(root, 'AGENTS.md'), mergeAgentsPreset(mergeAgents(null).after, 'Rule text.').after);
  const lines: string[] = [];
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push(args);
    if (over.missing) return { status: 127, stdout: '', missing: true };
    const out = args[args.indexOf('--output-dir') + 1]!;
    mkdirSync(out, { recursive: true });
    write?.(calls.length, out);
    return { status: over.status ?? 0, stdout: '', stderr: 'boom' };
  };
  const q = [...answers];
  const prompt = { confirm: async () => false, edit: async (_l: string, v: string) => q.shift() ?? v };
  const cli = { root, env: {}, out: (s: string) => lines.push(s), prompt, exec, tmp: mkdtempSync(join(tmpdir(), 'evb-tmp-')) };
  return { root, lines, calls, run: (a: string[]) => evalCmd(a, cli) };
}
const ceiling = (args: string[]) => args[args.indexOf('--max-cost-usd') + 1];

test('the ceiling caps the whole command: the second kind gets what is left', async () => {
  const h = harness(spend(0.5));
  expect(await h.run(['--model', 'claude-x'])).toBe(0);
  expect(h.calls.map(ceiling)).toEqual(['2', '1.5']);
});

test('the second kind does not start when less than one run is left', async () => {
  const h = harness(spend(1.9, 3)); // 0.63 per run, 0.1 left
  expect(await h.run(['--model', 'claude-x'])).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.lines.join('\n')).toMatch(/not started.*less than one agent run/);
});

test('the second kind does not start when the spend cannot be read', async () => {
  const h = harness((_n, out) => writeFileSync(join(out, 'result.json'), '{bad'));
  expect(await h.run(['--model', 'claude-x'])).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.lines.join('\n')).toMatch(/could not read/i);
});

test('the plan says the ceiling covers all kinds', async () => {
  const h = harness(spend(0.5), {}, ['no']);
  await h.run(['--model', 'claude-x']);
  expect(h.lines.join('\n')).toMatch(/ceiling covers all kinds together/);
});

test('the model id reaches claude unchanged; only the folder is sanitized', async () => {
  const h = harness(spend(0.1));
  expect(await h.run(['--kind', 'rules', '--model', 'claude-opus-5[1m]'])).toBe(0);
  const a = h.calls[0]!;
  expect(a[a.indexOf('--model') + 1]).toBe('claude-opus-5[1m]');
  expect(readdirSync(join(h.root, '.harness/reports/evals'))[0]).toMatch(/-claude-opus-5_1m_-rules$/);
});

test.each(['--bad', 'a b', 'x;rm', '', '-x', 'a'.repeat(101)])('model %j is rejected with exit 2 and nothing runs', async (m) => {
  const h = harness(spend(0.1), {}, [m, 'yes']);
  expect(await h.run(['--kind', 'rules', ...(m ? ['--model', m] : [])])).toBe(2);
  expect(h.calls).toHaveLength(0);
});

test.each(['Infinity', 'NaN', '0', '-1', '0.001'])('--max-cost-usd %s is rejected', async (v) => {
  const h = harness(spend(0.1));
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x', '--max-cost-usd', v])).toBe(2);
  expect(h.calls).toHaveLength(0);
});

test('a missing claude binary is a calm message', async () => {
  const h = harness(null, { missing: true });
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x'])).toBe(1);
  expect(h.lines.join('\n')).toMatch(/not on PATH/);
});

test('a non-zero exit with a result still saves it and returns 1', async () => {
  const h = harness(spend(0.1), { status: 2 });
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x'])).toBe(1);
  expect(readdirSync(join(h.root, '.harness/reports/evals'))).toHaveLength(1);
});

test('an exit with no result is reported', async () => {
  const h = harness(null, { status: 1 });
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x'])).toBe(1);
  expect(h.lines.join('\n')).toMatch(/no result \(exit 1\)/);
});

test('a malformed result is saved but reported calmly', async () => {
  const h = harness((_n, out) => writeFileSync(join(out, 'result.json'), '{bad'));
  expect(await h.run(['--kind', 'rules', '--model', 'claude-x'])).toBe(1);
  expect(h.lines.join('\n')).toMatch(/could not read/i);
});

test('the estimate is last cost per run times the new run count, per kind, and ignores partial results', async () => {
  const h = harness(spend(0.1), {}, ['no']);
  const dir = (n: string) => { const d = join(h.root, '.harness/reports/evals', n); mkdirSync(d, { recursive: true }); return d; };
  const cases = Array.from({ length: 6 }, (_, i) => ({ name: `r${i}-rules`, arms: { with: [{ score: 1 }] } }));
  writeFileSync(join(dir('2026-01-01-claude-x-rules'), 'result.json'), JSON.stringify({ costUsd: 0.6, cases }));
  writeFileSync(join(dir('2026-01-02-claude-x-rules'), 'result.json'), JSON.stringify({ costUsd: 9, partial: true, cases }));
  await h.run(['--kind', 'rules', '--model', 'claude-x', '--runs', '2']);
  // 5 rules x 2 variants x 2 runs = 20 agent runs x $0.10
  expect(h.lines.join('\n')).toContain('Estimate from your last run: ~$2.00');
});

test('temp folders are removed after a decline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evb-root-'));
  writeFileSync(join(root, 'AGENTS.md'), mergeAgentsPreset(mergeAgents(null).after, 'Rule text.').after);
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('harness-eval-')).length;
  const prompt = { confirm: async () => false, edit: async (_l: string, v: string) => (v === '' ? 'no' : v) };
  await evalCmd(['--kind', 'rules', '--model', 'claude-x'], { root, env: {}, out: () => {}, prompt });
  expect(readdirSync(tmpdir()).filter((n) => n.startsWith('harness-eval-')).length).toBe(before);
});
