// Team decision sync (spec §4.3, §4.4): docs/decisions/ -> .claude/rules/harness-decision-*.md, through the manifest.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { applyChanges, linkedPath, refuseSymlink, type Change, type FsLike } from '../install/apply.js';
import { mergeManifestFiles, rawOf, readManifest, type Manifest } from '../install/manifest.js';
import { hashText, matchesHash } from '../install/text.js';
import type { HarnessConfig } from './config.js';
import { DECISIONS_DIR, MAX_DECISION_BYTES, isDecisionText, parseDecision, shown, type TeamDecision } from './decision-file.js';
import { RULE_GLOB, renderRule, ruleRel } from './decision-rule.js';
import { stampHarnessFiles } from './harness-files.js';
import { scanSecrets } from './secrets.js';

export interface DecisionSet { decisions: TeamDecision[]; errors: string[]; others: string[] }

const RULES_DIR = '.claude/rules';
const DAY_MS = 86_400_000;

const files = (root: string, dir: string): string[] => {
  try {
    return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name).sort();
  } catch {
    return []; // no folder: nothing there
  }
};

/** The file's text, or null when it is over the cap; then only the head is read, to tell a decision from an ADR. */
function capped(path: string): { text: string | null; decision: boolean } {
  if (statSync(path).size <= MAX_DECISION_BYTES) return { text: readFileSync(path, 'utf8'), decision: false };
  const head = Buffer.alloc(MAX_DECISION_BYTES);
  const fd = openSync(path, 'r');
  try {
    return { text: null, decision: isDecisionText(head.subarray(0, readSync(fd, head, 0, MAX_DECISION_BYTES, 0)).toString('utf8')) };
  } finally {
    closeSync(fd);
  }
}

/** Every file in docs/decisions/, by name. Folder-wide checks: unique ids, and `superseded_by` names a decision here. */
export function readDecisions(root: string, today: string): DecisionSet {
  const set: DecisionSet = { decisions: [], errors: [], others: [] };
  if (linkedPath(root, DECISIONS_DIR)) return { ...set, errors: [`${DECISIONS_DIR}: folder must not be a symlink`] };
  const seen = new Set<string>();
  for (const name of files(root, DECISIONS_DIR)) {
    const rel = `${DECISIONS_DIR}/${name}`;
    if (linkedPath(root, rel)) { set.errors.push(`${shown(rel)}: file must not be a symlink`); continue; }
    if (!name.endsWith('.md')) { set.others.push(rel); continue; }
    const c = capped(join(root, rel));
    if (c.text === null) { (c.decision ? set.errors : set.others).push(c.decision ? `${shown(rel)}: file must be at most ${MAX_DECISION_BYTES} bytes` : rel); continue; }
    const { decision, errors } = parseDecision(rel, c.text, today);
    if (errors.length) set.errors.push(...errors);
    else if (!decision) set.others.push(rel);
    else if (seen.has(decision.id)) set.errors.push(`${shown(rel)}: id must be unique in ${DECISIONS_DIR}/`);
    else { seen.add(decision.id); set.decisions.push(decision); }
  }
  const dangling = set.decisions.filter((d) => d.superseded_by !== undefined && !seen.has(d.superseded_by));
  set.errors.push(...dangling.map((d) => `${shown(d.rel)}: superseded_by must name a decision in ${DECISIONS_DIR}/`));
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
  /** Rule entries whose file is what sync wants but whose recorded hash is not (a conflict kept the other side's manifest). */
  rehash: string[];
  /** Rule entries whose file is gone and no decision wants: dropped from the manifest. */
  stale: string[];
  wanted: number;
  leftOut: number;
}

export function planSync(root: string, set: DecisionSet, cfg: HarnessConfig['decisions'], today: string): SyncPlan {
  const live = set.decisions.filter((d) => isLive(d, today, cfg.expiry_days));
  const want = new Map(live.map((d) => [ruleRel(d.id), renderRule(d, cfg.max_lines).text]));
  const hashes = new Map((readManifest(root)?.files ?? []).filter((f) => RULE_GLOB.test(f.rel)).map((f) => [f.rel, f.hash]));
  const known = new Set(hashes.keys());
  const disk = new Map<string, string>();
  for (const name of files(root, RULES_DIR)) {
    const rel = `${RULES_DIR}/${name}`;
    if (!RULE_GLOB.test(rel)) continue;
    refuseSymlink(root, rel);
    disk.set(rel, readFileSync(join(root, rel), 'utf8'));
  }
  const p: SyncPlan = { changes: [], foreign: [], adopt: [], rehash: [], stale: [], wanted: want.size, leftOut: set.decisions.length - want.size };
  for (const [rel, text] of want) {
    const cur = disk.get(rel);
    const same = cur?.replace(/\r\n/g, '\n') === text; // a core.autocrlf=true checkout is CRLF (§4.1: LF, so hashes match)
    if (cur === undefined) p.changes.push({ kind: 'create', rel, content: text });
    else if (!known.has(rel)) (same ? p.adopt : p.foreign).push(rel);
    else if (!same) p.changes.push({ kind: 'update', rel, before: cur, after: text, blocks: [], rewrite: true });
    else if (!matchesHash(text, hashes.get(rel)!)) p.rehash.push(rel);
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

/** The rule entries sorted by `rel`, as one block where the first one was (at the end when there was none); the rest keep their order. */
function placeRules(files: Manifest['files'], firstRule: number): Manifest['files'] {
  const rules = files.filter((f) => RULE_GLOB.test(f.rel)).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const rest = files.filter((f) => !RULE_GLOB.test(f.rel));
  const at = firstRule < 0 ? rest.length : files.slice(0, firstRule).filter((f) => !RULE_GLOB.test(f.rel)).length;
  return [...rest.slice(0, at), ...rules, ...rest.slice(at)];
}

/** The §4.3 stop line for the first foreign rule, or null. */
export const foreignLine = (plan: SyncPlan): string | null => (plan.foreign.length ? `harness remember: ${shown(plan.foreign[0]!)} is not harness's; rename it` : null);

/** §5 step 3 for sync: the stop line for the first rule it would write that looks like it holds a secret, or null. */
export function secretLine(plan: SyncPlan): string | null {
  for (const c of plan.changes) {
    const hit = c.kind === 'delete' ? undefined : scanSecrets(c.kind === 'create' ? c.content : c.after)[0];
    if (hit) return `harness remember: ${shown(c.rel)} would hold a secret (${hit.kind}). Decisions are committed to git. Remove it from the decision by hand, then run sync again.`;
  }
  return null;
}

/** Manifest-only work: rules to adopt, rehash or forget. */
export const manifestWork = (plan: SyncPlan): number => plan.adopt.length + plan.rehash.length + plan.stale.length;

/** `merged` (from `mergeManifestFiles` over the plan's changes) with the plan's adopt, rehash and stale applied, rules sorted in place. */
export function withRules(root: string, m: Manifest, merged: Manifest['files'], plan: SyncPlan): { files: Manifest['files']; adopted: number } {
  const hashOf = (rel: string) => hashText(readFileSync(join(root, rel), 'utf8'));
  // Filtered against this read of the manifest: another command may have recorded the file since the plan.
  const adopted = plan.adopt.filter((rel) => !m.files.some((f) => f.rel === rel)).map((rel) => ({ rel, kind: 'create' as const, hash: hashOf(rel) }));
  const files = merged.filter((f) => !plan.stale.includes(f.rel)).map((f) => (plan.rehash.includes(f.rel) ? { ...f, hash: hashOf(f.rel) } : f));
  return { files: placeRules([...files, ...adopted], m.files.findIndex((f) => RULE_GLOB.test(f.rel))), adopted: adopted.length };
}

/** One transaction: the decision writes, the rule changes and the manifest; then the CLI snapshot, so change detection skips it. */
export function commitDecisions(root: string, decisionChanges: Change[], plan: SyncPlan, o: { now: () => Date; fs?: FsLike }): void {
  const foreign = foreignLine(plan);
  if (foreign) throw new Error(foreign);
  const m = readManifest(root);
  if (!m) throw new Error('harness remember: .harness/manifest.json is missing');
  const { files, adopted } = withRules(root, m, mergeManifestFiles(m, plan.changes), plan);
  if (decisionChanges.length + plan.changes.length + adopted + plan.stale.length + plan.rehash.length > 0) {
    applyChanges(root, [...decisionChanges, ...plan.changes], m.version, o.now, o.fs, { manifest: { ...m, files }, manifestBefore: rawOf(m) });
  }
  stampHarnessFiles(root);
}
