import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { defaults, loadConfig } from '../../src/core/config.js';
import { serializeConfig, validateConfig } from '../../src/core/config-io.js';

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
