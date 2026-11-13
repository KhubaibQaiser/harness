import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../core/config-io.js';
import { isObj, LEGACY_RESULTS_DIR, type HarnessConfig } from '../core/config.js';
import { readHookEnv } from '../core/hook-env.js';
import { MIN_CLAUDE_CODE, claudeVersion, olderThan } from '../core/min-claude.js';
import { lastConfigChangeBlocked, lastHarnessFilesChange } from '../core/events.js';
import { LOCK_RECOVERY, LOCK_REL, ManifestError, readManifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { matchesHash } from '../install/text.js';
import { isHarnessHook, mergeEslintFlatIgnores, settingsFragment } from '../install/merge.js';
import { ESLINT } from '../install/plan.js';
import { JEST_REPORTER, hasResultsOutput, resultsRename, testConfigChange } from '../install/test-config.js';
import { coverageHint, noConfigFile, noCoverage, offCause, srcGlob } from '../install/preset.js';
import { findOnPath, resolveStep, syncCommand } from '../checks/stop/runner.js';
import { contextChecks } from './doctor-context.js';
import { decisionChecks } from './doctor-decisions.js';
import { branchProtection, type Gh } from './doctor-protection.js';
import type { CliEnv } from './index.js';
import { dirtyPaths } from '../install/git-status.js';
import { loadCatalog } from '../catalog/load.js';
import { packageDir } from '../core/package-dir.js';
import { LEGACY_PINS, STRUCTURAL, installPins, pinnedPlugins } from '../install/merge.js';
import { pluginList } from '../install/plugin-install.js';
import { reconcile } from '../install/reconcile.js';
import { selectedIds } from '../install/plan.js';

export type DoctorDeps = { claudeVersion?: () => string | null; platform?: NodeJS.Platform; pluginList?: typeof pluginList; gh?: Gh };

const DISPATCH = '.harness/hooks/dispatch.mjs';
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'ConfigChange'];
export const BLOCKING = ['PreToolUse', 'UserPromptSubmit', 'ConfigChange']; // the events whose hook carries onFailure "block"
const SANDBOX_WHY = { unattended: 'required for unattended runs', always: 'on in every session', off: 'text checks only' };
const GH_TIMEOUT_MS = 5000;
const GH_MAX_BUFFER = 1 << 20;
const NODE_MIN_S = '22.11.0';

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export function doctor(args: string[], cli: CliEnv, deps: DoctorDeps = {}): number {
  const { root, env, out } = cli;
  const platform = deps.platform ?? process.platform;
  if (args.length) return out('Usage: harness doctor'), 2;
  let manifest;
  try {
    manifest = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!manifest) return out('Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.'), 1;

  let bad = 0;
  const ok = (s: string) => out(`ok ${s}`);
  const fix = (what: string, next: string) => (bad++, out(`fix ${what}: ${next}`));
  // A gate init turned off on purpose, with what turns it on: worth knowing, not a problem (doctor still exits 0).
  const note = (what: string, next?: string) => out(`note ${what}${next === undefined ? '' : `: ${next}`}`); // no next: the sentence carries its own advice

  if (existsSync(join(root, LOCK_REL))) fix(`${LOCK_REL} exists`, LOCK_RECOVERY);

  const node = process.versions.node;
  if (olderThan(node, NODE_MIN_S)) fix(`Node ${node} is too old`, 'install Node 22.11 or newer');
  else ok(`Node ${node}`);

  const cv = (deps.claudeVersion ?? claudeVersion)();
  if (cv === null) ok('Claude Code not found (or `claude --version` did not answer): hooks still run when Claude Code is installed');
  else if (olderThan(cv, MIN_CLAUDE_CODE)) fix(`Claude Code ${cv} is older than ${MIN_CLAUDE_CODE}`, 'update Claude Code');
  else ok(`Claude Code ${cv}`);

  let settings: any = null;
  const st = readText(join(root, '.claude/settings.json'));
  try {
    settings = st === null ? null : JSON.parse(st);
  } catch {}
  const groups = (ev: string): any[] =>
    (Array.isArray(settings?.hooks?.[ev]) ? settings.hooks[ev] : []).filter((g: any) => Array.isArray(g?.hooks) && g.hooks.some(isHarnessHook));
  const unwired = EVENTS.filter((e) => !groups(e).length);
  if (unwired.length) fix(`\`.claude/settings.json\` does not run the dispatcher for ${unwired.join(', ')}`, 'run /harness:update to restore the hooks');
  else ok(`settings run the dispatcher for all ${EVENTS.length} hook events`);

  const he = readHookEnv(root);
  if (!he) note('no hook has run here yet', 'start a Claude Code session, send a prompt, then run harness doctor again');
  else if (olderThan(he.node.replace(/^v/, ''), NODE_MIN_S)) fix(`hooks run Node ${he.node}, older than 22.11`, 'install Node 22.11 or newer where Claude Code finds it');
  else ok(`hooks run Node ${he.node}`);

  // Each harness group is the fragment's, an older harness's recorded one (update replaces it), or the person's edit.
  const frag = settingsFragment().hooks;
  const recorded = (manifest.files.find((f) => f.rel === '.claude/settings.json')?.blocks ?? []).map((b) => { try { return JSON.parse(b); } catch { return null; } });
  const kind = (ev: string, g: unknown) =>
    frag[ev].some((w: unknown) => isDeepStrictEqual(g, w)) ? 'ok' : recorded.some((b) => isDeepStrictEqual(b, { event: ev, group: g })) ? 'old' : 'edited';

  // Run the PreToolUse hook as Claude Code would: exec form with no shell, or an old shell-form entry through the shell.
  const preGroup = groups('PreToolUse')[0];
  const pre = preGroup?.hooks.find(isHarnessHook);
  const shellForm = (h: any) => !Array.isArray(h.args);
  let shellOld = false; // that line's "run /harness:update" also covers a missing onFailure on the same group
  const dispMissing = readText(join(root, DISPATCH)) === null; // its own line below; a self-test would only add a second
  if (pre && typeof pre.command === 'string' && !dispMissing) {
    const opts = { env: { ...env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8', timeout: 5000 } as const;
    const r = shellForm(pre)
      ? spawnSync(`${pre.command} --self-test`, { ...opts, shell: true })
      : spawnSync(pre.command, [...pre.args.map((a: unknown) => String(a).replaceAll('${CLAUDE_PROJECT_DIR}', root)), '--self-test'], opts);
    if (r.status === 0 && (r.stdout ?? '').startsWith('ok ')) ok('dispatcher runs');
    else fix(`the dispatcher does not run (${(r.stderr ?? '').trim().split('\n')[0] || r.error?.message || `exit code ${r.status}`})`, 'check that node is on the PATH Claude Code gives its hooks, then run harness doctor again');
    shellOld = shellForm(pre) && kind('PreToolUse', preGroup) === 'old';
    if (shellOld) fix('`.claude/settings.json` runs the dispatcher through a shell', 'run /harness:update');
  }

  for (const ev of EVENTS) {
    const gs = groups(ev);
    if (gs.some((g) => kind(ev, g) === 'edited'))
      fix(`\`.claude/settings.json\`: \`hooks.${ev}\` harness hook differs from the one harness installs`, 'undo the edit or delete that group, then run /harness:update');
    else if (BLOCKING.includes(ev) && !(ev === 'PreToolUse' && shellOld) && gs.some((g) => kind(ev, g) === 'old' && g.hooks.some((h: any) => isHarnessHook(h) && h.onFailure !== 'block')))
      fix(`${ev} hook has no onFailure "block"`, 'run /harness:update');
    else {
      const missing = frag[ev].find((w: any) => !gs.some((g) => isDeepStrictEqual(g, w)));
      if (missing) fix(`\`.claude/settings.json\`: \`hooks.${ev}\` is missing the harness group for \`${missing.matcher ?? 'all tools'}\``, 'run /harness:update');
    }
  }

  const entry = manifest.files.find((f) => f.rel === DISPATCH);
  const disp = readText(join(root, DISPATCH));
  // update refuses uncommitted changes to the files it rewrites, so say so up front.
  let dirty: string[] = [];
  try { dirty = dirtyPaths(root); } catch {}
  const restore = (rel: string) => (dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))) ? 'commit or stash your changes, then run /harness:update to restore it' : 'run /harness:update to restore it');
  if (disp === null) fix(`\`${DISPATCH}\` is missing`, restore(DISPATCH));
  else if (!entry || !matchesHash(disp, entry.hash)) fix(`\`${DISPATCH}\` does not match the installed version`, restore(DISPATCH));
  else ok('dispatcher matches the manifest');
  const rep = manifest.files.find((f) => f.rel === JEST_REPORTER);
  if (rep) {
    const cur = readText(join(root, JEST_REPORTER));
    if (cur === null || !matchesHash(cur, rep.hash)) fix(`\`${JEST_REPORTER}\` is ${cur === null ? 'missing' : 'not the installed version'}`, restore(JEST_REPORTER));
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
  if (cfgText === null) fix('`.harness/config.yaml` is missing', 'restore it with git checkout -- .harness/config.yaml, or run harness uninstall and then /harness:init.');
  else if (parseErr) fix(`\`.harness/config.yaml\` is not valid YAML (${parseErr})`, 'fix the YAML, then run harness doctor');
  else if (!v!.ok) fix(`\`.harness/config.yaml\` is invalid (${(v as { errors: string[] }).errors.join('; ')})`, 'fix those keys, then run harness doctor');
  else ok('`.harness/config.yaml` is valid');
  if (!v || !v.ok) return out(`${bad} problem${bad === 1 ? '' : 's'} found.`), 1;
  const config = v.config;
  const facts = detect(root);

  const mode = config.sandbox;
  ok(`sandbox: ${mode} (${SANDBOX_WHY[mode]})`);
  if (mode !== 'off' && platform === 'win32') note('no sandbox on native Windows', 'hooks, permission rules and text checks only');
  const missing = mode !== 'off' && platform === 'linux' ? ['bwrap', 'socat'].filter((c) => !findOnPath(c, env, platform)) : [];
  if (missing.length) (mode === 'always' ? fix : note)(`the Linux sandbox needs bwrap and socat (missing: ${missing.join(', ')})`, 'install them');

  const whereOf = (dir: string) => (dir === '.' ? 'the root package' : `\`${dir}\``);
  // resultsRename, not hasResultsOutput: a Jest script with the harness reporter counts as set up for any folder.
  const legacy = new Set(facts.packages.filter((p) => resultsRename(p, root, config.tdd.results_dir, LEGACY_RESULTS_DIR)).map((p) => p.dir));
  for (const d of legacy) fix(`${whereOf(d)} writes test results under .harness/state, which the sandbox denies`, 'run /harness:update');
  // Packages init left out of TDD (test config not safely editable) and still out of it. Doctor never edits their config.
  const left = new Set((manifest.tddOff ?? []).filter((d) => !(config.checks.tdd && config.tdd.paths.includes(srcGlob(d)))));
  for (const p of facts.packages.filter((p) => left.has(p.dir) && p.test !== 'none' && !legacy.has(p.dir))) {
    const glob = `\`${srcGlob(p.dir)}\``;
    const addPath = `${config.checks.tdd ? 'add' : 'set checks.tdd to true and add'} ${glob} to tdd.paths in .harness/config.yaml`;
    const r = testConfigChange(p, root, config.tdd.results_dir);
    if (hasResultsOutput(p, root, config.tdd.results_dir)) note(`TDD is off for ${whereOf(p.dir)}`, addPath);
    else if ('manual' in r) note(`TDD is off for ${whereOf(p.dir)} because ${offCause(noConfigFile(p))}`, `do this by hand: ${r.manual.join(' ')}; then ${addPath}`);
    else note(`TDD is off for ${whereOf(p.dir)}`, `${addPath}, then run /harness:update to add the reporter output`);
  }

  if (config.checks.tdd) {
    const skipped = (p: (typeof facts.packages)[number]) => config.tdd.coverage_skip.includes(srcGlob(p.dir));
    for (const p of facts.packages.filter((p) => p.test !== 'none' && skipped(p))) {
      const what = `the coverage gate is off for ${whereOf(p.dir)}`;
      if (noCoverage(p)) note(what, coverageHint(p));
      // Coverage not yet turned on in the Vitest config (the provider came later): update can fix it.
      else if (p.test === 'vitest' && 'change' in testConfigChange(p, root, config.tdd.results_dir)) fix(what, `run /harness:update to turn on Vitest coverage, then remove \`${srcGlob(p.dir)}\` from tdd.coverage_skip in .harness/config.yaml`);
      else note(what, `it is listed in tdd.coverage_skip; remove \`${srcGlob(p.dir)}\` from it in .harness/config.yaml to turn the gate on`); // a deliberate choice
    }
    // A Jest coverage config the gate can't read, in a TDD path: every Stop would block on missing coverage.
    for (const p of facts.packages.filter((p) => p.coverageUnreadable && config.tdd.paths.includes(srcGlob(p.dir)) && !skipped(p)))
      fix(`the coverage gate cannot read coverage for ${whereOf(p.dir)} (${p.coverageUnreadable})`, `add \`${srcGlob(p.dir)}\` to tdd.coverage_skip in .harness/config.yaml, or keep 'json' in \`coverageReporters\` and the default \`coverageDirectory\``);
  }

  if (config.checks.tdd) {
    const tddPkgs = facts.packages.filter((p) => p.test !== 'none' && !left.has(p.dir) && !legacy.has(p.dir)); // same set update checks
    for (const p of tddPkgs) {
      const r = testConfigChange(p, root, config.tdd.results_dir);
      const where = whereOf(p.dir);
      if ('none' in r || ('manual' in r && hasResultsOutput(p, root, config.tdd.results_dir))) ok(`${p.test} reporter output is set up for ${where}`);
      else if ('change' in r) fix(`\`${r.change.rel}\` lacks the JSON reporter output the TDD gate reads`, 'run /harness:update to add it');
      else fix(`the ${p.test} reporter output is not set up for ${where}`, `do this by hand: ${r.manual.join(' ')}`);
    }
  }

  const changed = lastHarnessFilesChange(root);
  if (changed) note(`harness files changed during a session at ${changed.ts}: ${changed.files.map((f) => `\`${f}\``).join(', ')}`, 'review the change with git diff -- .harness .claude/settings.json .claude/rules docs/decisions');
  const blocked = lastConfigChangeBlocked(root);
  if (blocked) note(`harness blocked a settings change at ${blocked.ts} (${blocked.reason})`, 'review the file before the next session');
  for (const f of manifest.files.filter((f) => f.unformatted))
    note(`Prettier could not format \`${f.rel}\` when harness edited it`, 'a format check may flag it; if you format it by hand, uninstall reports the harness part it cannot find, to remove by hand');

  if (config.checks.stop) {
    const scripts = facts.packages.find((p) => p.dir === '.')?.scripts ?? {};
    for (const step of config.stop.steps) {
      const name = typeof step === 'string' ? step : step.name;
      const r = resolveStep(step, config.stop.package_manager, scripts);
      if (!r) fix(`Stop step \`${name}\` has no \`${name}\` script in \`package.json\``, 'add the script or remove the step from `.harness/config.yaml`');
      else if (!findOnPath(r.cmd, env, process.platform)) fix(`Stop step \`${name}\` needs \`${r.cmd}\`, which is not on PATH`, `install \`${r.cmd}\` or remove the step from \`.harness/config.yaml\``);
      else ok(`Stop step \`${name}\` runs with \`${r.cmd}\``);
      // A format or lint step that would flag harness's own committed files blocks every Stop.
      const text = typeof step === 'string' ? (scripts[step] ?? '') : step.run.join(' ');
      const ignored = (rel: string) => (readText(join(root, rel)) ?? '').split(/\r?\n/).some((l) => /^\/?\.harness\/?$/.test(l.trim()));
      if (/\bprettier\b/.test(text) && !ignored('.prettierignore'))
        fix(`Stop step \`${name}\` runs Prettier, which checks the committed \`.harness/\` files`, 'add `.harness/` to `.prettierignore`');
      const eslintCfg = ESLINT.find((f) => readText(join(root, f)) !== null);
      if (/\beslint\b/.test(text) && eslintCfg && !ignored('.eslintignore')) {
        const m = mergeEslintFlatIgnores(readText(join(root, eslintCfg))!);
        if (m ? m.blocks.length > 0 : !readText(join(root, eslintCfg))!.includes('.harness'))
          fix(`Stop step \`${name}\` runs ESLint, which lints the \`.harness/\` files`, `add \`{ ignores: ['.harness/'] }\` to the exported array in \`${eslintCfg}\``);
      }
    }
    if (config.stop.steps.length)
      note("Stop steps were checked against this terminal's PATH", "Claude Code's hooks may see a different one (for example when Claude Code starts from the GUI); if Stop warns that a tool is not on its PATH, make the tool available there");
  }
  const gh = deps.gh ?? ((a: string[]) => { const r = spawnSync('gh', a, { cwd: root, env, encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }); return { status: r.status, stdout: r.stdout ?? '' }; });
  const prot = branchProtection(root, gh);
  if (prot.state === 'ok') ok(prot.detail);
  else note(prot.detail);
  if (config.items.length) itemChecks(root, config, manifest, deps.pluginList ?? pluginList, { ok, fix, note });
  contextChecks(root, config, { ok, fix, note });
  decisionChecks(root, config, { ok, fix, note });
  if (bad) out(`${bad} problem${bad === 1 ? '' : 's'} found.`);
  return bad ? 1 : 0;
}

// Claude Code keeps the user-level copy until it is removed; only safe once no repo on the machine still uses the old name.
const LEGACY_FIX = `when no repo on this machine still uses ${LEGACY_PINS}, run claude plugin marketplace remove ${LEGACY_PINS}`;
const EDITED = /harness-pins(-[0-9a-f]{8})? marketplace was edited|^`\.mcp\.json`: .*(was edited|was changed)/;

/** Catalog version, item drift (from reconcile, the same plan sync applies), plugin state and edited entries. Only for installs with an items list. */
function itemChecks(
  root: string, config: HarnessConfig, manifest: NonNullable<ReturnType<typeof readManifest>>,
  list: typeof pluginList, p: { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void },
): void {
  const lc = loadCatalog();
  if (lc.errors.length) return p.note('the catalog has errors, so item checks were skipped', 'reinstall or update harness; run harness catalog check');
  const cat = lc.catalog;
  if (cat.version > config.catalog_version) p.note(`catalog ${cat.version} is newer than this repo's ${config.catalog_version}`, 'run /harness:update');
  else p.ok(`catalog ${config.catalog_version}`);
  const ids = selectedIds(config);
  let planned;
  try {
    planned = reconcile(root, config, manifest, { version: manifest.version, distDir: packageDir('dist'), templatesDir: packageDir('templates'), catalog: cat });
  } catch (e) {
    return p.fix(`the items could not be compared with the files (${(e as Error).message.split('\n')[0]})`, 'fix the file it names, then run harness doctor');
  }
  let settings: any = {};
  try { settings = JSON.parse(readText(join(root, '.claude/settings.json')) ?? '{}') ?? {}; } catch {}
  const enabled: Record<string, unknown> = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  // The shared name lets the last-started repo's pins replace this repo's in Claude Code's user-level marketplace cache.
  const legacy = Object.hasOwn(settings.extraKnownMarketplaces ?? {}, LEGACY_PINS) || Object.keys(enabled).some((k) => k.endsWith(`@${LEGACY_PINS}`));
  if (legacy) p.fix(`\`.claude/settings.json\` uses the shared \`${LEGACY_PINS}\` marketplace name, so another repo's pins can replace this repo's plugins`, `run /harness:update to give this install its own name, then ${LEGACY_FIX}`);
  const seen = new Set<string>();
  const missing = (item: string, rel: string) => seen.has(item + rel) || (seen.add(item + rel), p.fix(`${item} is missing ${rel}`, 'run /harness:sync'));
  for (const c of planned.changes) {
    if (c.kind === 'create' && c.item) missing(c.item, c.rel);
    // A settings or .mcp.json block of an item that harness would add again is missing from the file.
    if (c.kind !== 'delete' && STRUCTURAL.has(c.rel) && !(legacy && c.rel === '.claude/settings.json')) // the rename re-adds every plugin key
      for (const b of c.blocks ?? []) try { const j = JSON.parse(b); if (typeof j?.item === 'string') missing(j.item, c.rel); } catch {}
  }
  if (planned.notes.some((n) => EDITED.test(n))) p.note('the harness-pins marketplace or a harness MCP server differs from what harness installed', 'run /harness:sync');
  const diff = (Object.keys(config.checks) as (keyof typeof config.checks)[]).filter((k) => config.checks[k] !== planned.config.checks[k]);
  if (diff.length) p.note(`config.yaml checks differ from the selected items (${diff.join(', ')}); the items win on the next update. Use /harness:add or harness remove to change gates.`);

  const pinned = pinnedPlugins(cat.items.filter((i) => ids.includes(i.id)));
  if (!pinned.length) return;
  const have = list(); // the one `claude plugin list` call
  if (!have) return p.note('claude is missing or its plugin list is unreadable, so plugin checks were skipped', 'install Claude Code or run harness doctor from a shell where claude works');
  const market = installPins(manifest);
  for (const pin of pinned) {
    const id = `${pin.name}@${market}`;
    const got = have.find((x) => x.id === id);
    if (!got) {
      if (enabled[id] === true) p.fix(`${id} is enabled in this repo but not installed`, `claude plugin install ${id} --scope project`);
      continue;
    }
    const want = cat.items.find((i) => i.id === pin.item)?.plugin_version;
    if (want && got.version && got.version !== want) p.note(`${id} is ${got.version}, the catalog pins ${want}`, `run claude plugin update ${id} --scope project`);
    for (const o of have.filter((x) => x.enabled && x.id !== id && x.id.split('@')[0] === pin.name))
      if (got.enabled || enabled[id] === true) p.note(`${pin.name} is enabled twice (${o.id} and ${market}); only one copy's hooks run. Disable one.`);
  }
}
