import { existsSync, readFileSync } from 'node:fs';
import { retryTransient } from './atomic.js';
import { join, posix, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { PROJECT_TYPES, type ProjectType } from '../catalog/schema.js';

export type StopStep = string | { name: string; run: string[] };
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';
export type SandboxMode = 'unattended' | 'always' | 'off';

export interface App {
  dir: string;
  kind: 'web' | 'mobile' | 'api';
  install: string[];
  start: string[];
  ready_url: string;
  port: number;
  public_facing: boolean;
  login: { needed: boolean; credentials: { file: string; keys: string[]; env: string[] }; login_url: string; post_login: string };
}
export interface Selected {
  id: string;
  include: 'recommended' | 'optional';
  selected: boolean;
  reason: string;
  addresses: string[];
  /** The sha, the npm version, or ''. */
  pin: string;
}

export interface HarnessConfig {
  version: 1;
  checks: Record<'guard' | 'protect' | 'depVerify' | 'multiFile' | 'tdd' | 'stop', boolean>;
  sandbox: SandboxMode;
  /** 0 means no catalog. */
  catalog_version: number;
  project: {
    type: '' | ProjectType;
    domain: string;
    compliance: string[];
    data_handling: string;
    team_size: number;
    open_source: boolean;
    /** Recommend input only. */
    codeowners: string[];
    deploy_target: string;
    run_budget_usd: number;
    named_items: string[];
    scope_paths: string[];
  };
  apps: App[];
  items: Selected[];
  git: { commit_trailer: string };
  context: { budget_tokens: number };
  tdd: { paths: string[]; exempt: string[]; diff_coverage: number; coverage_skip: string[]; test_lock: boolean; results_dir: string };
  multi_file_gate: { generated: string[] };
  pr_size: { target_lines: number; max_lines: number; max_files: number; exclude: string[] };
  unattended: { multi_file_gate: 'block' | 'allow-log' | 'off'; require_reason: boolean };
  stop: { steps: StopStep[]; package_manager: PackageManager; max_attempts: number; timeout_s: number; base_ref: string; coverage_globs: string[] };
}

export const DEFAULT_RESULTS_DIR = '.harness/results';
export const LEGACY_RESULTS_DIR = '.harness/state/test-results';

/** Globs not counted toward a PR's size, in this order. */
export const PR_SIZE_EXCLUDE: string[] = [
  '**/pnpm-lock.yaml', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/bun.lock', '**/bun.lockb', '**/Cargo.lock', '**/poetry.lock',
  '**/uv.lock', '**/Pipfile.lock', '**/Gemfile.lock', '**/composer.lock', '**/go.sum', '**/.!(npm|harness)ignore', '**/__snapshots__/**', '**/*.snap',
];

export const defaults = (): HarnessConfig => ({
  version: 1,
  checks: { guard: true, protect: true, depVerify: true, multiFile: false, tdd: false, stop: true },
  sandbox: 'unattended',
  catalog_version: 0,
  project: { type: '', domain: '', compliance: [], data_handling: '', team_size: 0, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 0, named_items: [], scope_paths: [] },
  apps: [],
  items: [],
  git: { commit_trailer: '' },
  context: { budget_tokens: 2000 }, // DEFAULT_CONTEXT_BUDGET in src/budget/measure.ts; not imported, to keep the hook bundle as is
  tdd: { paths: [], exempt: [], diff_coverage: 80, coverage_skip: [], test_lock: true, results_dir: DEFAULT_RESULTS_DIR },
  multi_file_gate: { generated: [] },
  pr_size: { target_lines: 200, max_lines: 400, max_files: 20, exclude: [...PR_SIZE_EXCLUDE] },
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

/** Regex class body (build the RegExp with the `u` flag): C1 controls, soft hyphen, zero-width, bidi and Unicode tag characters (JSON.stringify already escapes C0). Written with \u escapes so an editor cannot strip them. */
export const HIDDEN_CLASS = '\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff\\u00ad\\u061c\\u180e\\u{e0000}-\\u{e007f}';
/** C0/C1 controls, zero-width and bidi characters: free text from the AI step may not carry them. */
export const CONTROL = new RegExp(`[\\u0000-\\u001f${HIDDEN_CLASS}]`, 'u');
/** Control characters in user-supplied keys become \\uXXXX, so an error line can't drive the terminal. */
export const esc = (s: string): string => JSON.stringify(s).slice(1, -1).replace(new RegExp(`[${HIDDEN_CLASS}]`, 'gu'), (c) => (c.codePointAt(0)! > 0xffff ? `\\u{${c.codePointAt(0)!.toString(16)}}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
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
// Object and list rules: each returns the first failure, with `at` as a path suffix (like stepsRule).
const prefix = (r: Fail, at: string): Fail => (typeof r === 'string' ? { at, msg: r } : { at: at + r.at, msg: r.msg });
const objRule = (spec: Record<string, Rule>): Rule => (v) => {
  if (!isObj(v)) return 'must be a mapping';
  const extra = Object.keys(v).find((k) => !Object.hasOwn(spec, k));
  if (extra !== undefined) return { at: `.${esc(extra)}`, msg: 'unknown key' };
  for (const [k, r] of Object.entries(spec)) {
    const bad = r(v[k]);
    if (bad) return prefix(bad, `.${k}`);
  }
  return null;
};
const listOf = (what: string, rule: Rule): Rule => (v) => {
  if (!Array.isArray(v)) return `must be a list of ${what}`;
  for (let i = 0; i < v.length; i++) {
    const bad = rule(v[i]);
    if (bad) return prefix(bad, `[${i}]`);
  }
  return null;
};
const str: Rule = (v) => (typeof v === 'string' ? null : 'must be a string');
const bool: Rule = (v) => (typeof v === 'boolean' ? null : 'must be a boolean');
const strs: Rule = (v) => (isStrs(v) ? null : 'must be a list of strings');
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The message never includes the rejected text: a mistaken value may be a secret.
const names = listOf('names', (v) => (typeof v === 'string' && NAME.test(v) ? null : 'must be a name such as API_KEY, not a value'));
/** A repo-relative path with `/` separators and no `..`; '' is allowed (nothing set). */
export const relPathProblem = (v: unknown): string | null =>
  typeof v !== 'string' ? 'must be a string' : v === '' || (!/^([/\\]|[A-Za-z]:)/.test(v) && !v.includes('\\') && !v.split('/').includes('..')) ? null : 'must be a repo-relative path using /, without ..';
const APP_KINDS = ['web', 'mobile', 'api'];
const appRule = objRule({
  dir: str,
  kind: oneOf(...APP_KINDS),
  install: strs,
  start: strs,
  ready_url: str,
  port: num(1, 65535, true),
  public_facing: bool,
  login: objRule({ needed: bool, credentials: objRule({ file: relPathProblem, keys: names, env: names }), login_url: str, post_login: str }),
});
const itemRule = objRule({ id: (v) => (typeof v === 'string' && v !== '' ? null : 'must be a non-empty string'), include: oneOf('recommended', 'optional'), selected: bool, reason: str, addresses: strs, pin: str });
const IN_STATE = 'must not be inside .harness/state (the sandbox denies it there)';
const resultsDirRule: Rule = (v) => {
  if (v === undefined) return IN_STATE; // the README reads this text
  if (typeof v !== 'string') return 'must be a string';
  const p = posix.normalize(v.replace(/\\/g, '/')).toLowerCase();
  return p === '.harness/state' || p.startsWith('.harness/state/') ? IN_STATE : null;
};
const RULES: Record<string, Rule> = {
  'tdd.results_dir': resultsDirRule,
  version: (v) => (v === 1 ? null : 'must be 1'),
  'stop.max_attempts': num(1, 10, true),
  'stop.timeout_s': num(30, 550, true), // 550 fits the 600 s Stop hook timeout
  'tdd.diff_coverage': num(0, 100, false),
  'unattended.multi_file_gate': oneOf('block', 'allow-log', 'off'),
  'stop.package_manager': oneOf('npm', 'pnpm', 'yarn', 'bun', 'none'),
  'stop.steps': stepsRule,
  sandbox: oneOf('unattended', 'always', 'off'),
  'project.type': (v) => (v === '' ? null : oneOf(...PROJECT_TYPES)(v)), // '' means not set yet
  'project.team_size': num(0, 10000, true),
  'project.run_budget_usd': num(0, 100000, false),
  'context.budget_tokens': num(0, 200000, true),
  'pr_size.target_lines': num(1, 100000, true),
  'pr_size.max_lines': num(1, 100000, true),
  'pr_size.max_files': num(1, 10000, true),
  apps: listOf('app mappings', appRule),
  items: listOf('item mappings', itemRule),
};

function problem(p: string, v: unknown, d: unknown): Fail | null {
  const rule = RULES[p];
  if (rule) return rule(v);
  if (Array.isArray(d)) return isStrs(v) ? null : 'must be a list of strings';
  return typeof v === typeof d ? null : `must be ${typeof d === 'boolean' ? 'a boolean' : typeof d === 'number' ? 'a number' : 'a string'}`;
}

/** Rules that span keys; loadConfig and validateConfig (doctor, init) both use this. */
export function crossKeyErrors(c: HarnessConfig): { path: string; detail: string }[] {
  const { target_lines: t, max_lines: m } = c.pr_size;
  if (t <= m) return [];
  const detail = t === defaults().pr_size.target_lines ? `is ${t}, the default, above pr_size.max_lines (${m}); set target_lines too` : 'must not be greater than pr_size.max_lines';
  return [{ path: 'pr_size.target_lines', detail }];
}

export type Issue = { path: string; kind: 'unknown' | 'mapping' | 'invalid'; detail?: string };

// Overlay `user` onto `base` in place; unknown, mistyped or out-of-range keys keep the default and are reported.
export function overlay(base: Record<string, unknown>, user: Record<string, unknown>, path: string, issues: Issue[]): void {
  for (const [k, v] of Object.entries(user)) {
    const p = path ? `${path}.${esc(k)}` : esc(k);
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

/**
 * `errors` lists what makes the file invalid (bad YAML, a non-mapping, an unknown, mistyped or out-of-range key); each
 * is also in `warnings`. The hooks fail closed on them. A missing file is only a warning: harness is not installed.
 */
export function loadConfig(root: string, read: (p: string, e: 'utf8') => string = readFileSync): { config: HarnessConfig; warnings: string[]; errors: string[] } {
  const config = defaults();
  const file = join(root, '.harness/config.yaml');
  if (!existsSync(file)) return { config, warnings: ['config.yaml not found at .harness/config.yaml; using defaults (tdd and multiFile checks are off)'], errors: [] };
  const warnings: string[] = [];
  const errors: string[] = [];
  const fail = (warning: string, error: string) => (warnings.push(warning), errors.push(error));
  let user: unknown;
  let text: string;
  try {
    text = retryTransient(() => read(file, 'utf8'));
  } catch (e) {
    // A read error is not a bad config: say what happened (still fail closed: the gates can't know the settings).
    const why = (e as Error).message.split('\n')[0];
    fail(`config.yaml could not be read; using defaults (${why})`, `it could not be read (${why}); try again`);
    return { config, warnings, errors };
  }
  try {
    user = parse(text);
  } catch (e) {
    const why = (e as Error).message.split('\n')[0];
    fail(`config.yaml is invalid YAML; using defaults (${why})`, `it is not valid YAML (${why})`);
    return { config, warnings, errors };
  }
  if (user == null) return { config, warnings, errors };
  if (!isObj(user)) {
    fail('config.yaml is invalid: top level must be a mapping; using defaults', 'its top level must be a mapping of keys');
    return { config, warnings, errors };
  }
  const issues: Issue[] = [];
  overlay(config as unknown as Record<string, unknown>, user, '', issues);
  for (const { path: p, kind, detail } of issues) {
    if (kind === 'unknown') fail(`config: unknown key "${p}" ignored`, `unknown key "${p}"`);
    else if (kind === 'mapping') fail(`config: "${p}" must be a mapping; using default`, `"${p}" must be a mapping`);
    else fail(`config: "${p}" has an invalid value (${detail}); using default`, `"${p}" ${detail}`);
  }
  for (const { path: p, detail } of crossKeyErrors(config)) {
    fail('config: "pr_size.target_lines" is greater than pr_size.max_lines; using defaults', `"${p}" ${detail}`);
    config.pr_size.target_lines = defaults().pr_size.target_lines;
    config.pr_size.max_lines = defaults().pr_size.max_lines;
  }
  // An absolute path is judged by its repo-relative form, through the same rule as the text check (ruling 8).
  const rel = relative(root, resolve(root, config.tdd.results_dir)).replace(/\\/g, '/');
  const inState = resultsDirRule(rel);
  if (inState) {
    fail(`config: "tdd.results_dir" has an invalid value (${inState}); using default`, `"tdd.results_dir" ${inState}`);
    config.tdd.results_dir = DEFAULT_RESULTS_DIR;
  } else if (rel.toLowerCase() !== '.harness/results' && !rel.toLowerCase().startsWith('.harness/results/')) {
    warnings.push("tdd.results_dir is outside .harness/results: protect doesn't cover it; the agent can write test results there with its file tools");
  }
  return { config, warnings, errors };
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
