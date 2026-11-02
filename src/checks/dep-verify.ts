// Verifies dependency names an allowed install would add. A person still approves every one (ask), unless it is clearly bad (deny).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision } from '../hooks/types.js';
import { syncCommand } from './stop/runner.js';

type Lookup = { exists: boolean; created?: string } | 'error';
export interface VerifyOpts {
  root: string;
  now: Date;
  lookup: (name: string, timeoutMs?: number) => Lookup;
  deadlineMs?: number; // total lookup budget; must fit inside the hook timeout (10 s)
  startedAt?: number; // clock() reading the budget counts from (process start); defaults to this call
  clock?: () => number;
}

const DAY = 86400000;
const MIN_AGE_DAYS = 14;
const UNRESOLVABLE = /^(file:|link:|workspace:|git\+|github:|https?:\/\/|[./])/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const UNVERIFIED = (n: string) => `"${n}": could not verify on the registry`;

// ponytail: npm output is read as JSON text; a changed npm format falls to 'error' (an ask), never a silent allow.
export function parseNpmView(stdout: string, stderr: string): Lookup {
  if (/\bE404\b/.test(stderr) || /\bE404\b/.test(stdout)) return { exists: false };
  try {
    const created = JSON.parse(stdout.trim());
    return typeof created === 'string' ? { exists: true, created } : 'error';
  } catch {
    return 'error';
  }
}

export function defaultLookup(name: string, timeoutMs = 5000): Lookup {
  try {
    const [file, args, opts] = syncCommand('npm', ['view', name, 'time.created', '--json']);
    return parseNpmView(String(execFileSync(file, args, { ...opts, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })), '');
  } catch (e) {
    const err = e as { stdout?: unknown; stderr?: unknown };
    return parseNpmView(String(err.stdout ?? ''), String(err.stderr ?? ''));
  }
}

const stripVersion = (spec: string) => spec.replace(/(?<=.)@.*$/, '');

function packageJsonPaths(root: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '--', '*package.json', 'package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    const found: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') walk(join(rel, e.name));
        else if (e.isFile() && e.name === 'package.json') found.push(join(rel, e.name));
      }
    };
    try { walk(''); } catch { /* unreadable root: no known dependencies */ }
    return found;
  }
}

function repoDependencies(root: string): string[] {
  const names = new Set<string>();
  for (const p of packageJsonPaths(root)) {
    try {
      const json = JSON.parse(readFileSync(join(root, p), 'utf8'));
      for (const f of DEP_FIELDS) Object.keys(json[f] ?? {}).forEach((n) => names.add(n));
    } catch { /* unreadable or invalid package.json: skip */ }
  }
  return [...names];
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

export function verifyPackages(specs: string[], opts: VerifyOpts): Decision {
  const known = repoDependencies(opts.root);
  const denies: string[] = [];
  const asks: string[] = [];
  const clock = opts.clock ?? Date.now;
  const start = clock();
  const budget = opts.deadlineMs ?? 9000;
  const names: string[] = [];
  for (const spec of specs) {
    const name = UNRESOLVABLE.test(spec) ? spec : stripVersion(spec);
    if (names.includes(name)) continue;
    names.push(name);
    if (UNRESOLVABLE.test(spec)) { asks.push(UNVERIFIED(spec)); continue; }
    const remaining = budget - (clock() - (opts.startedAt ?? start));
    if (remaining <= 0) { asks.push(UNVERIFIED(name)); continue; }
    const found = opts.lookup(name, Math.min(5000, remaining));
    if (found === 'error') { asks.push(UNVERIFIED(name)); continue; }
    if (!found.exists) { denies.push(`"${name}" is not on the npm registry (possibly a hallucinated name).`); continue; }
    const created = Date.parse(found.created ?? '');
    if (Number.isNaN(created)) { asks.push(UNVERIFIED(name)); continue; }
    const days = Math.floor((opts.now.getTime() - created) / DAY);
    if (days < MIN_AGE_DAYS) { denies.push(`"${name}" was first published ${days} days ago; packages under ${MIN_AGE_DAYS} days old are blocked.`); continue; }
    const lower = name.toLowerCase();
    if (known.some((k) => k.toLowerCase() === lower)) continue;
    const near = known.find((k) => distance(lower, k.toLowerCase()) <= 2);
    if (near) asks.push(`"${name}" looks like "${near}" already in this repo. Confirm it isn't a typo.`);
  }
  if (denies.length) return { kind: 'deny', reason: denies.join('; '), check: 'dep-verify' };
  return { kind: 'ask', reason: asks.length ? asks.join('; ') : `Confirm adding ${names.join(', ')}.`, check: 'dep-verify' };
}
