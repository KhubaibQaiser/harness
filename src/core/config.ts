import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

export type StopStep = string | { name: string; run: string[] };
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';

export interface HarnessConfig {
  version: 1;
  checks: Record<'guard' | 'protect' | 'depVerify' | 'multiFile' | 'tdd' | 'stop', boolean>;
  tdd: { paths: string[]; exempt: string[]; diff_coverage: number; coverage_skip: string[]; test_lock: boolean; results_dir: string };
  multi_file_gate: { generated: string[] };
  unattended: { multi_file_gate: 'block' | 'allow-log' | 'off'; require_reason: boolean };
  stop: { steps: StopStep[]; package_manager: PackageManager; max_attempts: number; timeout_s: number; base_ref: string; coverage_globs: string[] };
}

export const defaults = (): HarnessConfig => ({
  version: 1,
  checks: { guard: true, protect: true, depVerify: true, multiFile: false, tdd: false, stop: true },
  tdd: { paths: [], exempt: [], diff_coverage: 80, coverage_skip: [], test_lock: true, results_dir: '.harness/state/test-results' },
  multi_file_gate: { generated: [] },
  unattended: { multi_file_gate: 'block', require_reason: false },
  stop: {
    steps: ['format:check', 'lint', 'typecheck', 'test'],
    package_manager: 'pnpm',
    max_attempts: 3,
    timeout_s: 540,
    base_ref: 'origin/main',
    coverage_globs: ['**/coverage/coverage-final.json'],
  },
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

// The one table of key rules, shared by loadConfig (lenient) and validateConfig (strict).
// Keys not listed here are checked by the type of their default. Each rule returns the "must be ..." text, or null if v is fine.
type Fail = string | { at: string; msg: string }; // `at` is a path suffix such as [1].run
type Rule = (v: unknown) => Fail | null;
const num = (min: number, max: number, int: boolean): Rule => (v) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v)) ? null : `must be ${int ? 'an integer' : 'a number'} from ${min} to ${max}`;
const oneOf = (...vals: string[]): Rule => (v) => (vals.includes(v as string) ? null : `must be one of ${vals.join(', ')}`);
const stepError = (x: unknown, i: number): Fail | null => {
  if (typeof x === 'string') return null;
  if (!isObj(x)) return { at: `[${i}]`, msg: 'must be a script name or a { name, run } object' };
  const extra = Object.keys(x).find((k) => k !== 'name' && k !== 'run'); // Task 4 runs these, so no env/cwd/shell
  if (extra !== undefined) return { at: `[${i}]`, msg: `unknown key "${extra}"` };
  if (typeof x.name !== 'string' || x.name === '') return { at: `[${i}].name`, msg: 'must be a non-empty string' };
  if (!isStrs(x.run) || x.run.length === 0) return { at: `[${i}].run`, msg: 'must be a non-empty array of strings' };
  return null;
};
const stepsRule: Rule = (v) => {
  if (!Array.isArray(v)) return 'must be a list of script names or { name, run } objects';
  for (let i = 0; i < v.length; i++) {
    const e = stepError(v[i], i);
    if (e) return e;
  }
  return null;
};
const RULES: Record<string, Rule> = {
  version: (v) => (v === 1 ? null : 'must be 1'),
  'stop.max_attempts': num(1, 10, true),
  'stop.timeout_s': num(30, 550, true), // 550 fits the 600 s Stop hook timeout
  'tdd.diff_coverage': num(0, 100, false),
  'unattended.multi_file_gate': oneOf('block', 'allow-log', 'off'),
  'stop.package_manager': oneOf('npm', 'pnpm', 'yarn', 'bun', 'none'),
  'stop.steps': stepsRule,
};

function problem(p: string, v: unknown, d: unknown): Fail | null {
  const rule = RULES[p];
  if (rule) return rule(v);
  if (Array.isArray(d)) return isStrs(v) ? null : 'must be a list of strings';
  return typeof v === typeof d ? null : `must be ${typeof d === 'boolean' ? 'a boolean' : typeof d === 'number' ? 'a number' : 'a string'}`;
}

export type Issue = { path: string; kind: 'unknown' | 'mapping' | 'invalid'; detail?: string };

// Overlay `user` onto `base` in place; unknown, mistyped or out-of-range keys keep the default and are reported.
export function overlay(base: Record<string, unknown>, user: Record<string, unknown>, path: string, issues: Issue[]): void {
  for (const [k, v] of Object.entries(user)) {
    const p = path ? `${path}.${k}` : k;
    const d = Object.hasOwn(base, k) ? base[k] : undefined; // own keys only: no __proto__/constructor lookups
    if (d === undefined) issues.push({ path: p, kind: 'unknown' });
    else if (isObj(d)) {
      if (isObj(v)) overlay(d, v, p, issues);
      else issues.push({ path: p, kind: 'mapping' });
    } else {
      const bad = problem(p, v, d);
      if (bad) issues.push({ path: typeof bad === 'string' ? p : p + bad.at, kind: 'invalid', detail: typeof bad === 'string' ? bad : bad.msg });
      else base[k] = v;
    }
  }
}

export function loadConfig(root: string): { config: HarnessConfig; warnings: string[] } {
  const config = defaults();
  const file = join(root, '.harness/config.yaml');
  if (!existsSync(file)) return { config, warnings: ['config.yaml not found at .harness/config.yaml; using defaults (tdd and multiFile checks are off)'] };
  const warnings: string[] = [];
  let user: unknown;
  try {
    user = parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { config, warnings: [`config.yaml is invalid YAML; using defaults (${(e as Error).message.split('\n')[0]})`] };
  }
  if (user == null) return { config, warnings };
  if (!isObj(user)) return { config, warnings: ['config.yaml is invalid: top level must be a mapping; using defaults'] };
  const issues: Issue[] = [];
  overlay(config as unknown as Record<string, unknown>, user, '', issues);
  for (const { path: p, kind, detail } of issues)
    warnings.push(kind === 'unknown' ? `config: unknown key "${p}" ignored` : kind === 'mapping' ? `config: "${p}" must be a mapping; using default` : `config: "${p}" has an invalid value (${detail}); using default`);
  const rel = relative(join(root, '.harness/state'), resolve(root, config.tdd.results_dir));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) warnings.push('tdd.results_dir is outside .harness/state; the agent could forge test results there');
  return { config, warnings };
}

// For the README generator: every leaf key with its default and the "must be ..." text of its rule (null when only the default's type applies).
export function configReference(): { key: string; default: unknown; rule: string | null }[] {
  const rows: { key: string; default: unknown; rule: string | null }[] = [];
  const walk = (o: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (isObj(v)) walk(v, p);
      else {
        const bad = RULES[p]?.(undefined) ?? null; // undefined is never valid, so a rule answers with its message
        rows.push({ key: p, default: v, rule: bad === null ? null : typeof bad === 'string' ? bad : bad.msg });
      }
    }
  };
  walk(defaults() as unknown as Record<string, unknown>, '');
  return rows;
}
