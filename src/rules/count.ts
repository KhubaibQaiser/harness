import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeAtomic } from '../core/atomic.js';
import type { Exec } from '../core/exec.js';
import { ESLINT } from '../install/plan.js';
import type { Proposal } from './propose.js';

export interface Counts {
  eslint: { byRule: Record<string, number>; dropped: { rule: string; plugin: string }[]; error?: string };
  ts: { byOption: Record<string, number | null>; baseline: number | null };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 10;
const MAX_OUTPUT = 50_000_000; // untrusted tool output: ignore anything bigger
const MAX_ERROR = 200;
const RULE_IN_ERROR = /rule ["']([^"']+)["']/;
const TSC_ERROR = /error TS\d+/g;

type Run = ReturnType<Exec>;

/**
 * The tool's JS entry inside the target repo, to run with node: the same on Windows (no .cmd shim) and a timeout kills the real process.
 * null when the package, its package.json or its bin entry cannot be found.
 */
export function resolveBin(root: string, pkg: string, name: string): string | null {
  try {
    const manifest = createRequire(join(root, 'package.json')).resolve(`${pkg}/package.json`);
    const bin = (JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> }).bin;
    const rel = typeof bin === 'string' ? bin : bin?.[name];
    const file = typeof rel === 'string' ? resolve(dirname(manifest), rel) : null;
    return file && existsSync(file) ? file : null;
  } catch {
    return null;
  }
}
interface Ctx { root: string; p: Proposal; exec: Exec; timeoutMs: number; dir: string }
const first = (s: string | undefined) => (s ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, MAX_ERROR) ?? '';

function countEslint(stdout: string, known: (id: string) => boolean): Record<string, number> | string {
  if (stdout.length > MAX_OUTPUT) return 'eslint output too large';
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return 'eslint output was not valid JSON';
  }
  if (!Array.isArray(data)) return 'eslint output was not a list';
  const out: Record<string, number> = {};
  for (const file of data as { messages?: { ruleId?: unknown }[] }[]) {
    for (const m of Array.isArray(file?.messages) ? file.messages : []) {
      if (typeof m?.ruleId === 'string' && known(m.ruleId)) out[m.ruleId] = (out[m.ruleId] ?? 0) + 1;
    }
  }
  return out;
}

function previewConfig(root: string, dropped: string[]): string {
  const repo = ESLINT.map((f) => join(root, f)).find(existsSync);
  const repoImport = repo ? `import repo from ${JSON.stringify(pathToFileURL(repo).href)};` : 'const repo = [];';
  return `${repoImport}
import proposal from './rules-preview.proposal.mjs';
const drop = new Set(${JSON.stringify(dropped)});
const kept = proposal.map((b) => (b.rules ? { ...b, rules: Object.fromEntries(Object.entries(b.rules).filter(([k]) => !drop.has(k))) } : b));
export default [...[].concat(repo), ...kept];
`;
}

async function runEslint({ root, p, exec, timeoutMs, dir }: Ctx): Promise<Counts['eslint']> {
  const dropped: Counts['eslint']['dropped'] = [];
  // jsx-a11y is a whole recommended set: its rule id is the plugin name, so its messages are `jsx-a11y/<rule>`.
  const known = (id: string) => p.rules.some((r) => r.id === id || id.startsWith(`${r.id}/`)) && !dropped.some((d) => d.rule === id);
  writeAtomic(join(dir, 'rules-preview.proposal.mjs'), p.configText);
  const preview = join(dir, 'rules-preview.mjs');
  const bin = resolveBin(root, 'eslint', 'eslint');
  if (!bin) return { byRule: {}, dropped, error: 'eslint is not installed' };
  for (let i = 0; i <= MAX_RETRIES; i++) {
    writeAtomic(preview, previewConfig(root, dropped.map((d) => d.rule)));
    const r: Run = exec(process.execPath, [bin, '--config', preview, '--format', 'json', '--ignore-pattern', '.harness/**', '.'], { timeoutMs, cwd: root });
    if (r.timedOut) return { byRule: {}, dropped, error: 'eslint timed out' };
    if (r.missing) return { byRule: {}, dropped, error: 'eslint is not installed' };
    const bad = r.status > 1 ? RULE_IN_ERROR.exec(r.stderr ?? '')?.[1] : undefined;
    const rule = bad === undefined ? undefined : p.rules.find((x) => x.id === bad);
    if (rule && !dropped.some((d) => d.rule === bad)) {
      dropped.push({ rule: rule.id, plugin: rule.plugin ?? 'eslint' });
      continue;
    }
    if (r.status > 1) return { byRule: {}, dropped, error: first(r.stderr) || `eslint exited ${r.status}` };
    const counted = countEslint(r.stdout, known);
    return typeof counted === 'string' ? { byRule: {}, dropped, error: counted } : { byRule: counted, dropped };
  }
  return { byRule: {}, dropped, error: 'too many rules dropped' };
}

/** Error count of one tsc run, or null when it did not finish. */
function tscErrors(root: string, bin: string, exec: Exec, project: string, timeoutMs: number): number | null {
  const r = exec(process.execPath, [bin, '--noEmit', '--pretty', 'false', '-p', project], { timeoutMs, cwd: root });
  if (r.timedOut || r.missing || r.stdout.length > MAX_OUTPUT) return null;
  const n = r.stdout.match(TSC_ERROR)?.length ?? 0;
  return n === 0 && r.status !== 0 ? null : n; // failed to run (not a type error): unknown, never 0
}

function runTs({ root, p, exec, timeoutMs, dir }: Ctx): Counts['ts'] {
  const options = tsOptions(p);
  const byOption: Record<string, number | null> = Object.fromEntries(options.map((o) => [o, null]));
  const bin = resolveBin(root, 'typescript', 'tsc');
  const baseline = bin ? tscErrors(root, bin, exec, join(root, 'tsconfig.json'), timeoutMs) : null;
  if (baseline === null || !bin) return { byOption, baseline };
  for (const o of options) {
    const file = join(dir, `tsconfig.${o}.json`);
    writeAtomic(file, JSON.stringify({ extends: join(root, 'tsconfig.json'), compilerOptions: { [o]: true } }));
    const n = tscErrors(root, bin, exec, file, timeoutMs);
    byOption[o] = n === null ? null : Math.max(0, n - baseline);
  }
  return { byOption, baseline };
}

const tsOptions = (p: Proposal) => Object.keys(p.ts).filter((o) => /^\w+$/.test(o));

const errText = (e: unknown) => first((e as Error)?.message) || 'failed';

/**
 * Counts what each proposed rule/option would flag today, by running the repo's own eslint and tsc.
 * timeoutMs applies to each run, so the worst case is about 11 eslint runs plus 1 + N tsc runs.
 */
export async function countViolations(root: string, p: Proposal, exec: Exec, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Counts> {
  const ctx: Ctx = { root, p, exec, timeoutMs, dir: join(root, '.harness', 'state') };
  const options = tsOptions(p);
  const files = ['rules-preview.mjs', 'rules-preview.proposal.mjs', ...options.flatMap((o) => [`tsconfig.${o}.json`, `tsconfig.${o}.tsbuildinfo`])];
  try {
    mkdirSync(ctx.dir, { recursive: true });
    const eslint = await runEslint(ctx).catch((e: unknown) => ({ byRule: {}, dropped: [], error: errText(e) }));
    let ts: Counts['ts'];
    try {
      ts = runTs(ctx);
    } catch {
      ts = { byOption: Object.fromEntries(options.map((o) => [o, null])), baseline: null };
    }
    return { eslint, ts };
  } finally {
    for (const f of files) rmSync(join(ctx.dir, f), { force: true });
  }
}
