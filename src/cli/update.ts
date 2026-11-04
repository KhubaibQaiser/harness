import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LEGACY_RESULTS_DIR } from '../core/config.js';
import { migrateResultsDir, validateConfig } from '../core/config-io.js';
import { latestVersion } from '../core/registry.js';
import { ApplyError, type Change, type FsLike, ManifestError, applyChanges, removeEmptyDirs, readManifest, type Manifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL, mergeManifestFiles } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { planChanges } from '../install/plan.js';
import { STRUCTURAL } from '../install/merge.js';
import { loadCatalog } from '../catalog/load.js';
import { matchesHash } from '../install/text.js';
import { dirtyPaths } from './init.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type UpdateEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; fetchImpl?: typeof fetch; fs?: FsLike };

const USAGE = 'Usage: harness update [--yes] [--check] [--dry-run]';
const PKG = '@khubaibqaiser/harness';
const CONFIG = '.harness/config.yaml';
const SETTINGS = '.claude/settings.json';
const MCP = '.mcp.json';

export async function update(args: string[], cli: UpdateEnv): Promise<number> {
  const { out, prompt, version } = cli;
  if (args.some((a) => a !== '--yes' && a !== '--check' && a !== '--dry-run')) return out(USAGE), 2;
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  if (!yes && !dryRun && !args.includes('--check') && cli.tty === false) return out(NO_TTY), 2;

  if (args.includes('--check')) {
    const latest = await latestVersion(PKG, cli.fetchImpl);
    if (latest === null) return out('Could not reach npm to check for a newer version. Try again later.'), 1;
    out(latest === version ? `Harness ${version} is the latest.` : `Harness ${latest} is available (you have ${version}). Plugin users: update the plugin, then run /harness:update. CLI users: npx ${PKG}@latest update.`);
    return 0;
  }

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli.root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return out('Not a git repository. Run harness update inside a git repo.'), 1;
  }
  let m: Manifest | null;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run harness init to install it.'), 1;

  // Strict validation: update plans from this config, so a mistake in it should stop us, not be skipped silently.
  // The old default results_dir is now a config error, so it is migrated first (ruling 9): a one-line edit, not a rewrite.
  let raw: unknown;
  let migrated: Change | null = null;
  try {
    const text = readFileSync(join(root, CONFIG), 'utf8');
    const after = migrateResultsDir(text);
    if (after !== null) migrated = { kind: 'update', rel: CONFIG, before: text, after, blocks: [] };
    raw = parseYaml(after ?? text);
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
  const v = validateConfig(raw);
  if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;

  const aiPath = v.config.items.length > 0; // a selection from the recommend flow: the plan owns the config
  const cat = aiPath ? loadCatalog() : null;
  if (cat?.errors.length) return cat.errors.forEach((e) => out(e)), out('The catalog has errors; update stopped. Run harness catalog validate.'), 1;
  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, v.config, detect(root), {
      version, distDir: cli.distDir, templatesDir: cli.templatesDir, legacyDir: LEGACY_RESULTS_DIR,
      recorded: m.files.find((f) => f.rel === SETTINGS)?.blocks, mcpRecorded: m.files.find((f) => f.rel === MCP)?.blocks,
      recordedFiles: m.files, ...(aiPath ? { catalog: cat!.catalog } : {}),
    });
  } catch (e) {
    return out(`Cannot build the update plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  // The user owns the config after init, except on the AI path, where the checks follow the selection.
  const changes = aiPath ? plan.changes : [...(migrated ? [migrated] : []), ...plan.changes.filter((c) => c.rel !== CONFIG)];

  const commit = (cs: typeof changes, manifest: Manifest) => {
    try {
      applyChanges(root, cs, version, undefined, cli.fs, { manifest });
      return null;
    } catch (e) {
      if (e instanceof ApplyError) return e.message;
      throw e;
    }
  };
  // A file with no change still loses its dropped blocks (leaving `always` with no key left to delete changes no bytes).
  let stale = 0;
  for (const rel of STRUCTURAL) {
    const f = m.files.find((x) => x.rel === rel);
    if (changes.some((c) => c.rel === rel) || !f?.blocks) continue;
    const kept = f.blocks.filter((b) => !plan.dropped.includes(b));
    stale += f.blocks.length - kept.length;
    if (kept.length) f.blocks = kept;
    else delete f.blocks;
  }
  if (!changes.length && !stale) {
    if (dryRun) return out(m.version === version ? `Harness ${version} is up to date.` : `Harness files already match ${version}. Dry run: nothing was written.`), 0;
    if (m.version === version) return out(`Harness ${version} is up to date.`), 0;
    const err = commit([], { ...m, version });
    if (!err) stampHarnessFiles(root);
    return out(err ?? `Harness files already match ${version}. Manifest version updated from ${m.version}.`), err ? 1 : 0;
  }

  const dirty = dirtyPaths(root);
  const touched = changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the update can be undone cleanly: ${touched.join(', ')}.`), 1;

  const entry = (rel: string) => m!.files.find((f) => f.rel === rel);
  const merged = (rel: string) => entry(rel)?.kind === 'update' || !!entry(rel)?.blocks?.length || !!entry(rel)?.replace?.length;
  const editedRels = changes.filter((c) => c.kind === 'update' && c.rel !== CONFIG && entry(c.rel) && !matchesHash(c.before, entry(c.rel)!.hash)).map((c) => c.rel);
  const list = (rels: string[]) => rels.map((r) => `\`${r}\``).join(', ');
  const editedOwned = editedRels.filter((r) => !merged(r));
  const editedMerged = editedRels.filter(merged);
  out(changes.length ? `Update ${m.version} -> ${version}:` : 'Only the manifest changes.');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  if (plan.manual.length) out('Do these by hand:\n' + plan.manual.map((l) => `  ${l}`).join('\n'));
  for (const n of plan.notes) out(`Note: ${n}`);
  if (editedOwned.length) out(`You edited these harness files; update replaces them: ${list(editedOwned)}.`);
  if (editedMerged.length) out(`You edited these files; update changes only the harness parts: ${list(editedMerged)}.`);
  if (dryRun) {
    if (touched.length) out(`These files have uncommitted changes; commit or stash them before applying: ${touched.join(', ')}.`);
    return out('Dry run: nothing was written.'), 0;
  }
  if (!yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  // One transaction: the files and the merged manifest commit together or roll back together.
  const files = mergeManifestFiles(m, changes);
  const err = commit(changes, { version, createdAt: new Date().toISOString(), ...(m.tddOff ? { tddOff: m.tddOff } : {}), files });
  if (err) return out(err), 1;
  removeEmptyDirs(root, changes);
  stampHarnessFiles(root); // change detection: these writes are harness's own

  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  out(`Harness updated to ${version}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  return 0;
}
