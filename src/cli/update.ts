import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LEGACY_RESULTS_DIR } from '../core/config.js';
import { migrateResultsDir, validateConfig } from '../core/config-io.js';
import { latestVersion } from '../core/registry.js';
import { ApplyError, type Change, type FsLike, ManifestError, applyChanges, readManifest, type Manifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { lineHunks, unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL, renameRecorded } from '../install/manifest.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { planChanges } from '../install/plan.js';
import { removeBlocks } from '../install/merge.js';
import { hashText, matchesHash } from '../install/text.js';
import { dirtyPaths } from './init.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type UpdateEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; fetchImpl?: typeof fetch; fs?: FsLike };

const USAGE = 'Usage: harness update [--yes] [--check] [--dry-run]';
const PKG = '@khubaibqaiser/harness';
const CONFIG = '.harness/config.yaml';

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

  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, v.config, detect(root), { version, distDir: cli.distDir, templatesDir: cli.templatesDir, legacyDir: LEGACY_RESULTS_DIR });
  } catch (e) {
    return out(`Cannot build the update plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  const changes = [...(migrated ? [migrated] : []), ...plan.changes.filter((c) => c.rel !== CONFIG)]; // the user owns the config after init

  const commit = (cs: typeof changes, manifest: Manifest) => {
    try {
      applyChanges(root, cs, version, undefined, cli.fs, { manifest });
      return null;
    } catch (e) {
      if (e instanceof ApplyError) return e.message;
      throw e;
    }
  };
  if (!changes.length) {
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
  out(`Update ${m.version} -> ${version}:`);
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
  // A moved results path: rewrite it in what the manifest recorded, else record the swap as hunks uninstall reverts (ruling 7).
  for (const c of changes) {
    if (c.kind !== 'update' || !c.rename) continue;
    const old = entry(c.rel);
    const r = old && renameRecorded(old, c.rename.from, c.rename.to);
    if (r && r.found) m.files[m.files.indexOf(old)] = r.entry;
    else c.replace = lineHunks(c.before, c.after);
  }
  const files: Manifest['files'] = m.files.map((old) => {
    const c = changes.find((x) => x.rel === old.rel);
    if (!c || c.kind === 'delete') return old; // not touched by this update
    // A text block the new content no longer holds (a migrated Jest script) can't be removed later; drop it.
    // Settings blocks are JSON structures, not text, so they are always kept.
    const still = (b: string) => old.rel === '.claude/settings.json' || c.kind !== 'update' || removeBlocks(c.after, [b]) !== c.after; // EOL-tolerant, like uninstall's removal
    const blocks = [...new Set([...(old.blocks ?? []).filter(still), ...(c.blocks ?? [])])];
    // A merged file the user edited since harness last wrote it: keep the old hash and drop the pre-init backup, so
    // uninstall still sees the edit and removes only harness's blocks (a whole-file restore or delete would lose it).
    const edited = c.kind === 'update' && merged(old.rel) && !matchesHash(c.before, old.hash);
    const keep = edited || (old.rel === CONFIG && !matchesHash(c.kind === 'update' ? c.before : '', old.hash)); // an edited config keeps its hash
    const hash = keep ? old.hash : hashText(c.kind === 'create' ? c.content : c.after);
    // Otherwise keep init's kind (a created file stays deletable) and the pre-init backup uninstall restores.
    // Formatted hunks: keep the old ones the new text still holds, then this update's (uninstall undoes them newest first).
    // ponytail: an old hunk this update reformatted is dropped, so uninstall then leaves that part with a note.
    const replace = [...(old.replace ?? []).filter((h) => c.kind !== 'update' || c.after.includes(h.from)), ...(c.kind === 'update' ? (c.replace ?? []) : [])];
    const fmt = { ...(replace.length ? { replace } : {}), ...(old.formatted || (c.kind === 'update' && c.formatted) ? { formatted: true as const } : {}), ...(c.kind === 'update' && c.unformatted ? { unformatted: true as const } : {}) };
    return { rel: old.rel, kind: old.kind, hash, ...(blocks.length ? { blocks } : {}), ...fmt, ...(old.backup && !edited ? { backup: old.backup } : {}) };
  });
  for (const c of changes) {
    if (c.kind === 'delete' || m.files.some((f) => f.rel === c.rel)) continue;
    files.push({ rel: c.rel, kind: c.kind, hash: hashText(c.kind === 'create' ? c.content : c.after), ...(c.blocks?.length ? { blocks: c.blocks } : {}), ...(c.kind === 'update' && c.replace?.length ? { replace: c.replace } : {}), ...(c.kind === 'update' && c.formatted ? { formatted: true as const } : {}), ...(c.kind === 'update' && c.unformatted ? { unformatted: true as const } : {}) });
  }
  const err = commit(changes, { version, createdAt: new Date().toISOString(), ...(m.tddOff ? { tddOff: m.tddOff } : {}), files });
  if (err) return out(err), 1;
  stampHarnessFiles(root); // change detection: these writes are harness's own

  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : 'Updated'} \`${c.rel}\``);
  out(`Harness updated to ${version}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  return 0;
}
