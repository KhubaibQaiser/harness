import { recordedPresetContext } from '../catalog/presets.js';
import { dirname, join } from 'node:path';
import { realIO, type RepoIO } from '../budget/imports.js';
import { budgetLines, budgetVerdict, fmt, measureSelection, type ContextEntry } from '../budget/measure.js';
import { measureRepo, type SourceEntry } from '../budget/sources.js';
import { ownersFrom } from '../budget/owners.js';
import type { Catalog } from '../catalog/schema.js';
import { unattendedEnv } from '../core/unattended.js';
import type { Exec } from '../core/exec.js';
import { packageDir } from '../core/package-dir.js';
import { ApplyError, linkedPath, type Change } from '../install/apply.js';
import { readManifest, rehashManifest, settingsOnlyPluginEdits } from '../install/manifest.js';
import { installPins, pinnedPlugins } from '../install/merge.js';
import { installPlugins } from '../install/plugin-install.js';
import { isDenied, shq } from './own-command.js';

const EXIT_OVER_BUDGET = 2;

/**
 * Prints the budget lines. Returns 2 when the install must stop (over budget, --yes, no --over-budget), else null.
 * `exempt` holds the ids the person already approved: they count in both totals, so only new text or a new unmeasured id asks.
 */
export async function budgetGate({ cat, before, after, exempt, extra = [], extraBefore = [], changes = [], budget, templatesDir, root, env, out, f }: {
  cat: Catalog; before: string[]; after: string[]; exempt: string[]; extra?: ContextEntry[]; extraBefore?: ContextEntry[]; changes?: Change[]; budget: number; templatesDir: string; root: string; env: NodeJS.ProcessEnv; out: (s: string) => void; f: { yes: boolean; dryRun: boolean; overBudget: boolean };
}): Promise<number | null> {
  const dirs = { templates: templatesDir, plugin: dirname(packageDir('templates')) };
  // AGENTS.md and CLAUDE.md are measured as files, before and as the plan leaves them, so harness's blocks and line count
  // exactly what is written: the agents-md item and the preset core add nothing of their own here.
  const fromFiles = cat.items.filter((i) => i.source.type === 'own' && i.source.merge?.includes('agents-md')).map((i) => i.id);
  const notBlock = (xs: ContextEntry[]) => xs.filter((e) => !e.block);
  const v = budgetVerdict(
    await measureSelection(before, cat, dirs, { exempt, fromFiles, extra: [...notBlock(extraBefore), ...gateEntries(root, cat)] }),
    await measureSelection(after, cat, dirs, { exempt, fromFiles, extra: [...notBlock(extra), ...gateEntries(root, cat, changes)] }),
    budget,
  );
  for (const l of budgetLines(v)) out(l);
  if (!v.ask || f.dryRun) return null;
  if (unattendedEnv(env)) return out(`Not added: it would take always-loaded context past the budget of ${fmt(budget)} tokens, and no person is here to approve it. Run it in a session, or raise context.budget_tokens.`), EXIT_OVER_BUDGET; // Q6: --over-budget needs a person
  if (f.overBudget || !f.yes) return null;
  out(`This goes over the context budget (~${fmt(v.after.tokens)} of ${fmt(budget)} tokens, estimate). Run again with --over-budget to accept, or pick fewer items.`);
  return EXIT_OVER_BUDGET;
}

const MEMORY = new Set(['AGENTS.md', 'CLAUDE.md']);

/** The repo's own always-loaded files (never exempt: every teammate loads them). Harness's files are told apart by the manifest. */
export const repoEntries = (root: string, cat: Catalog): ContextEntry[] => measureMemory(root, cat, []).filter((e) => e.owner === 'repo');

/**
 * What the gate counts from the repo: its own files, plus harness's rows in AGENTS.md and CLAUDE.md. With `changes`, those
 * two are read as the plan leaves them: a new `@AGENTS.md` line makes the repo's own AGENTS.md text load (re-review N1),
 * and a line the person wrote stays theirs and counts once.
 */
const gateEntries = (root: string, cat: Catalog, changes: Change[] = []): ContextEntry[] =>
  measureMemory(root, cat, changes).filter((e) => e.owner === 'repo' || MEMORY.has(e.path));

function measureMemory(root: string, cat: Catalog, changes: Change[]): SourceEntry[] {
  const owners = ownersFrom(readManifest(root), cat);
  const planned = new Map<string, string | null>();
  for (const c of changes) {
    // A link is never overlaid: the plan refuses one, and a made-up real path would hide where it points.
    if (!MEMORY.has(c.rel) || linkedPath(root, c.rel)) continue;
    planned.set(c.rel, c.kind === 'create' ? c.content : c.kind === 'update' ? c.after : null);
    if (c.kind !== 'delete') owners.set(c.rel, 'repo'); // a merged file is the repo's; harness's line and blocks are split out
    else owners.delete(c.rel);
  }
  const realRoot = realIO.real(root) ?? root;
  const relOf = (abs: string): string | undefined => [...planned.keys()].find((rel) => abs === join(root, rel) || abs === join(realRoot, rel));
  const at = <T>(abs: string, f: (t: string | null, rel: string) => T, base: () => T): T => { const rel = relOf(abs); return rel === undefined ? base() : f(planned.get(rel)!, rel); };
  const io: RepoIO = planned.size ? {
    ...realIO,
    read: (abs) => at(abs, (t) => t, () => realIO.read(abs)),
    size: (abs) => at(abs, (t) => (t === null ? null : Buffer.byteLength(t)), () => realIO.size(abs)),
    real: (abs) => at(abs, (t, rel) => (t === null ? null : join(realRoot, rel)), () => realIO.real(abs)),
  } : realIO;
  // The preset id only names the owner of the preset block; any owner but repo counts in harness's share.
  return measureRepo(root, { owners, preset: null }, io).always;
}

/** The recorded preset's entries, for the paths where the preset does not change (add, sync, update without answers). */
export const recordedExtra = (root: string, config: { preset?: { id: string; items: string[] } }): ContextEntry[] => (config.preset ? recordedPresetContext(root, config.preset) : []);

/** Installs the selected pinned plugins, prints one line each, and re-hashes settings. Returns 1 when any install or the re-hash failed. `applied`: the files were written in this run. */
export function installSelected({ root, chosen, cat, exec, out, applied = true, have = [] }: { root: string; chosen: string[]; cat: Catalog; exec: Exec; out: (s: string) => void; applied?: boolean; have?: string[] }): number {
  const market = installPins(readManifest(root)); // runs after the plan is applied, so the manifest names this install's marketplace
  const all = pinnedPlugins(cat.items.filter((i) => chosen.includes(i.id))).map((p) => `${p.name}@${market}`);
  const ids = all.filter((id) => !have.includes(id));
  if (!ids.length) return 0;
  const r = installPlugins(ids, exec);
  for (const id of r.ok) out(`Installed plugin ${id}`);
  if (r.failed.length) out(`${applied ? 'Files applied; ' : ''}${r.failed.length} plugin(s) not installed.`);
  for (const f of r.failed) out(`Could not install ${f.id}: ${f.message}\n  Run this yourself with Claude Code's \`!\` prefix (a \`!\` command runs outside the sandbox): claude plugin install ${shq(f.id)} --scope project`);
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
