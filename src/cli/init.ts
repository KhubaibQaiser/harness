import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { overlay } from '../core/config.js';
import { validateConfig } from '../core/config-io.js';
import type { HarnessConfig } from '../core/config.js';
import { ApplyError, ManifestError, applyChanges, readManifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { planChanges } from '../install/plan.js';
import { coverageSkipped, coverageWhy, preset, unsafeWhy } from '../install/preset.js';
import { findOnPath } from '../checks/stop/runner.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type { Prompt };
export { planChanges };

export type InitEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; nodeVersion?: string };

const USAGE = 'Usage: harness init [--yes] [--dry-run] [--config <file>]';
const GATES: Record<string, string> = { guard: 'guard', protect: 'protect', depVerify: 'dep-verify', multiFile: 'multi-file', tdd: 'TDD', stop: 'stop' };

const at = (o: any, path: string): unknown => path.split('.').reduce((v, k) => v?.[k], o);

/** Paths git reports as modified, staged or untracked, relative to the repo root (untracked dirs end in "/"). */
function dirtyPaths(root: string): string[] {
  const raw = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') paths.push(raw[++i]);
  }
  return paths;
}

function parseArgs(args: string[]): { yes: boolean; dryRun: boolean; config?: string } | null {
  const o: { yes: boolean; dryRun: boolean; config?: string } = { yes: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes') o.yes = true;
    else if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--config' && args[i + 1] !== undefined) o.config = args[++i];
    else return null;
  }
  return o;
}

export async function init(args: string[], cli: InitEnv): Promise<number> {
  const { out, prompt } = cli;
  const opts = parseArgs(args);
  if (!opts) return out(USAGE), 2;
  if (!opts.yes && !opts.dryRun && cli.tty === false) return out(NO_TTY), 2;

  // 1. Preflight
  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli.root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return out('Not a git repository. Run harness init inside a git repo.'), 1;
  }
  const node = cli.nodeVersion ?? process.versions.node;
  const [major, minor] = node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 11)) return out(`Node ${node} is too old. Harness needs Node 22.11 or newer.`), 1;
  try {
    if (readManifest(root)) return out('Harness is already installed (.harness/manifest.json). Run harness update instead.'), 1;
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }

  // 2. Detect and preset
  const facts = detect(root);
  const p = preset(facts, (cmd) => findOnPath(cmd, cli.env, process.platform));
  let config: HarnessConfig = p.config;
  for (const w of facts.warnings) out(`Warning: ${w}`);
  if (opts.config) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(opts.config, 'utf8'));
    } catch (e) {
      return out(`Could not read ${opts.config}: ${(e as Error).message}`), 2;
    }
    const v = validateConfig(raw);
    if (!v.ok) return v.errors.forEach((m) => out(m)), 2;
    // Overlay onto the preset so a partial file keeps the detected values; the merged result is validated again.
    const merged = structuredClone(p.config);
    overlay(merged as unknown as Record<string, unknown>, raw as Record<string, unknown>, '', []);
    const v2 = validateConfig(merged);
    if (!v2.ok) return v2.errors.forEach((m) => out(m)), 2;
    config = v2.config;
    out(`Using the answers in ${opts.config}.`);
  } else {
    out('Recommended settings:');
    for (const [k, why] of Object.entries(p.reasons)) out(`  ${k} = ${JSON.stringify(at(config, k))}\n    ${why}`);
    if (p.off.length) out('Off for this repo:\n' + p.off.map((o) => `  ${o.gate}: ${o.why}`).join('\n'));
    if (p.skippedSteps.length) out('Stop steps left out:\n' + p.skippedSteps.map((s) => `  ${s.name}: ${s.why}. Install it, then add the step to stop.steps.`).join('\n'));
    if (!opts.yes && !opts.dryRun && (await prompt.confirm('Edit any value? (y/N)'))) {
      const next: Record<string, unknown> = { ...config };
      for (const k of Object.keys(config).filter((k) => k !== 'version')) {
        const cur = JSON.stringify((config as any)[k]);
        const ans = await prompt.edit(k, cur);
        if (ans === cur) continue;
        try {
          next[k] = parseYaml(ans);
        } catch (e) {
          return out(`${k}: not valid JSON or YAML: ${(e as Error).message}`), 2;
        }
      }
      const v = validateConfig(next);
      if (!v.ok) return v.errors.forEach((m) => out(m)), 2;
      config = v.config;
    }
  }

  // 3. Build the changes
  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, config, facts, { version: cli.version, distDir: cli.distDir, templatesDir: cli.templatesDir });
  } catch (e) {
    return out(`Cannot build the install plan: ${(e as Error).message}`), 1;
  }
  const dirty = dirtyPaths(root);
  const touched = plan.changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  if (touched.length && !opts.dryRun) return out(`Commit or stash these files first, so the install can be undone cleanly: ${touched.join(', ')}.`), 1;

  // 4. Plan
  out('Plan:');
  for (const c of plan.changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  // With checks.tdd off the plan skips test configs, but the left-out packages still need their lines.
  const manual = [...new Set([...plan.manual, ...p.tddOff.flatMap((o) => o.manual)])];
  if (manual.length) out('Do these by hand:\n' + manual.map((l) => `  ${l}`).join('\n'));
  for (const n of plan.notes) out(`Note: ${n}`);
  if (opts.dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!opts.yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  // 5. Apply
  try {
    applyChanges(root, plan.changes, cli.version, undefined, undefined, { tddOff: p.tddOff.map((o) => o.dir) });
  } catch (e) {
    if (e instanceof ApplyError) return out(e.message), 1;
    throw e;
  }

  // 6. Report
  const checks = config.checks as Record<string, boolean>;
  const gates = [...Object.keys(GATES).map((k) => [GATES[k], checks[k]] as const), ['coverage', checks.tdd] as const];
  const why = (g: string) => p.off.find((o) => o.gate === g)?.why ?? 'Turned off in the config.';
  out('Gates that are on: ' + gates.filter(([, on]) => on).map(([g]) => g).join(', '));
  const off = gates.filter(([, on]) => !on);
  out('Gates that are off:' + (off.length ? '\n' + off.map(([g]) => `  ${g}: ${why(g)}`).join('\n') : ' none'));
  if (checks.tdd) for (const o of p.tddOff) out(unsafeWhy(o.dir));
  if (checks.tdd) for (const d of coverageSkipped(facts, config)) out(coverageWhy(d));
  out(`Commit these files: ${[...plan.changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  out('Teammates need nothing else: the hooks are in the repo.');
  return 0;
}
