// `harness rules [--apply]`: the stack's ESLint rules with today's violation counts, then on a typed yes writes them (spec 5.2).
// Harness writes its own `.harness/eslint/harness.config.mjs` and adds one import and one spread to the repo's flat config,
// both recorded in the manifest so uninstall takes them out. It never creates an ESLint config the repo didn't have.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stampHarnessFiles } from '../core/harness-files.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { ApplyError, applyChanges, type Change } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { unifiedDiff } from '../install/diff.js';
import { dirtyTouched } from '../install/finish.js';
import { mergeManifestFiles, rawOf } from '../install/manifest.js';
import { HARNESS_RULES_IMPORT, mergeEslintHarnessRules } from '../install/merge.js';
import { ESLINT } from '../install/plan.js';
import { countViolations, type Counts } from '../rules/count.js';
import { propose, type Proposal } from '../rules/propose.js';
import type { Stack } from '../rules/table.js';
import type { CliEnv } from './index.js';
import { openInstall } from './preamble.js';
import type { Prompt } from './prompt.js';

const USAGE = 'Usage: harness rules [--apply]';
const FILE = '.harness/eslint/harness.config.mjs';
const LEGACY = /^\.eslintrc(\.(js|cjs|json|ya?ml))?$/;
const TS_CONFIG_NODE = [22, 18]; // first Node that loads eslint.config.ts without a flag
const NOT_APPLIED = 'Not applied. Nothing was written.';

/** The proposal for this repo's stacks, from detect's dependency names. */
function proposalFor(root: string): Proposal {
  const facts = detect(root);
  const deps = new Set(facts.deps);
  const stacks = new Set<Stack>();
  if (deps.has('typescript')) stacks.add('ts');
  if (deps.has('react')) stacks.add('react');
  if (deps.has('next')) stacks.add('next');
  if (deps.has('react-native') || deps.has('expo')) stacks.add('rn');
  // ponytail: a web app counts as Next when any package depends on next; per-package deps would tell a mixed monorepo apart.
  const packages = facts.apps.map((a) => ({ dir: a.dir, frameworks: a.kind === 'mobile' ? ['rn'] : a.kind === 'web' && deps.has('next') ? ['next'] : [] }));
  return propose(stacks, packages, deps);
}

/** The harness file's text: ESLint rejected the dropped rules, so they are filtered out the way the count preview did. */
function fileText(p: Proposal, dropped: string[]): string {
  if (!dropped.length) return p.configText;
  return `${p.configText.replace('export default ', 'const proposal = ')}const drop = new Set(${JSON.stringify(dropped)});
export default proposal.map((b) => (b.rules ? { ...b, rules: Object.fromEntries(Object.entries(b.rules).filter(([k]) => !drop.has(k))) } : b));
`;
}

function printCounts(c: Counts['eslint'], p: Proposal, cfg: string | undefined, out: (s: string) => void): void {
  if (c.error) {
    out(`Violation counts unknown (${c.error}). The effect on the stop gate is unknown.`);
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    if (cfg?.endsWith('.ts') && (major < TS_CONFIG_NODE[0]! || (major === TS_CONFIG_NODE[0] && minor < TS_CONFIG_NODE[1]!)))
      out(`Counting loads ${cfg} through Node, which needs Node ${TS_CONFIG_NODE.join('.')} or later (this is Node ${process.versions.node}).`);
    return;
  }
  const rows = Object.entries(c.byRule).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const total = rows.reduce((n, [, k]) => n + k, 0);
  if (rows.length) {
    out('Violations today, by rule (highest first):');
    for (const [id, n] of rows) out(`  ${id}: ${n}`);
    out(`Total: ${total}`);
    out(`The stop gate's lint and typecheck steps will fail until these ${total} violations are fixed. CI fails too if it runs them.`);
  } else out('No violations today: the stop gate is not affected.');
  const flagged = (id: string) => rows.some(([k]) => k === id || k.startsWith(`${id}/`)) || c.dropped.some((d) => d.rule === id);
  const safe = p.rules.map((r) => r.id).filter((id) => !flagged(id));
  if (safe.length) out(`Safe to add now (0 violations):\n  ${safe.join(', ')}`);
}

function printGaps(p: Proposal, dropped: Counts['eslint']['dropped'], out: (s: string) => void): void {
  const byPlugin = new Map<string, string[]>();
  for (const m of [...p.missing, ...p.skipped]) byPlugin.set(m.plugin, [...(byPlugin.get(m.plugin) ?? []), m.rule]);
  if (byPlugin.size) {
    out('Left out until you install the plugin (harness does not install it):');
    for (const [plugin, ids] of byPlugin) out(`  needs \`${plugin}\`: ${ids.join(', ')}`);
  }
  if (dropped.length) out(`Left out, the installed plugin does not have the rule: ${dropped.map((d) => d.rule).join(', ')}`);
  out(`No lint equivalent: ${p.noLint.map((n) => n.antiPattern).join('; ')}`);
}

/** Why --apply can't edit the repo's ESLint config, with what the person does instead. */
function refuse(root: string, cfg: string | undefined, p: Proposal, out: (s: string) => void): number {
  const legacy = readdirSync(root).find((f) => LEGACY.test(f));
  out(cfg
    ? `Harness can't edit \`${cfg}\` safely: it does not export a plain flat-config array. Nothing was written.`
    : `${legacy ? `\`${legacy}\` is a legacy ESLint config` : 'This repo has no ESLint config'}. Harness only adds to a flat config (\`eslint.config.mjs\`); it never creates one. Nothing was written.`);
  out('Manual steps:');
  out(cfg ? `  1. Make \`${cfg}\` export a plain array: \`export default [...]\`.` : legacy ? `  1. Move \`${legacy}\` to a flat config, \`eslint.config.mjs\` (ESLint's Configuration Migration Guide).` : '  1. Add an ESLint flat config, `eslint.config.mjs`.');
  const missing = [...new Set([...p.missing, ...p.skipped].map((m) => m.plugin))];
  if (missing.length) out(`  2. Install the plugins the rules need: ${missing.map((m) => `needs \`${m}\``).join(', ')}.`);
  out(`  ${missing.length ? 3 : 2}. Run harness rules --apply again. It adds these two lines to the flat config:`);
  out(`     ${HARNESS_RULES_IMPORT}`);
  out('     ...harnessRules   (at the end of the exported array)');
  return 1;
}

export async function rules(args: string[], cli: CliEnv & { prompt: Prompt; exec?: Exec }): Promise<number> {
  const { out } = cli;
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) return out(USAGE), 2;
  const apply = args[0] === '--apply';
  if (apply && cli.tty === false) return out('harness rules --apply asks you to type yes: run it in your own terminal.'), 2;
  const opened = openInstall(cli, 'Not a git repository. Run harness inside a git repo.');
  if (typeof opened === 'number') return opened;
  const { root, m } = opened;

  const p = proposalFor(root);
  const cfg = ESLINT.find((f) => existsSync(join(root, f)));
  const before = cfg ? readFileSync(join(root, cfg), 'utf8') : null;
  const merged = before === null ? null : mergeEslintHarnessRules(before);
  if (apply && !merged) return refuse(root, cfg, p, out);

  const counts = await countViolations(root, { ...p, ts: {} }, cli.exec ?? defaultExec); // only the ESLint part is applied
  printCounts(counts.eslint, p, cfg, out);
  printGaps(p, counts.eslint.dropped, out);

  const text = fileText(p, counts.eslint.dropped.map((d) => d.rule));
  const abs = join(root, FILE);
  const old = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  const changes: Change[] = [];
  if (old === null) changes.push({ kind: 'create', rel: FILE, content: text });
  else if (old !== text) changes.push({ kind: 'update', rel: FILE, before: old, after: text, blocks: [], rewrite: true });
  if (cfg && merged?.blocks.length) changes.push({ kind: 'update', rel: cfg, before: before!, after: merged.after, blocks: merged.blocks });
  for (const c of changes) out(unifiedDiff(c.kind === 'update' ? c.before : '', c.kind === 'update' ? c.after : c.kind === 'create' ? c.content : '', c.rel).trimEnd());
  if (!apply) return out(merged ? 'Run harness rules --apply to write this.' : 'harness rules --apply needs a flat ESLint config it can edit.'), 0;
  if (!changes.length) return out('Nothing to change.'), 0;
  const dirty = dirtyTouched(root, changes);
  if (dirty.length) return out(`Commit or stash these files first, so the change can be undone cleanly: ${dirty.join(', ')}. ${NOT_APPLIED}`), 1;

  const answer = await cli.prompt.edit('Type yes to apply these ESLint rules', '').catch(() => ''); // closed input is a No
  if (answer.trim() !== 'yes') return out(NOT_APPLIED), 1;
  const at = new Date();
  const files = mergeManifestFiles(m, changes, `.harness/backup/${at.toISOString().replace(/:/g, '-')}`);
  try {
    applyChanges(root, changes, m.version, () => at, undefined, { manifest: { ...m, files }, manifestBefore: rawOf(m) });
  } catch (e) {
    if (e instanceof ApplyError) return out(e.message), 1;
    throw e;
  }
  stampHarnessFiles(root);
  for (const c of changes) out(`${c.kind === 'create' ? 'Created' : 'Updated'} \`${c.rel}\``);
  out('Run harness git commit on a branch to commit this change.');
  return 0;
}
