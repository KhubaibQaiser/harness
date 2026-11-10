// Team decision sync (spec §4.3, §4.4): docs/decisions/ -> .claude/rules/harness-decision-*.md, through the manifest.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyChanges, linkedPath, refuseSymlink, type Change, type FsLike } from '../install/apply.js';
import { mergeManifestFiles, rawOf, readManifest, type Manifest } from '../install/manifest.js';
import { hashText } from '../install/text.js';
import type { HarnessConfig } from './config.js';
import { DECISIONS_DIR, parseDecision, type TeamDecision } from './decision-file.js';
import { RULE_GLOB, renderRule, ruleRel } from './decision-rule.js';
import { stampHarnessFiles } from './harness-files.js';

export interface DecisionSet { decisions: TeamDecision[]; errors: string[]; others: string[] }

const RULES_DIR = '.claude/rules';
// ponytail: a plain string: usage.test.ts flags this command name in a template until Task 6 adds the command.
const PREFIX = 'harness remember:';
const DAY_MS = 86_400_000;

const files = (root: string, dir: string): string[] => {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name).sort();
  } catch {
    return []; // no folder: nothing there
  }
};

/** Every file in docs/decisions/, by name. Folder-wide checks: unique ids, and `superseded_by` names a decision here. */
export function readDecisions(root: string, today: string): DecisionSet {
  const set: DecisionSet = { decisions: [], errors: [], others: [] };
  if (linkedPath(root, DECISIONS_DIR)) return { ...set, errors: [`${DECISIONS_DIR}: folder must not be a symlink`] };
  const seen = new Set<string>();
  for (const name of files(root, DECISIONS_DIR)) {
    const rel = `${DECISIONS_DIR}/${name}`;
    if (linkedPath(root, rel)) { set.errors.push(`${rel}: file must not be a symlink`); continue; }
    if (!name.endsWith('.md')) { set.others.push(rel); continue; }
    const { decision, errors } = parseDecision(rel, readFileSync(join(root, rel), 'utf8'), today);
    if (errors.length) set.errors.push(...errors);
    else if (!decision) set.others.push(rel);
    else if (seen.has(decision.id)) set.errors.push(`${rel}: id must be unique in ${DECISIONS_DIR}/`);
    else { seen.add(decision.id); set.decisions.push(decision); }
  }
  const dangling = set.decisions.filter((d) => d.superseded_by !== undefined && !seen.has(d.superseded_by));
  set.errors.push(...dangling.map((d) => `${d.rel}: superseded_by must name a decision in ${DECISIONS_DIR}/`));
  set.decisions = set.decisions.filter((d) => !dangling.includes(d));
  return set;
}

/** `active`, and confirmed no more than `expiryDays` days before `today` (UTC dates). */
export const isLive = (d: TeamDecision, today: string, expiryDays: number): boolean =>
  d.status === 'active' && (Date.parse(today) - Date.parse(d.verified_on)) / DAY_MS <= expiryDays;

export interface SyncPlan {
  /** Rule files only: create, update (`rewrite`) or delete. */
  changes: Change[];
  /** harness-decision-*.md files the manifest doesn't know and whose bytes differ from what sync wants. */
  foreign: string[];
  /** Rule files with no manifest entry whose bytes are what sync would write: recorded, not rewritten (after a manifest conflict). */
  adopt: string[];
  /** Rule entries whose file is gone and no decision wants: dropped from the manifest. */
  stale: string[];
  wanted: number;
  leftOut: number;
}

export function planSync(root: string, set: DecisionSet, cfg: HarnessConfig['decisions'], today: string): SyncPlan {
  const live = set.decisions.filter((d) => isLive(d, today, cfg.expiry_days));
  const want = new Map(live.map((d) => [ruleRel(d.id), renderRule(d, cfg.max_lines).text]));
  const known = new Set((readManifest(root)?.files ?? []).map((f) => f.rel).filter((r) => RULE_GLOB.test(r)));
  const disk = new Map<string, string>();
  for (const name of files(root, RULES_DIR)) {
    const rel = `${RULES_DIR}/${name}`;
    if (!RULE_GLOB.test(rel)) continue;
    refuseSymlink(root, rel);
    disk.set(rel, readFileSync(join(root, rel), 'utf8'));
  }
  const p: SyncPlan = { changes: [], foreign: [], adopt: [], stale: [], wanted: want.size, leftOut: set.decisions.length - want.size };
  for (const [rel, text] of want) {
    const cur = disk.get(rel);
    if (cur === undefined) p.changes.push({ kind: 'create', rel, content: text });
    else if (!known.has(rel)) (cur === text ? p.adopt : p.foreign).push(rel);
    else if (cur !== text) p.changes.push({ kind: 'update', rel, before: cur, after: text, blocks: [], rewrite: true });
  }
  for (const [rel, cur] of disk) {
    if (want.has(rel)) continue;
    if (known.has(rel)) p.changes.push({ kind: 'delete', rel, before: cur });
    else p.foreign.push(rel);
  }
  p.stale = [...known].filter((rel) => !disk.has(rel) && !want.has(rel));
  p.foreign.sort();
  return p;
}

export const outOfSync = (p: SyncPlan): boolean => p.changes.length > 0;

const sortByRel = (f: Manifest['files']): Manifest['files'] => [...f].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

/** One transaction: the decision writes, the rule changes and the manifest; then the CLI snapshot, so change detection skips it. */
export function commitDecisions(root: string, decisionChanges: Change[], plan: SyncPlan, o: { now: () => Date; fs?: FsLike }): void {
  if (plan.foreign.length) throw new Error(`${PREFIX} ${plan.foreign[0]} is not harness's; rename it`);
  const m = readManifest(root);
  if (!m) throw new Error(`${PREFIX} .harness/manifest.json is missing`);
  const adopted = plan.adopt.map((rel) => ({ rel, kind: 'create' as const, hash: hashText(readFileSync(join(root, rel), 'utf8')) }));
  const merged = mergeManifestFiles(m, plan.changes).filter((f) => !plan.stale.includes(f.rel));
  applyChanges(root, [...decisionChanges, ...plan.changes], m.version, o.now, o.fs, { manifest: { ...m, files: sortByRel([...merged, ...adopted]) }, manifestBefore: rawOf(m) });
  stampHarnessFiles(root);
}
