import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { budgetLines, budgetVerdict, itemContext, itemContextLine, measureSelection } from '../budget/measure.js';
import type { Catalog } from '../catalog/schema.js';
import { esc, type HarnessConfig, type Selected } from '../core/config.js';
import { claudeVersion as realClaudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { ApplyError, type Change, type FsLike, applyChanges, removeEmptyDirs } from '../install/apply.js';
import { approvedIds } from '../install/approved.js';
import { dirtyTouched, dropRestoredBackups, pruneStale } from '../install/finish.js';
import { unifiedDiff } from '../install/diff.js';
import { MANIFEST_REL, itemFiles, mergeManifestFiles } from '../install/manifest.js';
import { selectedIds } from '../install/plan.js';
import { reconcile } from '../install/reconcile.js';
import { pinOf, resolveSelection } from '../install/select.js';
import type { Picks } from '../ai/picks.js';
import { budgetGate, isDenied, sandboxLine } from './init.js';
import { refuseOutsideClaude } from './claude-only.js';
import { NO_TTY, type Prompt } from './prompt.js';
import { openInstall, readCatalog, readConfig } from './preamble.js';
import type { CliEnv } from './index.js';

export type ItemsEnv = CliEnv & { prompt: Prompt; templatesDir: string; distDir: string; fs?: FsLike; claudeVersion?: () => string | null; catalog?: Catalog };

const USAGE: Record<string, string> = {
  add: 'Usage: /harness:add <id> [--over-budget] [--take <file,...>] [--dry-run|--yes]',
  remove: 'Usage: harness remove <id> [--take <file,...>] [--dry-run|--yes]',
  why: 'Usage: harness why <id>',
  explain: 'Usage: harness explain',
};
const CONFIG = '.harness/config.yaml';
const list = (rels: string[]) => rels.map((r) => `\`${r}\``).join(', ');
const HAND = 'Added by hand with harness add.';
const GUARD_OFF = 'The guard is off now, so the agent can run harness commands without asking.';

/** The stored recommendation (`.harness/picks.json`), or null when it is missing or unreadable. */
function storedPicks(root: string): Picks | null {
  try {
    const p = JSON.parse(readFileSync(join(root, '.harness/picks.json'), 'utf8'));
    return p && Array.isArray(p.items) ? (p as Picks) : null;
  } catch {
    return null;
  }
}

export async function items(cmd: 'add' | 'remove' | 'why' | 'explain', allArgs: string[], cli: ItemsEnv): Promise<number> {
  const { out } = cli;
  // --take <file,...> (add and remove, as in sync): its value is not an id.
  const take: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < allArgs.length; i++) {
    if (allArgs[i] !== '--take' || (cmd !== 'add' && cmd !== 'remove')) { args.push(allArgs[i]); continue; }
    const v = allArgs[++i];
    if (!v || v.startsWith('--')) return out(USAGE[cmd]), 2;
    take.push(...v.split(',').filter(Boolean));
  }
  const flags = new Set(cmd === 'add' ? ['--yes', '--dry-run', '--over-budget'] : cmd === 'remove' ? ['--yes', '--dry-run'] : []);
  const ids = args.filter((a) => !a.startsWith('--'));
  const bad = args.some((a) => a.startsWith('--') && !flags.has(a)) || ids.length !== (cmd === 'explain' ? 0 : 1) || new Set(args).size !== args.length;
  if (bad) return out(USAGE[cmd]), 2;
  const [id] = ids;
  const yes = args.includes('--yes');
  const dryRun = args.includes('--dry-run');
  const refused = cmd === 'add' ? refuseOutsideClaude('add', cli.env, false) : null;
  if (refused) return out(refused), 2;
  if ((cmd === 'add' || cmd === 'remove') && !yes && !dryRun && cli.tty === false) return out(NO_TTY), 2;

  const opened = openInstall(cli, 'Not a git repository. Run harness inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;
  const cfg = readConfig(root, out);
  if (typeof cfg === 'number') return cfg;
  const config = cfg;
  const cat = readCatalog(cli.catalog, out);
  if (typeof cat === 'number') return cat;
  const byId = new Map(cat.items.map((i) => [i.id, i]));
  const have = selectedIds(config);
  // A legacy install has no items list: its own items count as installed.
  const rows: Selected[] = config.items.length ? config.items : have.map((x) => ({ id: x, include: 'recommended', selected: true, reason: 'Part of the harness install.', addresses: [], pin: '' }));
  const dirs = { templates: cli.templatesDir };
  const it = id === undefined ? undefined : byId.get(id);
  const picks = storedPicks(root);

  if (cmd === 'why') {
    if (!it) return out(`Unknown item "${esc(id)}". Run harness catalog to list the ids.`), 1;
    const sel = rows.find((i) => i.id === id && i.selected);
    const cost = `context ${it.cost.context}, setup ${it.cost.setup}`;
    if (!sel) return out(`Not installed. ${it.why} Cost: ${cost}.`), 0;
    out(`${id}: ${esc(sel.reason)}`);
    for (const f of sel.addresses) {
      const found = picks?.findings.find((x) => x.id === f);
      out(`  [${esc(String(found?.severity ?? 'unknown'))}] ${esc(String(found?.title ?? f))}`);
    }
    out(`Cost: ${cost}.`);
    out(`Context: ${itemContextLine(itemContext(it, dirs))}.`);
    return 0;
  }
  if (cmd === 'explain') {
    for (const s of rows.filter((i) => i.selected)) {
      out(`${s.id} (${byId.get(s.id)?.kind ?? 'unknown'}): ${esc(s.reason)}`);
      for (const f of itemFiles(m, s.id)) out(`  ${f.rel}`);
    }
    const v = await measureSelection(have, cat, { ...dirs, plugin: dirname(packageDir('templates')) });
    out(budgetLines(budgetVerdict(v, v, config.context.budget_tokens))[0]);
    return 0;
  }

  // add and remove: the selection changes, planChanges does the rest (the same path as update).
  if (!config.items.length) return out('This install predates the item catalog. Run /harness:update with recommendations first.'), 1;
  if (!it) return out(`Unknown item "${esc(id)}". Run harness catalog to list the ids.`), 1;
  let next: Selected[];
  let after: string[];
  if (cmd === 'add') {
    if (have.includes(id)) return out(`${id} is already installed.`), 0;
    const r = resolveSelection([...have, id], cat, (cli.claudeVersion ?? realClaudeVersion)());
    if (r.errors.length) return r.errors.forEach((e) => out(e)), 2;
    if (!r.ids.includes(id)) return r.notices.forEach((n) => out(n)), 1;
    for (const n of r.notices) out(n);
    after = r.ids;
    const row = (x: string): Selected => {
      const old = config.items.find((i) => i.id === x);
      const p = picks?.items.find((q) => q.id === x);
      const by = x === id ? undefined : id;
      const reason = p?.reason ?? old?.reason ?? (by ? `Required by ${by}.` : HAND);
      return { id: x, include: old?.include ?? p?.include ?? 'optional', selected: true, reason, addresses: p?.addresses ?? old?.addresses ?? [], pin: pinOf(byId.get(x)!.source) };
    };
    const fresh = after.filter((x) => !have.includes(x));
    next = [...config.items.map((i) => (fresh.includes(i.id) ? row(i.id) : i)), ...fresh.filter((x) => !config.items.some((i) => i.id === x)).map(row)];
  } else {
    if (!have.includes(id)) return out(`${id} is not installed.`), 1;
    const dep = have.find((o) => byId.get(o)?.requires.includes(id));
    if (dep) return out(`${dep} requires ${id}; remove ${dep} first.`), 1;
    after = have.filter((x) => x !== id);
    next = config.items.map((i) => (i.id === id ? { ...i, selected: false } : i));
  }

  const nextConfig: HarnessConfig = { ...config, items: next };
  let planned: ReturnType<typeof reconcile>;
  try {
    planned = reconcile(root, nextConfig, m, { version: m.version, distDir: cli.distDir, templatesDir: cli.templatesDir, catalog: cat });
  } catch (e) {
    return out(`Cannot build the plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  const { owned, merged } = planned.edited;
  const unknown = take.filter((r) => !owned.includes(r));
  if (unknown.length) return out(`--take names files that are not edited harness-owned files: ${list(unknown)}.`), 2;
  // An edited file whose whole content is harness's is kept unless named in --take; a merged one changes only harness's parts.
  const kept = owned.filter((r) => !take.includes(r));
  const changes: Change[] = planned.changes.filter((c) => !kept.includes(c.rel));
  const stale = pruneStale(m, changes, planned.dropped);
  if (!changes.length && !stale) return out('Nothing to change.'), 0;

  const touched = dirtyTouched(root, changes);
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the change can be undone cleanly: ${touched.join(', ')}.`), 1;
  for (const r of kept) out(`Kept \`${r}\`: you edited it. Name it in --take to replace it with harness's version.`);
  const mine = new Set([CONFIG, MANIFEST_REL, '.claude/settings.json', '.mcp.json', 'AGENTS.md', 'CLAUDE.md']);
  for (const x of cmd === 'add' ? after.filter((y) => !have.includes(y)) : [id]) {
    const src = byId.get(x)?.source;
    for (const f of src?.type === 'own' ? src.files ?? [] : []) mine.add(f.to);
  }
  const other = changes.map((c) => c.rel).filter((rel) => !mine.has(rel));
  if (other.length) out(`Note: this also refreshes harness files: ${other.join(', ')}.`);
  out('Plan:');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  for (const n of planned.notes) out(`Note: ${n}`);
  if (merged.length) out(`You edited these files; ${cmd} changes only the harness parts: ${list(merged)}.`);
  if (cmd === 'add') {
    // Items harness installed are approved: they show, but only the new ones count (a hand-selected one never installed does too).
    const approved = approvedIds(config, m, cat);
    const stop = await budgetGate(cat, approved, after, approved, config.context.budget_tokens, cli.templatesDir, out, { yes, dryRun, overBudget: args.includes('--over-budget') });
    if (stop !== null) return stop;
  }
  if (dryRun) return out('Dry run: nothing was written.'), 0;
  if (!yes && !(await cli.prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  const at = new Date();
  const files = mergeManifestFiles(m, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  try {
    applyChanges(root, changes, m.version, () => at, cli.fs, { manifest: { ...m, files } });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine(cmd as 'add' | 'remove', args) : e.message), 1;
    throw e;
  }
  removeEmptyDirs(root, changes);
  dropRestoredBackups(root, changes);
  stampHarnessFiles(root); // change detection: these writes are harness's own
  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  if (cmd === 'remove' && id === 'agent-guard') out(GUARD_OFF);
  if (cmd === 'add' && after.some((x) => !have.includes(x) && byId.get(x)?.kind === 'plugin')) out('Run /harness:sync --install-plugins to install the plugin.');
  out('Run harness git commit on a branch to commit this change.');
  return 0;
}
