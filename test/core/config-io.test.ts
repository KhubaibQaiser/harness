import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { expect, test } from 'vitest';
import { defaults, loadConfig } from '../../src/core/config.js';
import { migrateResultsDir, serializeConfig, validateConfig } from '../../src/core/config-io.js';

const load = (yaml: string) => {
  const d = mkdtempSync(join(tmpdir(), 'h-cfgio-'));
  mkdirSync(join(d, '.harness'));
  writeFileSync(join(d, '.harness/config.yaml'), yaml);
  return loadConfig(d);
};
const errs = (raw: unknown) => {
  const r = validateConfig(raw);
  return r.ok ? [] : r.errors;
};

test('validateConfig names the path', () => {
  expect(errs({ stop: { max_attempts: 0 } })).toEqual(['stop.max_attempts: must be an integer from 1 to 10']);
});

test('validateConfig rejects a results_dir inside .harness/state', () => {
  const msg = 'tdd.results_dir: must not be inside .harness/state (the sandbox denies it there)';
  for (const d of ['.harness/state/x', './.harness/STATE/x', '.harness\\state\\x']) expect(errs({ tdd: { results_dir: d } })).toEqual([msg]);
  expect(errs({ tdd: { results_dir: '.harness/results' } })).toEqual([]);
});

test('validateConfig rejects unknown keys, wrong types, bad enums and bad version', () => {
  expect(errs({ nope: 1 })).toEqual(['nope: unknown key']);
  expect(errs({ checks: { guard: 'yes' } })[0]).toMatch(/^checks\.guard: must be a boolean/);
  expect(errs({ stop: { package_manager: 'pip' } })[0]).toMatch(/^stop\.package_manager: must be one of/);
  expect(errs({ version: 2 })[0]).toMatch(/^version: must be 1/);
  expect(errs(null)).toHaveLength(1);
});

test('validateConfig accepts a partial config, defaults version to 1, accepts package_manager none', () => {
  const r = validateConfig({ stop: { package_manager: 'none' } });
  expect(r.ok && r.config.version).toBe(1);
  expect(r.ok && r.config.stop.package_manager).toBe('none');
});

test('steps accept command objects as written', () => {
  const step = { name: 'lint', run: ['ruff', 'check', '.'] };
  const r = validateConfig({ stop: { steps: ['test', step] } });
  expect(r.ok && r.config.stop.steps).toEqual(['test', step]);
  const l = load('stop:\n  steps:\n    - test\n    - name: lint\n      run: [ruff, check, .]\n');
  expect(l.warnings).toEqual([]);
  expect(l.config.stop.steps).toEqual(['test', step]);
});

test('a bad command step is an error in validateConfig and keeps the default in loadConfig', () => {
  for (const bad of [{ name: 'x', run: [] }, { name: 'x', run: ['a', 1] }, { run: ['a'] }]) {
    expect(errs({ stop: { steps: [bad] } })[0]).toMatch(/^stop\.steps\[0\]/);
  }
  const l = load('stop:\n  steps:\n    - name: x\n      run: []\n');
  expect(l.config.stop.steps).toEqual(defaults().stop.steps);
  expect(l.warnings.join()).toMatch(/stop\.steps/);
});

test('missing version loads fine; a wrong one warns', () => {
  expect(load('checks:\n  guard: true\n').warnings).toEqual([]);
  expect(load('version: 2\n').warnings.join()).toMatch(/version/);
});

test('serializeConfig round-trips with no warnings', () => {
  const l = load(serializeConfig(defaults()));
  expect(l.warnings).toEqual([]);
  expect(l.config).toEqual(defaults());
  const c = defaults();
  c.stop.steps = ['test', { name: 'lint', run: ['ruff', 'check', '.'] }];
  expect(load(serializeConfig(c)).config).toEqual(c);
});

test('serializeConfig writes the header and a comment per section', () => {
  const s = serializeConfig(defaults(), '1.2.3');
  expect(s.startsWith('# .harness/config.yaml — written by harness init 1.2.3. Edit freely; run harness doctor after.\n')).toBe(true);
  for (const k of Object.keys(defaults())) expect(s).toMatch(new RegExp(`^# .+\\n${k}:`, 'm'));
});

test('context section has its comment and the count keys', () => {
  expect(serializeConfig(defaults())).toContain('# Always-loaded context budget. harness context measures it; init, update, add and sync ask before going over.\ncontext:\n  budget_tokens: 2000\n  count: auto\n  count_model: claude-opus-5-5\n');
});

test('config.example.yaml equals serializeConfig(defaults)', () => {
  expect(readFileSync(join(__dirname, '../../templates/config.example.yaml'), 'utf8')).toBe(serializeConfig(defaults()));
});

test('step object with an extra key is an error naming stop.steps[0]', () => {
  expect(errs({ stop: { steps: [{ name: 'x', run: ['a'], env: {} }] } })).toEqual(['stop.steps[0]: unknown key "env"']);
  const l = load('stop:\n  steps:\n    - name: x\n      run: [a]\n      cwd: /\n');
  expect(l.config.stop.steps).toEqual(defaults().stop.steps);
  expect(l.warnings.join()).toMatch(/stop\.steps\[0\]/);
});

test('steps error names the element index', () => {
  expect(errs({ stop: { steps: ['t', { name: 'a', run: ['x'], shell: true }, { name: 'b', run: [] }] } })).toEqual(['stop.steps[1]: unknown key "shell"']);
  expect(errs({ stop: { steps: ['t', 'u', { name: 'b', run: [] }] } })).toEqual(['stop.steps[2].run: must be a non-empty array of strings']);
  expect(errs({ stop: { steps: [{ run: ['a'] }] } })).toEqual(['stop.steps[0].name: must be a non-empty string']);
});

test('__proto__ and constructor keys are unknown-key errors', () => {
  expect(errs(JSON.parse('{"__proto__": {}}'))).toEqual(['__proto__: unknown key']);
  expect(errs({ constructor: 1 })).toEqual(['constructor: unknown key']);
  expect(errs(JSON.parse('{"stop": {"__proto__": 1, "toString": 1}}'))).toEqual(['stop.__proto__: unknown key', 'stop.toString: unknown key']);
  const l = load('"__proto__": {}\nconstructor: 1\n');
  expect(l.warnings.join()).toMatch(/unknown key "__proto__"[\s\S]*unknown key "constructor"/);
  expect(l.config).toEqual(defaults());
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test('migrateResultsDir swaps the old default on its one line, keeping indent, quotes and comment', () => {
  expect(migrateResultsDir('tdd:\n  results_dir: .harness/state/test-results  # x\n')).toBe('tdd:\n  results_dir: .harness/results  # x\n');
  expect(migrateResultsDir("tdd:\n  results_dir: '.harness/state/test-results'\n")).toBe("tdd:\n  results_dir: '.harness/results'\n");
  expect(migrateResultsDir('tdd:\n  results_dir: ".harness/state/test-results"\n')).toBe('tdd:\n  results_dir: ".harness/results"\n');
  expect(migrateResultsDir('tdd:\n  results_dir: build/results\n')).toBeNull();
  expect(migrateResultsDir('a:\n  results_dir: .harness/state/test-results\nb:\n  results_dir: .harness/state/test-results\n')).toBeNull();
});

test('serializeConfig(defaults) passes validateConfig', () => {
  expect(validateConfig(parseYaml(serializeConfig(defaults())))).toEqual({ ok: true, config: defaults() });
});

test('serializeConfig round-trips the new sections', () => {
  const c = defaults();
  c.catalog_version = 3;
  c.project = { ...c.project, type: 'web', compliance: ['gdpr'], team_size: 4, scope_paths: ['src'] };
  c.apps = [{ dir: 'web', kind: 'web', install: ['pnpm i'], start: ['pnpm dev'], ready_url: 'http://localhost:3000', port: 3000, public_facing: true, login: { needed: true, credentials: { file: 'creds.json', keys: ['API_KEY'], env: ['MY_TOKEN'] }, login_url: '/login', post_login: '/' } }];
  c.items = [{ id: 'x', include: 'recommended', selected: true, reason: 'r', addresses: ['a'], pin: '' }];
  c.git.commit_trailer = 'T';
  expect(load(serializeConfig(c)).config).toEqual(c);
  expect(load(serializeConfig(c)).warnings).toEqual([]);
});

test('validateConfig rejects pr_size target above max, accepts equal', () => {
  expect(validateConfig({ pr_size: { target_lines: 500, max_lines: 400 } })).toEqual({ ok: false, errors: ['pr_size.target_lines: must not be greater than pr_size.max_lines'] });
  expect(validateConfig({ pr_size: { target_lines: 400, max_lines: 400 } }).ok).toBe(true);
});

test('validateConfig reports an invalid pr_size value and the default-target hint', () => {
  expect(validateConfig({ pr_size: { max_files: 0 } })).toEqual({ ok: false, errors: ['pr_size.max_files: must be an integer from 1 to 10000'] });
  expect(validateConfig({ pr_size: { max_lines: 100 } })).toEqual({ ok: false, errors: ['pr_size.target_lines: is 200, the default, above pr_size.max_lines (100); set target_lines too'] });
});

test('serializeConfig adds a preset section last, only when set', () => {
  expect(serializeConfig(defaults())).not.toMatch(/preset/);
  const c = { ...defaults(), preset: { id: 'tiny', version: '1', items: ['a'], git: { branch_prefixes: ['feat/'], no_ai_trailer: true, pr_size_warning: false } } };
  const s = serializeConfig(c);
  expect(s).toMatch(/\n# Named preset chosen at init \(rules, skills, git checks\)\.\npreset:\n[\s\S]*$/);
  expect(s.indexOf('# Named preset')).toBeGreaterThan(s.indexOf('# Verification steps'));
  expect(parseYaml(s).preset.id).toBe('tiny');
});
