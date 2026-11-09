import { recordedPresetContext } from '../catalog/presets.js';
import { dirname } from 'node:path';
import { budgetLines, budgetVerdict, measureSelection, type ContextEntry } from '../budget/measure.js';
import { measureRepo } from '../budget/sources.js';
import { ownersFrom } from '../budget/owners.js';
import { repoOnly } from '../budget/summary.js';
import type { Catalog } from '../catalog/schema.js';
import { unattendedEnv } from '../core/unattended.js';
import type { Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import { ApplyError } from '../install/apply.js';
import { readManifest, rehashManifest, settingsOnlyPluginEdits } from '../install/manifest.js';
import { pinnedPlugins } from '../install/merge.js';
import { installPlugins } from '../install/plugin-install.js';
import { isDenied, shq } from './own-command.js';

const EXIT_OVER_BUDGET = 2;

/**
 * Prints the budget lines. Returns 2 when the install must stop (over budget, --yes, no --over-budget), else null.
 * `exempt` holds the ids the person already approved: they show but do not count.
 */
export async function budgetGate({ cat, before, after, exempt, extra = [], extraBefore = [], budget, templatesDir, root, env, out, f }: {
  cat: Catalog; before: string[]; after: string[]; exempt: string[]; extra?: ContextEntry[]; extraBefore?: ContextEntry[]; budget: number; templatesDir: string; root: string; env: NodeJS.ProcessEnv; out: (s: string) => void; f: { yes: boolean; dryRun: boolean; overBudget: boolean };
}): Promise<number | null> {
  const dirs = { templates: templatesDir, plugin: dirname(packageDir('templates')) };
  const repo = repoEntries(root, cat);
  const v = budgetVerdict(await measureSelection(before, cat, dirs, { exempt, extra: [...extraBefore, ...repo] }), await measureSelection(after, cat, dirs, { exempt, extra: [...extra, ...repo] }), budget);
  for (const l of budgetLines(v)) out(l);
  if (!v.ask || f.dryRun) return null;
  if (unattendedEnv(env)) return out(`Not added: it would take always-loaded context past the budget of ${budget} tokens, and no person is here to approve it. Run it in a session, or raise context.budget_tokens.`), EXIT_OVER_BUDGET; // Q6: --over-budget needs a person
  if (f.overBudget || !f.yes) return null;
  out(`This goes over the context budget (~${v.after.tokens} of ${budget} tokens, estimate). Run again with --over-budget to accept, or pick fewer items.`);
  return EXIT_OVER_BUDGET;
}

/** The repo's own always-loaded files (never exempt: every teammate loads them). Harness's files are told apart by the manifest. */
export function repoEntries(root: string, cat: Catalog): ContextEntry[] {
  // The preset id only names the owner of the preset block, which repoOnly drops either way.
  return repoOnly(measureRepo(root, { owners: ownersFrom(readManifest(root), cat), preset: null }));
}

/** The recorded preset's entries, for the paths where the preset does not change (add, sync, update without answers). */
export const recordedExtra = (root: string, config: { preset?: { id: string; items: string[] } }): ContextEntry[] => (config.preset ? recordedPresetContext(root, config.preset) : []);

/** Installs the selected pinned plugins, prints one line each, and re-hashes settings. Returns 1 when any install or the re-hash failed. `applied`: the files were written in this run. */
export function installSelected({ root, chosen, cat, exec, out, applied = true, have = [] }: { root: string; chosen: string[]; cat: Catalog; exec: Exec; out: (s: string) => void; applied?: boolean; have?: string[] }): number {
  const all = pinnedPlugins(cat.items.filter((i) => chosen.includes(i.id))).map((p) => `${p.name}@harness-pins`);
  const ids = all.filter((id) => !have.includes(id));
  if (!ids.length) return 0;
  const r = installPlugins(ids, exec);
  for (const id of r.ok) out(`Installed plugin ${id}`);
  if (r.failed.length) out(`${applied ? 'Files applied; ' : ''}${r.failed.length} plugin(s) not installed.`);
  for (const f of r.failed) out(`Could not install ${f.id}: ${f.message}\n  Run this yourself with Claude Code's \`!\` prefix: claude plugin install ${shq(f.id)} --scope project`);
  if (r.failed.length) out('Then run /harness:sync to record the install.');
  try {
    if (r.ok.length) {
      if (settingsOnlyPluginEdits(root, all)) rehashManifest(root, ['.claude/settings.json']);
      else out('settings.json has other edits; not recorded. Run /harness:update to review them.');
    }
  } catch (e) {
    if (!(e instanceof ApplyError)) throw e;
    out(`${isDenied(e) ? "Claude Code's sandbox blocks harness's own files. " : ''}The install worked but harness could not record it (${e.message}). Run /harness:sync to record the install.`);
    return 1;
  }
  return r.failed.length ? 1 : 0;
}
