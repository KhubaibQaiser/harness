import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';

export interface HarnessConfig {
  checks: Record<'guard' | 'protect' | 'depVerify' | 'multiFile' | 'tdd' | 'stop', boolean>;
  tdd: { paths: string[]; exempt: string[]; diff_coverage: number; test_lock: boolean; results_dir: string };
  multi_file_gate: { generated: string[] };
  unattended: { multi_file_gate: 'block' | 'allow-log' | 'off'; require_reason: boolean };
  stop: { steps: string[]; package_manager: string; max_attempts: number; timeout_s: number; base_ref: string; coverage_globs: string[] };
}

const defaults = (): HarnessConfig => ({
  checks: { guard: true, protect: true, depVerify: true, multiFile: false, tdd: false, stop: true },
  tdd: { paths: [], exempt: [], diff_coverage: 80, test_lock: true, results_dir: '.harness/state/test-results' },
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
// Valid ranges for numeric keys (int = whole numbers only). Out of range, NaN or non-numeric keeps the default.
const RANGES: Record<string, { min: number; max: number; int: boolean }> = {
  'stop.max_attempts': { min: 1, max: 10, int: true },
  'stop.timeout_s': { min: 30, max: 550, int: true }, // 550 fits the 600 s Stop hook timeout
  'tdd.diff_coverage': { min: 0, max: 100, int: false },
};
const GATE = ['block', 'allow-log', 'off'];

const inRange = (p: string, v: unknown): boolean => {
  const r = RANGES[p];
  return !r || (typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max && (!r.int || Number.isInteger(v)));
};

// Overlay `user` onto `base` in place, keeping the default (plus a warning) for unknown or mistyped keys.
function merge(base: Record<string, unknown>, user: Record<string, unknown>, path: string, warnings: string[]): void {
  for (const [k, v] of Object.entries(user)) {
    const p = path ? `${path}.${k}` : k;
    const d = base[k];
    if (d === undefined) warnings.push(`config: unknown key "${p}" ignored`);
    else if (isObj(d)) {
      if (isObj(v)) merge(d, v, p, warnings);
      else warnings.push(`config: "${p}" must be a mapping; using default`);
    } else if (Array.isArray(d) ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === typeof d && (p !== 'unattended.multi_file_gate' || GATE.includes(v as string)) && inRange(p, v)) {
      base[k] = v;
    } else warnings.push(`config: "${p}" has an invalid value${RANGES[p] ? ` (must be ${RANGES[p].int ? 'an integer' : 'a number'} from ${RANGES[p].min} to ${RANGES[p].max})` : ''}; using default`);
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
  merge(config as unknown as Record<string, unknown>, user, '', warnings);
  const rel = relative(join(root, '.harness/state'), resolve(root, config.tdd.results_dir));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) warnings.push('tdd.results_dir is outside .harness/state; the agent could forge test results there');
  return { config, warnings };
}
