import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';

const usage = (): string => {
  const lines: string[] = [];
  run([], { root: '/', env: {}, out: (l) => lines.push(l) });
  return lines.join('\n');
};
const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));

test('usage lists add, remove, why and explain', () => {
  for (const c of ['harness remove', 'harness why', 'harness explain', '/harness:add']) expect(usage(), c).toContain(c);
});

test('every `harness <cmd>` in src names a real command', () => {
  const real = new Set(['tdd', 'stats', 'init', 'uninstall', 'update', 'sync', 'doctor', 'status', 'scan', 'catalog', 'validate', 'select', 'git', 'add', 'remove', 'why', 'explain', 'vet', 'report', 'eval', 'context']);
  const prose = new Set(['commands', 'inside', 'dispatcher', 'check', 'files', 'blocked']); // `harness check` in dispatch.ts is a log prefix, not a command
  const bad: string[] = [];
  for (const f of files('src'))
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:\b(?:run|Run|use|Use|then|Then|first)\s+|`)harness ([a-z]+)( [a-z]+)?/g)) {
      if (!real.has(m[1]) && !prose.has(m[1])) bad.push(`${f}: ${m[0]}`);
      if (m[1] === 'catalog' && m[2] === ' validate') bad.push(`${f}: ${m[0]}`);
    }
  expect(bad).toEqual([]);
});

test('usage lists report and eval with their flags', () => {
  for (const c of ['harness report [--days N] [--open] [--export]', 'harness eval [--kind skills|rules|gates] [--runs N] [--max-cost-usd X] [--model M]']) expect(usage(), c).toContain(c);
});

test('usage lists context, and no context apply until it exists', () => {
  expect(usage()).toContain('harness context [--json] [--offline]');
  expect(usage()).not.toContain('context apply');
});

test('report and eval keep exit 2 on bad arguments through the router', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const go = (...a: string[]) => spawnSync('node', [join(process.cwd(), 'dist/cli.mjs'), ...a], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '', CI: '' }, input: '' });
  const bad = go('report', '--days', 'x');
  expect(bad.status).toBe(2);
  expect(bad.stdout).toContain('Usage: harness report');
  // eval refuses (no terminal) before it can spend; the router must reach it and not print the generic usage.
  const r = go('eval', '--runs', '0');
  expect(r.stdout).toContain('harness eval needs a terminal');
});
