import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { budgetLines, budgetVerdict, itemContext, itemContextLine, measureSelection } from '../budget/measure.js';
import { loadCatalog } from '../catalog/load.js';
import type { Catalog } from '../catalog/schema.js';
import { validateConfig } from '../core/config-io.js';
import type { HarnessConfig, Selected } from '../core/config.js';
import { claudeVersion as realClaudeVersion } from '../core/min-claude.js';
import { packageDir } from '../core/package-dir.js';
import { stampHarnessFiles } from '../core/harness-files.js';
import { ApplyError, type Change, type FsLike, ManifestError, applyChanges, readManifest, removeEmptyDirs, type Manifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { dirtyPaths } from '../install/git-status.js';
import { MANIFEST_REL, itemFiles, mergeManifestFiles } from '../install/manifest.js';
import { STRUCTURAL } from '../install/merge.js';
import { planChanges, selectedIds } from '../install/plan.js';
import { pinOf, resolveSelection } from '../install/select.js';
import type { Picks } from '../ai/picks.js';
import { budgetGate, isDenied, sandboxLine } from './init.js';
import { refuseOutsideClaude } from './claude-only.js';
import { NO_TTY, type Prompt } from './prompt.js';
import type { CliEnv } from './index.js';

export type ItemsEnv = CliEnv & { prompt: Prompt; templatesDir: string; distDir: string; fs?: FsLike; claudeVersion?: () => string | null; catalog?: Catalog };

const USAGE: Record<string, string> = {
  add: 'Usage: /harness:add <id> [--over-budget] [--dry-run|--yes]',
  remove: 'Usage: harness remove <id> [--dry-run|--yes]',
  why: 'Usage: harness why <id>',
  explain: 'Usage: harness explain',
};
const CONFIG = '.harness/config.yaml';
const HAND = 'Added by hand with harness add.';
const GUARD_OFF = 'The guard is off now, so the agent can run harness commands without asking.';

/** The stored recommendation (`.harness/picks.json`), or null when it is missing or unreadable. */
function storedPicks(root: string): Picks | null {
  try {
    const p = parseYaml(readFileSync(join(root, '.harness/picks.json'), 'utf8'));
    return p && Array.isArray(p.items) ? (p as Picks) : null;
  } catch {
    return null;
  }
}

export async function items(cmd: 'add' | 'remove' | 'why' | 'explain', args: string[], cli: ItemsEnv): Promise<number> {
  const { out } = cli;
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

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli.root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return out('Not a git repository. Run harness inside a git repo.'), 1;
  }
  let m: Manifest | null;
  try {
    m = readManifest(root);
  } catch (e) {
    if (e instanceof ManifestError) return out(e.message), 1;
    throw e;
  }
  if (!m) return out('Harness is not installed here (no `.harness/manifest.json`). Run /harness:init to install it.'), 1;
  let config: HarnessConfig;
  try {
    const v = validateConfig(parseYaml(readFileSync(join(root, CONFIG), 'utf8')));
    if (!v.ok) return v.errors.forEach((e) => out(e)), out('Next step: run harness doctor.'), 1;
    config = v.config;
  } catch (e) {
    return out(`Could not read \`${CONFIG}\`: ${(e as Error).message}\nNext step: run harness doctor.`), 1;
  }
  const lc = cli.catalog ? { catalog: cli.catalog, errors: [] as string[] } : loadCatalog();
  if (lc.errors.length) return lc.errors.forEach((e) => out(e)), out('The catalog has errors; stopped. Run harness catalog validate.'), 1;
  const cat = lc.catalog;
  const byId = new Map(cat.items.map((i) => [i.id, i]));
  const have = selectedIds(config);
  const dirs = { templates: cli.templatesDir };
  const it = id === undefined ? undefined : byId.get(id);
  const picks = storedPicks(root);

  if (cmd === 'why') {
    if (!it) return out(`Unknown item "${id}". Run harness catalog to list the ids.`), 1;
    const sel = config.items.find((i) => i.id === id && i.selected);
    const cost = `context ${it.cost.context}, setup ${it.cost.setup}`;
    if (!sel) return out(`Not installed. ${it.why} Cost: ${cost}.`), 0;
    out(`${id}: ${sel.reason}`);
    for (const f of sel.addresses) {
      const found = picks?.findings.find((x) => x.id === f);
      out(`  [${found?.severity ?? 'unknown'}] ${found?.title ?? f}`);
    }
    out(`Cost: ${cost}.`);
    out(`Context: ${itemContextLine(itemContext(it, dirs))}.`);
    return 0;
  }
  if (cmd === 'explain') {
    for (const s of config.items.filter((i) => i.selected)) {
      out(`${s.id} (${byId.get(s.id)?.kind ?? 'unknown'}): ${s.reason}`);
      for (const f of itemFiles(m, s.id)) out(`  ${f.rel}`);
    }
    const v = await measureSelection(have, cat, { ...dirs, plugin: dirname(packageDir('templates')) });
    out(budgetLines(budgetVerdict(v, v, config.context.budget_tokens))[0]);
    return 0;
  }

  // add and remove: the selection changes, planChanges does the rest (the same path as update).
  if (!config.items.length) return out('This install predates the item catalog. Run /harness:update with recommendations first.'), 1;
  if (!it) return out(`Unknown item "${id}". Run harness catalog to list the ids.`), 1;
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
  const ent = (rel: string) => m!.files.find((f) => f.rel === rel);
  let planned: ReturnType<typeof planChanges>;
  try {
    planned = planChanges(root, nextConfig, detect(root), {
      version: m.version, distDir: cli.distDir, templatesDir: cli.templatesDir, catalog: cat,
      recorded: ent('.claude/settings.json')?.blocks, mcpRecorded: ent('.mcp.json')?.blocks, recordedFiles: m.files,
    });
  } catch (e) {
    return out(`Cannot build the plan: ${(e as Error).message} Run harness doctor to see what is wrong.`), 1;
  }
  // A harness-created .mcp.json that ends with nothing in it goes away.
  const changes: Change[] = planned.changes.map((c) => {
    if (c.kind !== 'update' || c.rel !== '.mcp.json' || ent(c.rel)?.kind !== 'create') return c;
    try {
      return Object.keys(JSON.parse(c.after)).length ? c : { kind: 'delete', rel: c.rel, before: c.before };
    } catch {
      return c;
    }
  });

  // A file with no change still loses its dropped blocks.
  for (const rel of STRUCTURAL) {
    const f = m.files.find((x) => x.rel === rel);
    if (changes.some((c) => c.rel === rel) || !f?.blocks) continue;
    const kept = f.blocks.filter((b) => !planned.dropped.includes(b));
    if (kept.length) f.blocks = kept;
    else delete f.blocks;
  }
  if (!changes.length) return out('Nothing to change.'), 0;

  const dirty = dirtyPaths(root);
  const touched = changes.map((c) => c.rel).filter((rel) => dirty.some((d) => d === rel || (d.endsWith('/') && rel.startsWith(d))));
  if (touched.length && !dryRun) return out(`Commit or stash these files first, so the change can be undone cleanly: ${touched.join(', ')}.`), 1;
  out('Plan:');
  for (const c of changes) {
    out(`  ${c.kind} ${c.rel}`);
    if (c.kind === 'update') out(unifiedDiff(c.before, c.after, c.rel).trimEnd());
  }
  for (const n of planned.notes) out(`Note: ${n}`);
  if (cmd === 'add') {
    // The ids already installed are approved: they show, but only the new ones count.
    const stop = await budgetGate(cat, have, after, have, config.context.budget_tokens, cli.templatesDir, out, { yes, dryRun, overBudget: args.includes('--over-budget') });
    if (stop !== null) return stop;
  }
  if (dryRun) return out('Dry run: nothing was written.'), 0;
  if (!yes && !(await cli.prompt.confirm('Apply these changes? (y/N)'))) return out('Cancelled. Nothing was written.'), 0;

  const at = new Date();
  const files = mergeManifestFiles(m, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  try {
    applyChanges(root, changes, m.version, () => at, cli.fs, { manifest: { ...m, files } });
  } catch (e) {
    if (e instanceof ApplyError) return out(isDenied(e) ? sandboxLine('update', args) : e.message), 1;
    throw e;
  }
  removeEmptyDirs(root, changes);
  // The original is back in place. The path comes from the manifest; delete only inside .harness/backup/.
  for (const c of changes) if (c.kind === 'update' && c.restored?.startsWith('.harness/backup/') && !c.restored.split(/[\\/]/).includes('..')) rmSync(join(root, c.restored), { force: true });
  stampHarnessFiles(root); // change detection: these writes are harness's own
  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : c.kind === 'delete' ? 'Removed' : 'Updated'} \`${c.rel}\``);
  if (cmd === 'add') out('Run harness git commit on a branch to commit this change.');
  else {
    out(`Removed ${id}. Commit these files: ${[...changes.map((c) => c.rel), MANIFEST_REL].join(', ')}.`);
    if (id === 'agent-guard') out(GUARD_OFF);
  }
  return 0;
}
