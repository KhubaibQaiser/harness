import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../core/config-io.js';
import { MIN_CLAUDE_CODE } from '../core/min-claude.js';
import { ManifestError, readManifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { matchesHash } from '../install/text.js';
import { JEST_REPORTER, hasResultsOutput, testConfigChange } from '../install/test-config.js';
import { COVERAGE_HINT, noConfigFile, offCause, srcGlob } from '../install/preset.js';
import { findOnPath, resolveStep, syncCommand } from '../checks/stop/runner.js';
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
    const [file, args, opts] = syncCommand('claude', ['--version']);
    const v = execFileSync(file, args, { ...opts, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
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
  // A gate init turned off on purpose, with what turns it on: worth knowing, not a problem (doctor still exits 0).
  const note = (what: string, next: string) => out(`note ${what}: ${next}`);

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
  else if (!entry || !matchesHash(disp, entry.hash)) fix(`\`${DISPATCH}\` does not match the installed version`, 'run harness update to restore it');
  else ok('dispatcher matches the manifest');
  const rep = manifest.files.find((f) => f.rel === JEST_REPORTER);
  if (rep) {
    const cur = readText(join(root, JEST_REPORTER));
    if (cur === null || !matchesHash(cur, rep.hash)) fix(`\`${JEST_REPORTER}\` is ${cur === null ? 'missing' : 'not the installed version'}`, 'run harness update to restore it');
    else ok('Jest reporter matches the manifest');
  }

  const cfgText = readText(join(root, '.harness/config.yaml'));
  let raw: unknown;
  let parseErr = '';
  try {
    raw = cfgText === null ? undefined : parseYaml(cfgText) ?? {};
  } catch (e) {
    parseErr = (e as Error).message.split('\n')[0];
  }
  const v = cfgText === null ? null : parseErr ? null : validateConfig(raw);
  if (cfgText === null) fix('`.harness/config.yaml` is missing', 'restore it with git checkout -- .harness/config.yaml, or run harness uninstall and then harness init.');
  else if (parseErr) fix(`\`.harness/config.yaml\` is not valid YAML (${parseErr})`, 'fix the YAML, then run harness doctor');
  else if (!v!.ok) fix(`\`.harness/config.yaml\` is invalid (${(v as { errors: string[] }).errors.join('; ')})`, 'fix those keys, then run harness doctor');
  else ok('`.harness/config.yaml` is valid');
  if (!v || !v.ok) return out(`${bad} problem${bad === 1 ? '' : 's'} found.`), 1;
  const config = v.config;
  const facts = detect(root);

  const whereOf = (dir: string) => (dir === '.' ? 'the root package' : `\`${dir}\``);
  // Packages init left out of TDD (test config not safely editable) and still out of it. Doctor never edits their config.
  const left = new Set((manifest.tddOff ?? []).filter((d) => !(config.checks.tdd && config.tdd.paths.includes(srcGlob(d)))));
  for (const p of facts.packages.filter((p) => left.has(p.dir) && p.test !== 'none')) {
    const glob = `\`${srcGlob(p.dir)}\``;
    const addPath = `${config.checks.tdd ? 'add' : 'set checks.tdd to true and add'} ${glob} to tdd.paths in .harness/config.yaml`;
    const r = testConfigChange(p, root, config.tdd.results_dir);
    if (hasResultsOutput(p, root, config.tdd.results_dir)) note(`TDD is off for ${whereOf(p.dir)}`, addPath);
    else if ('manual' in r) note(`TDD is off for ${whereOf(p.dir)} because ${offCause(noConfigFile(p))}`, `do this by hand: ${r.manual.join(' ')}; then ${addPath}`);
    else note(`TDD is off for ${whereOf(p.dir)}`, `${addPath}, then run harness update to add the reporter output`);
  }

  if (config.checks.tdd)
    for (const p of facts.packages.filter((p) => p.test === 'vitest' && config.tdd.coverage_skip.includes(srcGlob(p.dir)))) {
      const what = `the coverage gate is off for ${whereOf(p.dir)}`;
      if (p.noCoverageProvider) note(what, COVERAGE_HINT);
      else fix(what, `run harness update to turn on Vitest coverage, then remove \`${srcGlob(p.dir)}\` from tdd.coverage_skip in .harness/config.yaml`);
    }

  if (config.checks.tdd) {
    const tddPkgs = facts.packages.filter((p) => p.test !== 'none' && !left.has(p.dir)); // same set update checks
    for (const p of tddPkgs) {
      const r = testConfigChange(p, root, config.tdd.results_dir);
      const where = whereOf(p.dir);
      if ('none' in r || ('manual' in r && hasResultsOutput(p, root, config.tdd.results_dir))) ok(`${p.test} reporter output is set up for ${where}`);
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
    if (config.stop.steps.length)
      note("Stop steps were checked against this terminal's PATH", "Claude Code's hooks may see a different one (for example when Claude Code starts from the GUI); if Stop warns that a tool is not on its PATH, make the tool available there");
  }
  if (bad) out(`${bad} problem${bad === 1 ? '' : 's'} found.`);
  return bad ? 1 : 0;
}
