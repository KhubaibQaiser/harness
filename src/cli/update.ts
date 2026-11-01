import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../core/config-io.js';
import { latestVersion } from '../core/registry.js';
import { ApplyError, ManifestError, applyChanges, readManifest, type Manifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { planChanges } from '../install/plan.js';
import { sha256 } from '../install/text.js';
import type { Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type UpdateEnv = CliEnv & { prompt: Prompt; version: string; templatesDir: string; distDir: string; fetchImpl?: typeof fetch };

const USAGE = 'Usage: harness update [--yes] [--check]';
const PKG = '@khubaibqaiser/harness';
const CONFIG = '.harness/config.yaml';

export async function update(args: string[], cli: UpdateEnv): Promise<number> {
  const { out, prompt, version } = cli;
  if (args.some((a) => a !== '--yes' && a !== '--check')) return out(USAGE), 2;
  const yes = args.includes('--yes');

  if (args.includes('--check')) {
    const latest = await latestVersion(PKG, cli.fetchImpl);
    if (latest === null) return out('Could not reach npm to check for a newer version. Try again later.'), 1;
    out(latest === version ? `Harness ${version} is the latest.` : `Harness ${latest} is available (you have ${version}). Run: npx ${PKG}@latest update`);
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
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(join(root, CONFIG), 'utf8'));
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
  const v = validateConfig(raw);
  if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;

  let plan: ReturnType<typeof planChanges>;
  try {
    plan = planChanges(root, v.config, detect(root), { version, distDir: cli.distDir, templatesDir: cli.templatesDir });
  } catch (e) {
    return out(`Cannot build the update plan: ${(e as Error).message}`), 1;
  }
  const changes = plan.changes.filter((c) => c.rel !== CONFIG); // the user owns the config after init

  const writeManifest = (next: Manifest) => {
    const p = join(root, MANIFEST_REL);
    writeFileSync(p + '.tmp', JSON.stringify(next, null, 2) + '\n');
    renameSync(p + '.tmp', p);
  };
  if (!changes.length) {
    if (m.version === version) return out(`Harness ${version} is up to date.`), 0;
    writeManifest({ ...m, version });
    return out(`Harness files already match ${version}. Manifest version updated from ${m.version}.`), 0;
  }

  const edited = changes.filter((c) => c.kind === 'update' && m!.files.some((f) => f.rel === c.rel && f.hash !== sha256(c.before))).map((c) => `\`${c.rel}\``);
  out(`Update ${m.version} -> ${version}:`);
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  if (plan.manual.length) out('Do these by hand:\n' + plan.manual.map((l) => `  ${l}`).join('\n'));
  for (const n of plan.notes) out(`Note: ${n}`);
  if (edited.length) out(`You edited these harness files; update replaces them: ${edited.join(', ')}.`);
  if (!yes && !(await prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  // Apply transactionally without its manifest, then write one merged manifest (same tmp+rename as uninstall).
  let applied: Manifest;
  try {
    applied = applyChanges(root, changes, version, undefined, undefined, { writeManifest: false });
  } catch (e) {
    if (e instanceof ApplyError) return out(e.message), 1;
    throw e;
  }
  const done = new Map(applied.files.map((f) => [f.rel, f]));
  const files: Manifest['files'] = m.files.map((old) => {
    const a = done.get(old.rel);
    if (!a) return old; // not touched by this update
    done.delete(old.rel);
    const blocks = [...new Set([...(old.blocks ?? []), ...(a.blocks ?? [])])];
    // Keep init's kind (a created file stays deletable) and, for merged files, the pre-init backup uninstall restores.
    const backup = old.backup ?? (old.kind === 'update' ? a.backup : undefined);
    return { rel: old.rel, kind: old.kind, hash: a.hash, ...(blocks.length ? { blocks } : {}), ...(backup ? { backup } : {}) };
  });
  writeManifest({ version, createdAt: applied.createdAt, files: [...files, ...done.values()] });

  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : 'Updated'} \`${c.rel}\``);
  out(`Harness updated to ${version}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
  return 0;
}
