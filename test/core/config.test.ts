import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { configReference, esc, loadConfig } from '../../src/core/config.js';

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
  expect(config.tdd).toEqual({ paths: [], exempt: [], diff_coverage: 80, coverage_skip: [], test_lock: true, results_dir: '.harness/results' });
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

test('results_dir inside .harness/state is an error', () => {
  const msg = '"tdd.results_dir" must not be inside .harness/state (the sandbox denies it there)';
  const e = (dir: string, root = dirWith('.harness/config.yaml', `tdd:\n  results_dir: ${dir}\n`)) => loadConfig(root).errors;
  expect(e('.harness/state/x')).toContain(msg);
  expect(e('./.harness/STATE/x')).toContain(msg);
  const root = emptyDir();
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `tdd:\n  results_dir: ${join(root, '.harness/state/x')}\n`);
  expect(loadConfig(root).errors).toContain(msg);
  writeFileSync(join(root, '.harness/config.yaml'), `tdd:\n  results_dir: ${join(root, '.harness/STATE/x')}\n`);
  const r = loadConfig(root);
  expect(r.errors).toContain(msg);
  expect(r.warnings).toContain(`config: "tdd.results_dir" has an invalid value (must not be inside .harness/state (the sandbox denies it there)); using default`);
});

test('results_dir outside .harness/results warns', () => {
  const msg = "tdd.results_dir is outside .harness/results: protect doesn't cover it; the agent can write test results there with its file tools";
  const w = (dir: string) => loadConfig(dirWith('.harness/config.yaml', `tdd:\n  results_dir: ${dir}\n`)).warnings;
  expect(w('/tmp/x')).toContain(msg);
  expect(w('build/results')).toContain(msg);
  expect(w('.harness/results/sub')).not.toContain(msg);
  expect(w('.harness/RESULTS')).not.toContain(msg); // case-insensitive, like the prefix
  expect(loadConfig(dirWith('.harness/config.yaml', 'checks:\n  tdd: true\n')).warnings).not.toContain(msg);
});

test('configReference lists the results_dir rule', () => {
  expect(configReference().find((r) => r.key === 'tdd.results_dir')?.rule).toBe('must not be inside .harness/state (the sandbox denies it there)');
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

test('errors: only what makes the file invalid; a missing file or an outside results_dir is a warning only', () => {
  expect(loadConfig(emptyDir()).errors).toEqual([]);
  expect(loadConfig(dirWith('.harness/config.yaml', 'tdd:\n  results_dir: /tmp/x\n')).errors).toEqual([]);
  expect(loadConfig(dirWith('.harness/config.yaml', 'checks:\n  tdd: true\n')).errors).toEqual([]);
  expect(loadConfig(dirWith('.harness/config.yaml', 'checks:\n  tdd: "true"\nbogus: 1\n')).errors).toEqual(['"checks.tdd" must be a boolean', 'unknown key "bogus"']);
});

test('N5: a config that cannot be read is reported as a read error, not as invalid YAML', async () => {
  const d = dirWith('.harness/config.yaml', 'checks:\n  tdd: true\n');
  const { RETRY } = await import('../../src/core/atomic.js');
  const saved = { ...RETRY };
  Object.assign(RETRY, { platform: 'win32', sleep: () => {} });
  try {
    const r = loadConfig(d, () => { throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' }); });
    expect(r.errors.join(' ')).toMatch(/could not be read \(EPERM/);
    expect(r.errors.join(' ')).not.toMatch(/YAML/);
    let n = 0;
    expect(loadConfig(d, (p) => { if (n++ < 2) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); }).errors).toEqual([]);
  } finally {
    Object.assign(RETRY, saved);
  }
});

test('sandbox defaults to unattended', () => {
  expect(loadConfig(emptyDir()).config.sandbox).toBe('unattended');
  expect(loadConfig(dirWith('.harness/config.yaml', 'sandbox: always\n')).config.sandbox).toBe('always');
});

test('sandbox: sometimes is an error', () => {
  expect(loadConfig(dirWith('.harness/config.yaml', 'sandbox: sometimes\n')).errors).toEqual(['"sandbox" must be one of unattended, always, off']);
});

test('platform-enforcement config without the new sections loads with no warnings', () => {
  const d = mkdtempSync(join(tmpdir(), 'h-cfg-new-'));
  mkdirSync(join(d, '.harness'));
  writeFileSync(join(d, '.harness/config.yaml'), 'version: 1\nsandbox: always\nchecks:\n  tdd: true\n');
  const l = loadConfig(d);
  expect(l.warnings).toEqual([]);
  expect(l.config.apps).toEqual([]);
  expect(l.config.project.type).toBe('');
  expect(l.config.catalog_version).toBe(0);
});

test('apps[0].port out of range names the element path', () => {
  const app = { dir: 'web', kind: 'web', install: [], start: [], ready_url: '', port: 70000, public_facing: false, login: { needed: false, credentials: { file: '', keys: [], env: [] }, login_url: '', post_login: '' } };
  const d = mkdtempSync(join(tmpdir(), 'h-cfg-port-'));
  mkdirSync(join(d, '.harness'));
  writeFileSync(join(d, '.harness/config.yaml'), JSON.stringify({ apps: [app] }));
  const l = loadConfig(d);
  expect(l.errors).toEqual(['"apps[0].port" must be an integer from 1 to 65535']);
  expect(l.config.apps).toEqual([]);
});

test('budget_tokens default is 2000, and -1 and 1.5 are rejected', () => {
  expect(loadConfig(emptyDir()).config.context).toEqual({ budget_tokens: 2000 });
  for (const v of ['-1', '1.5']) {
    const r = loadConfig(dirWith('.harness/config.yaml', `context:\n  budget_tokens: ${v}\n`));
    expect(r.errors).toEqual(['"context.budget_tokens" must be an integer from 0 to 200000']);
    expect(r.config.context.budget_tokens).toBe(2000);
  }
  expect(loadConfig(dirWith('.harness/config.yaml', 'context:\n  budget_tokens: 0\n')).config.context.budget_tokens).toBe(0);
});

test('esc escapes zero-width and bidi characters', () => {
  for (const c of ['​', '‏', '‪', '‮', '⁠', '⁤', '⁦', '⁩', '﻿']) {
    const e = esc(`a${c}b`);
    expect(e, c.charCodeAt(0).toString(16)).toBe(`a\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}b`);
  }
  expect(esc('plain é text')).toBe('plain é text');
});

test('RAW_CONTROL and CONTROL share the hidden-character set', async () => {
  const { RAW_CONTROL } = await import('../../src/ai/product.js');
  const { CONTROL } = await import('../../src/core/config.js');
  for (const c of ['​', '‏', '⁠', '﻿', '‮', '\u009b']) expect([RAW_CONTROL.test(c), CONTROL.test(c)], c.charCodeAt(0).toString(16)).toEqual([true, true]);
  expect([RAW_CONTROL.test('a\tb\r\n'), CONTROL.test('\t')]).toEqual([false, true]);
});
