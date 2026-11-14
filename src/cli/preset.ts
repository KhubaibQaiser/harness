import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { DEFAULT_CONTEXT_BUDGET, fmt } from '../budget/measure.js';
import { loadCatalog } from '../catalog/load.js';
import { checkPreset, identityProblems, listPresets, loadPreset, presetContext } from '../catalog/presets.js';
import type { Catalog } from '../catalog/schema.js';
import { CONTROL, esc } from '../core/config.js';
import { packageDir } from '../core/package-dir.js';
import { claudeConfigDir } from '../core/settings-layers.js';
import { ApplyError, LOCK_RECOVERY, applyChanges, type Change } from '../install/apply.js';
import { unifiedDiff } from '../install/diff.js';
import { readManifest, statePaths } from '../install/manifest.js';
import { MergeError, mergeAgentsPreset, mergePresetSettings, presetSets } from '../install/merge.js';
import { PRESET_ITEM, presetFiles } from '../install/plan-preset.js';
import type { CliEnv } from './index.js';
import { NO_TTY, type Prompt } from './prompt.js';

declare const __HARNESS_VERSION__: string;
const VERSION = typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';

export const PRESET_USAGE = 'Usage: harness preset list\n       harness preset check <dir>\n       harness preset install <dir> [--dry-run|--yes]\n       harness preset install <dir> --global [--dry-run|--yes --take <path,...>]';

/** Quotes stay readable; control and hidden characters become \uXXXX so an error line can't drive the terminal. */
const safe = (l: string): string => [...l].map((c) => (CONTROL.test(c) ? `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}` : c)).join('');

/** Every error for each `<id>.yaml` in `dir`, as `<id>: <error>` lines. `builtOnly` adds the shipped-id rule. */
export function checkPresetDir(dir: string, catalog: Catalog, builtOnly: boolean): { id: string; errors: string[] }[] {
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort().map((f) => {
    const r = loadPreset(join(dir, f));
    return { id: f.slice(0, -5), errors: (r.ok ? [...checkPreset(r.loaded, catalog, { builtOnly }), ...identityProblems(r.loaded)] : r.errors).map(safe) };
  });
}

export function preset(args: string[], { root, out }: CliEnv & { home?: string }): number {
  if (args[0] === 'list' && args.length === 1) {
    const all = listPresets(root);
    out(all.length ? all.map((p) => `${esc(p.id)}  ${esc(p.description)}${p.where === 'repo' ? '  (repo)' : ''}`).join('\n') : 'No presets.');
    return 0;
  }
  if (args[0] !== 'check' || args.length !== 2) return out(PRESET_USAGE), 2;
  const r = checkDir(args[1], out);
  if (typeof r === 'number') return r;
  const errors = r.flatMap((x) => x.errors);
  out(errors.length ? errors.join('\n') : 'ok');
  return errors.length ? 1 : 0;
}

/** The folder's per-preset check results, or the exit code after printing why it can't be checked. */
function checkDir(dir: string, out: (s: string) => void): { id: string; errors: string[] }[] | number {
  try { if (!statSync(dir).isDirectory()) return out(`${esc(dir)}: not a folder`), 1; } catch { return out(`${esc(dir)}: no such folder`), 1; }
  const results = checkPresetDir(dir, loadCatalog(packageDir('catalog')).catalog, true);
  return results.length ? results : (out(`${esc(dir)}: no <id>.yaml found`), 1);
}

const filesUnder = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(d, e.name)) : [join(d, e.name)]));

export type PresetEnv = CliEnv & { prompt: Prompt; /** Default `os.homedir()`; tests pass a temp dir. */ home?: string };

/** The global install's manifest, backups and lock, relative to the home folder. */
export const GLOBAL_STATE = statePaths('.claude/harness');
export const GLOBAL_LOCK_RECOVERY = 'A previous global preset install or uninstall was interrupted or could not roll back, so the files under ~/.claude and `~/.claude/harness/manifest.json` may disagree. To recover: 1) open `~/.claude/harness/apply.lock`, which lists the files that run was writing, 2) put each back from its copy under `~/.claude/harness/backup/`, or delete it if it has no copy there, 3) delete `~/.claude/harness/apply.lock`, 4) run the command again.';

/** `preset install <dir> [--global] [--dry-run|--yes [--take <path,...>]]`: checks the folder, then installs it in the repo or under `~/.claude`. */
export async function presetInstall(args: string[], cli: PresetEnv): Promise<number> {
  const { root, out } = cli;
  const ti = args.indexOf('--take');
  const take = ti === -1 ? undefined : args[ti + 1];
  const rest = ti === -1 ? args : args.filter((_, i) => i !== ti && i !== ti + 1);
  const flags = rest.filter((a) => a.startsWith('--'));
  const dirs = rest.filter((a) => !a.startsWith('--'));
  const dryRun = flags.includes('--dry-run'), yes = flags.includes('--yes'), global = flags.includes('--global');
  const badTake = ti !== -1 && (!global || !yes || !take || take.startsWith('--'));
  if (dirs.length !== 1 || flags.some((f) => !['--dry-run', '--yes', '--global'].includes(f)) || (dryRun && yes) || badTake) return out(PRESET_USAGE), 2;
  const [dir] = dirs;
  if (global) {
    if (yes && take === undefined) return out('--yes needs --take <path,...>: name each global write you approved.'), 2;
    const home = cli.home ?? homedir();
    const ccd = claudeConfigDir(home, cli.env);
    // Claude Code never reads the mirror itself; it means this session's CLAUDE_CONFIG_DIR, which the env scrub hid.
    const why = cli.env.CLAUDE_CONFIG_DIR
      ? `CLAUDE_CONFIG_DIR is set to ${esc(ccd)}, so Claude Code would not read ~/.claude`
      : `HARNESS_CLAUDE_CONFIG_DIR is set to ${esc(ccd)} (the launcher's copy of \`CLAUDE_CONFIG_DIR\`), so this Claude Code session reads ${esc(ccd)}, not ~/.claude`;
    // ponytail: refused rather than followed; write to CLAUDE_CONFIG_DIR when someone asks for it.
    if (resolve(home, ccd.replace(/^~(?=[\\/]|$)/, home)) !== resolve(home, '.claude')) return out(`${why}. Unset it, or install the preset at repo level.`), 1;
    if (existsSync(join(home, GLOBAL_STATE.lock))) return out(GLOBAL_LOCK_RECOVERY), 1;
    // ponytail: one global preset at a time; a second one needs per-preset manifests.
    if (existsSync(join(home, GLOBAL_STATE.manifest))) {
      let id = 'unknown';
      try { id = readManifest(home, undefined, GLOBAL_STATE)?.files.find((f) => f.item?.startsWith(PRESET_ITEM))?.item?.slice(PRESET_ITEM.length) ?? id; } catch { /* unreadable: still installed */ }
      return out(`A global preset is already installed (${esc(id)}): ~/${GLOBAL_STATE.manifest} exists. Run \`harness uninstall --global\` first, or keep the installed preset.`), 1;
    }
  }
  const results = checkDir(dir, out);
  if (typeof results === 'number') return results;
  const errors = results.flatMap((r) => r.errors);
  if (errors.length) return out(errors.join('\n')), 1;
  if (global) return globalInstall(dir, results.map((r) => r.id), cli, { dryRun, take: take?.split(',').map((t) => t.replace(/^~\//, '')) });
  const dest = join(root, '.harness', 'presets');
  const rel = (p: string) => relative(root, p).split('\\').join('/');
  for (const { id } of results) {
    const taken = [join(dest, id), join(dest, `${id}.yaml`)].find(existsSync);
    if (taken) return out(`${rel(taken)}${taken.endsWith('.yaml') ? '' : '/'} already exists; remove it first.`), 1;
  }
  const copies = results.flatMap(({ id }) => [[join(dir, `${id}.yaml`), join(dest, `${id}.yaml`)], ...(existsSync(join(dir, id)) ? filesUnder(join(dir, id)).map((f) => [f, join(dest, id, relative(join(dir, id), f))]) : [])]);
  if (!yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;
  out(copies.map(([, to]) => rel(to)).join('\n'));
  if (dryRun) return 0;
  if (!yes) {
    if (!(await cli.prompt.confirm(`Copy these ${copies.length} files into .harness/presets/? [y/N]`))) return out('Cancelled. Nothing was written.'), 0;
  }
  // ponytail: the check and the copy read the tree at different times; safe unless someone races the person's own local install.
  for (const [from, to] of copies) { mkdirSync(join(to, '..'), { recursive: true }); cpSync(from, to); }
  return out(`Installed: ${results.map((r) => r.id).join(', ')}. Choose it in /harness:init or /harness:update.`), 0;
}

/** The global writes under `home`, each previewed with its diff and applied only with its own yes (a prompt, or `--take`). */
async function globalInstall(dir: string, ids: string[], cli: PresetEnv, o: { dryRun: boolean; take?: string[] }): Promise<number> {
  const { out } = cli;
  if (ids.length !== 1) return out(`A global install takes a folder with one preset; this one has ${ids.length}.`), 2;
  const home = cli.home ?? homedir();
  const r = loadPreset(join(dir, `${ids[0]}.yaml`));
  if (!r.ok) return out(r.errors.map(safe).join('\n')), 1;
  const l = r.loaded, id = l.preset.id, item = `${PRESET_ITEM}${id}`;
  const read = (rel: string): string | null => { try { return readFileSync(join(home, rel), 'utf8'); } catch { return null; } };
  const put = (rel: string, after: string, blocks?: string[]): Change => {
    const before = read(rel);
    return before === null ? { kind: 'create', rel, content: after, item, ...(blocks ? { blocks } : {}) } : { kind: 'update', rel, before, after, blocks: blocks ?? [], item };
  };
  const changes: Change[] = [];
  try {
    const md = mergeAgentsPreset(read('.claude/CLAUDE.md'), readFileSync(join(l.base, 'templates', 'core.md'), 'utf8').replace(/\r\n/g, '\n'));
    changes.push(put('.claude/CLAUDE.md', md.after, md.blocks));
    for (const f of presetFiles(l, l.preset.skills)) changes.push(put(f.to, f.content));
    const want = presetSets(l, { selected: [], env: false }); // user scope has no repo facts: attribution only, never env (C2, C3)
    if (want.length) { const s = mergePresetSettings(read('.claude/settings.json'), want, [], '~/.claude/settings.json'); changes.push(put('.claude/settings.json', s.after, s.blocks)); }
  } catch (e) {
    if (e instanceof MergeError) return out(`${esc(e.message)} Nothing was written.`), 1;
    throw e;
  }
  const dest = `${GLOBAL_STATE.dir}/presets`;
  const own = existsSync(join(dir, id)) ? filesUnder(join(dir, id)).map((f) => relative(join(dir, id), f).split('\\').join('/')) : [];
  for (const [from, to] of [[`${id}.yaml`, `${dest}/${id}.yaml`], ...own.map((f) => [`${id}/${f}`, `${dest}/${id}/${f}`])]) changes.push(put(to, readFileSync(join(dir, from), 'utf8')));
  const taken = changes.find((c) => c.kind === 'update' && c.rel !== '.claude/CLAUDE.md' && c.rel !== '.claude/settings.json');
  if (taken) return out(`~/${taken.rel} already exists; remove it first.`), 1;
  const unknown = o.take?.find((t) => !changes.some((c) => c.rel === t));
  if (unknown) return out(`${esc(unknown)} is not one of the global writes. Run with --dry-run to list them.`), 2;
  if (!o.dryRun && !o.take && cli.tty === false) return out(NO_TTY), 2;
  const tokens = presetContext(l, [l.preset.core, ...l.preset.skills]).reduce((n, e) => n + (e.tokens ?? 0), 0);
  out(['Global writes (each needs its own yes):', ...changes.map((c) => `  ~/${c.rel}`), '',
    ...changes.map((c) => unifiedDiff(c.kind === 'update' ? c.before : '', c.kind === 'update' ? c.after : c.kind === 'create' ? c.content : '', `~/${c.rel}`).trimEnd()),
    `Always-loaded at user scope, if you take every write: ~${fmt(tokens)} tokens (estimate), against the budget of ${fmt(DEFAULT_CONTEXT_BUDGET)}.`,
    'Git checks stay per repo: they need the hooks /harness:init installs.'].join('\n').split('\n').map(safe).join('\n'));
  if (o.dryRun) return 0;
  const chosen: Change[] = [];
  for (const c of changes) if (o.take ? o.take.includes(c.rel) : await cli.prompt.confirm(`Write ~/${c.rel}? [y/N]`)) chosen.push(c);
  if (!chosen.length) return out('Nothing was written.'), 0;
  // The folders this install creates, so uninstall --global removes those and keeps the person's own empty ones.
  const dirs = new Set<string>();
  for (const rel of [...chosen.map((c) => c.rel), GLOBAL_STATE.manifest, `${GLOBAL_STATE.backup}/x`])
    for (let d = posix.dirname(rel); d !== '.' && !existsSync(join(home, d)); d = posix.dirname(d)) dirs.add(d);
  try {
    applyChanges(home, chosen, VERSION, undefined, undefined, { state: GLOBAL_STATE, dirs: [...dirs] });
  } catch (e) {
    if (!(e instanceof ApplyError)) throw e;
    if (e.message === LOCK_RECOVERY) return out(GLOBAL_LOCK_RECOVERY), 1; // the repo wording names .harness and git
    return out(safe(e.message.startsWith('Rollback failed') ? e.message : `${e.message} Nothing was written.`)), 1;
  }
  return out(`Installed ${esc(id)} under ~/.claude: ${chosen.length} of ${changes.length} writes, listed in ~/${GLOBAL_STATE.manifest}. Remove them with \`harness uninstall --global\`.`), 0;
}
