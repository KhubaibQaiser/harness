import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../core/config-io.js';
import { matches } from '../core/paths.js';
import { MIN_CLAUDE_CODE } from '../core/min-claude.js';
import { ManifestError, readManifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { sha256 } from '../install/text.js';
import { testConfigChange } from '../install/test-config.js';
import { findOnPath, resolveStep } from '../checks/stop/runner.js';
import type { CliEnv } from './index.js';

export type DoctorDeps = { claudeVersion?: () => string | null };

const DISPATCH = '.harness/hooks/dispatch.mjs';
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
const NODE_MIN = [22, 11, 0];
const nums = (v: string) => v.split('.').map(Number);
const older = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

function claudeVersion(): string | null {
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\d+\.\d+\.\d+/.exec(v)?.[0] ?? null;
  } catch {
    return null;
  }
}

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export function doctor(args: string[], cli: CliEnv, deps: DoctorDeps = {}): number {
  const { root, env, out } = cli;
  if (args.length) return out('Usage: harness doctor'), 2;
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!manifest) return out('Harness is not installed here (no `.harness/manifest.json`). Run harness init to install it.'), 1;

  let bad = 0;
  const ok = (s: string) => out(`ok ${s}`);
  const fix = (what: string, next: string) => (bad++, out(`fix ${what}: ${next}`));

  const node = process.versions.node;
  if (older(nums(node), NODE_MIN)) fix(`Node ${node} is too old`, 'install Node 22.11 or newer');
  else ok(`Node ${node}`);

  const cv = (deps.claudeVersion ?? claudeVersion)();
  if (cv === null) ok('Claude Code not found: hooks still run when Claude Code is installed');
  else if (older(nums(cv), nums(MIN_CLAUDE_CODE))) fix(`Claude Code ${cv} is older than ${MIN_CLAUDE_CODE}`, 'update Claude Code');
  else ok(`Claude Code ${cv}`);

  let settings: any = null;
  const st = readText(join(root, '.claude/settings.json'));
  try {
    settings = st === null ? null : JSON.parse(st);
  } catch {}
  const wired = (ev: string) =>
    Array.isArray(settings?.hooks?.[ev]) && settings.hooks[ev].some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(DISPATCH)));
  const unwired = EVENTS.filter((e) => !wired(e));
  if (unwired.length) fix(`\`.claude/settings.json\` does not run the dispatcher for ${unwired.join(', ')}`, 'run harness update to restore the hooks');
  else ok('settings run the dispatcher for all 5 hook events');

  const entry = manifest.files.find((f) => f.rel === DISPATCH);
  const disp = readText(join(root, DISPATCH));
  if (disp === null) fix(`\`${DISPATCH}\` is missing`, 'run harness update to restore it');
  else if (!entry || sha256(disp) !== entry.hash) fix(`\`${DISPATCH}\` does not match the installed version`, 'run harness update to restore it');
  else ok('dispatcher matches the manifest');

  const cfgText = readText(join(root, '.harness/config.yaml'));
  let raw: unknown;
  let parseErr = '';
  try {
    raw = cfgText === null ? undefined : parseYaml(cfgText) ?? {};
  } catch (e) {
    parseErr = (e as Error).message.split('\n')[0];
  }
  const v = cfgText === null ? null : parseErr ? null : validateConfig(raw);
  if (cfgText === null) fix('`.harness/config.yaml` is missing', 'run harness update to restore it');
  else if (parseErr) fix(`\`.harness/config.yaml\` is not valid YAML (${parseErr})`, 'fix the YAML, then run harness doctor');
  else if (!v!.ok) fix(`\`.harness/config.yaml\` is invalid (${(v as { errors: string[] }).errors.join('; ')})`, 'fix those keys, then run harness doctor');
  else ok('`.harness/config.yaml` is valid');
  if (!v || !v.ok) return out(`${bad} problem${bad === 1 ? '' : 's'} found.`), 1;
  const config = v.config;
  const facts = detect(root);

  if (config.checks.tdd) {
    // ponytail: a package counts as TDD when a probe file under its src/ matches tdd.paths.
    const tddPkgs = facts.packages.filter((p) => p.test !== 'none' && matches(`${p.dir === '.' ? '' : p.dir + '/'}src/__probe__.ts`, config.tdd.paths));
    for (const p of tddPkgs) {
      const r = testConfigChange(p, root, config.tdd.results_dir);
      const where = p.dir === '.' ? 'the root package' : `\`${p.dir}\``;
      if ('none' in r) ok(`${p.test} reporter output is set up for ${where}`);
      else if ('change' in r) fix(`\`${r.change.rel}\` lacks the JSON reporter output the TDD gate reads`, 'run harness update to add it');
      else fix(`the ${p.test} reporter output is not set up for ${where}`, `do this by hand: ${r.manual.join(' ')}`);
    }
  }

  if (config.checks.stop) {
    const scripts = facts.packages.find((p) => p.dir === '.')?.scripts ?? {};
    for (const step of config.stop.steps) {
      const name = typeof step === 'string' ? step : step.name;
      const r = resolveStep(step, config.stop.package_manager, scripts);
      if (!r) fix(`Stop step \`${name}\` has no \`${name}\` script in \`package.json\``, 'add the script or remove the step from `.harness/config.yaml`');
      else if (!findOnPath(r.cmd, env, process.platform)) fix(`Stop step \`${name}\` needs \`${r.cmd}\`, which is not on PATH`, `install \`${r.cmd}\` or remove the step from \`.harness/config.yaml\``);
      else ok(`Stop step \`${name}\` runs with \`${r.cmd}\``);
    }
  }
  if (bad) out(`${bad} problem${bad === 1 ? '' : 's'} found.`);
  return bad ? 1 : 0;
}
