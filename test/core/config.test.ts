import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/core/config.js';

const emptyDir = () => mkdtempSync(join(tmpdir(), 'h-cfg-'));
function dirWith(rel: string, body: string) {
  const d = emptyDir();
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), body);
  return d;
}

test('missing config yields defaults, a warning, and tdd/multiFile disabled', () => {
  const { config, warnings } = loadConfig(emptyDir());
  expect(config.checks.tdd).toBe(false);
  expect(config.checks.multiFile).toBe(false);
  expect(config.checks.guard).toBe(true);
  expect(warnings[0]).toMatch(/config\.yaml not found/);
  expect(config.stop).toEqual({
    steps: ['format:check', 'lint', 'typecheck', 'test'],
    package_manager: 'pnpm',
    max_attempts: 3,
    timeout_s: 540,
    base_ref: 'origin/main',
    coverage_globs: ['**/coverage/coverage-final.json'],
  });
  expect(config.tdd).toEqual({ paths: [], exempt: [], diff_coverage: 80, coverage_skip: [], test_lock: true, results_dir: '.harness/state/test-results' });
  expect(config.multi_file_gate.generated).toEqual([]);
  expect(config.unattended.multi_file_gate).toBe('block');
});

test('invalid YAML yields defaults and a warning, no throw', () => {
  expect(loadConfig(dirWith('.harness/config.yaml', 'tdd: [')).warnings[0]).toMatch(/invalid/);
});

test('file values are deep-merged over defaults; tdd/multiFile default false when file exists', () => {
  const { config, warnings } = loadConfig(dirWith('.harness/config.yaml', 'checks:\n  tdd: true\n  guard: false\nstop:\n  max_attempts: 5\n'));
  expect(warnings).toEqual([]);
  expect(config.checks.tdd).toBe(true);
  expect(config.checks.multiFile).toBe(false);
  expect(config.checks.guard).toBe(false);
  expect(config.checks.stop).toBe(true);
  expect(config.stop.max_attempts).toBe(5);
  expect(config.stop.timeout_s).toBe(540);
});

test('wrongly typed or unknown values warn and fall back to the default', () => {
  const { config, warnings } = loadConfig(
    dirWith('.harness/config.yaml', 'stop:\n  max_attempts: lots\ntdd:\n  paths: nope\nunattended:\n  multi_file_gate: sometimes\nbogus: 1\nchecks:\n  guard: maybe\n'),
  );
  expect(config.stop.max_attempts).toBe(3);
  expect(config.tdd.paths).toEqual([]);
  expect(config.unattended.multi_file_gate).toBe('block');
  expect(config.checks.guard).toBe(true);
  expect(warnings.join('\n')).toMatch(/stop\.max_attempts/);
  expect(warnings.join('\n')).toMatch(/tdd\.paths/);
  expect(warnings.join('\n')).toMatch(/unattended\.multi_file_gate/);
  expect(warnings.join('\n')).toMatch(/checks\.guard/);
  expect(warnings.join('\n')).toMatch(/bogus/);
});

test('warns when tdd.results_dir is outside .harness/state', () => {
  const msg = 'tdd.results_dir is outside .harness/state; the agent could forge test results there';
  const w = (dir: string) => loadConfig(dirWith('.harness/config.yaml', `tdd:\n  results_dir: ${dir}\n`)).warnings;
  expect(w('coverage/results')).toContain(msg);
  expect(w('../x')).toContain(msg);
  expect(w('.harness/state/other')).not.toContain(msg);
  expect(loadConfig(dirWith('.harness/config.yaml', 'checks:\n  tdd: true\n')).warnings).not.toContain(msg);
});

test('unattended.require_reason defaults false and loads without warning', () => {
  expect(loadConfig(dirWith('.harness/config.yaml', 'x: 1\n')).config.unattended.require_reason).toBe(false);
  const r = loadConfig(dirWith('.harness/config.yaml', 'unattended:\n  require_reason: true\n'));
  expect(r.config.unattended.require_reason).toBe(true);
  expect(r.warnings).toEqual([]);
});

test('numeric keys reject NaN, negatives and non-integers', () => {
  const cases: [string, string, number][] = [
    ['stop.max_attempts', '-1', 3],
    ['stop.max_attempts', '11', 3],
    ['stop.max_attempts', '2.5', 3],
    ['stop.timeout_s', '.nan', 540],
    ['stop.timeout_s', '29', 540],
    ['stop.timeout_s', '551', 540],
    ['tdd.diff_coverage', '101', 80],
    ['tdd.diff_coverage', '-1', 80],
    ['tdd.diff_coverage', '.nan', 80],
  ];
  for (const [key, val, dflt] of cases) {
    const [a, b] = key.split('.');
    const { config, warnings } = loadConfig(dirWith('.harness/config.yaml', `${a}:\n  ${b}: ${val}\n`));
    expect((config as never as Record<string, Record<string, number>>)[a][b]).toBe(dflt);
    expect(warnings.join('\n')).toContain(key);
  }
  const ok = loadConfig(dirWith('.harness/config.yaml', 'stop:\n  max_attempts: 10\n  timeout_s: 30\ntdd:\n  diff_coverage: 55.5\n'));
  expect(ok.warnings).toEqual([]);
  expect([ok.config.stop.max_attempts, ok.config.stop.timeout_s, ok.config.tdd.diff_coverage]).toEqual([10, 30, 55.5]);
});
