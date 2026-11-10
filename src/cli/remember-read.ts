// The read-only `harness remember` output (spec §5, §9): `list`, and `check`'s lines, which `doctor` shares.
import type { HarnessConfig } from '../core/config.js';
import { DECISIONS_DIR, shown, type TeamDecision } from '../core/decision-file.js';
import { outOfSync, planSync, readDecisions, type SyncPlan } from '../core/decisions.js';
import { isStale, staleness, type Git, type Staleness } from '../core/decisions-stale.js';

const STATUS_WIDTH = 8; // `superseded` overflows by design and still gets one space
const SHOWN_FILES = 3;
const CMD = 'harness remember';
const sha7 = (s: string): string => s.slice(0, 7);
const files = (n: number): string => `${n} linked file${n === 1 ? '' : 's'}`;
// One count per file: an error line is `<rel>: <problem>`, and a file can have several.
const invalidFiles = (errors: string[]): number => new Set(errors.map((e) => e.slice(0, e.indexOf(': ')))).size;

export type DecisionLine = { level: 'ok' | 'fix' | 'note'; text: string };
export interface DecisionSummary { n: number; errors: number; stale: number; expired: number; oversized: number; inSync: boolean }

/** Staleness of the active decisions, by id; `note` when git failed. */
function staleOf(root: string, cfg: HarnessConfig, today: string, ds: TeamDecision[], git?: Git) {
  const active = ds.filter((d) => d.status === 'active');
  const r = staleness(root, active, { today, expiryDays: cfg.decisions.expiry_days, cap: cfg.decisions.max_lines, ...(git ? { git } : {}) });
  return { active, states: r.states, note: r.note };
}

/** One line per valid decision, sorted by id, then a count of the invalid ones. */
export function list(root: string, cfg: HarnessConfig, today: string, git?: Git): string[] {
  const set = readDecisions(root, today);
  const { states, note } = staleOf(root, cfg, today, set.decisions, git);
  const byId = new Map(states.map((s) => [s.id, s]));
  const column = (s: Staleness | undefined): string => {
    if (!s || !isStale(s)) return '';
    const why = [...s.dead.map((g) => `${shown(g)} matches no tracked file`), ...(s.changed.length ? [`${files(s.changed.length)} changed since ${sha7(s.ref)}`] : [])];
    return `  stale: ${why.join('; ')}`;
  };
  const lines = set.decisions
    .map((d) => `${d.id}  ${d.status.padEnd(STATUS_WIDTH)} confirmed ${d.verified_on}  ${d.paths.map(shown).join(', ')}${column(byId.get(d.id))}`)
    .sort();
  const invalid = invalidFiles(set.errors);
  return [...lines, ...(invalid ? [`${invalid} invalid; run harness remember sync to see why`] : []), ...(note ? [shown(note)] : [])];
}

function stateLines(d: TeamDecision, s: Staleness, cfg: HarnessConfig): DecisionLine[] {
  const note = (text: string): DecisionLine => ({ level: 'note', text });
  const out = s.dead.map((g) => note(`decision ${d.id} is stale: ${shown(g)} matches no tracked file: fix its paths by hand, or run ${CMD} retire ${d.id}`));
  if (s.changed.length) {
    const first = s.changed.slice(0, SHOWN_FILES).map(shown).join(', ') + (s.changed.length > SHOWN_FILES ? '…' : '');
    out.push(note(`decision ${d.id} is stale: ${files(s.changed.length)} changed since ${sha7(s.ref)} (${first}): check it still holds, then run ${CMD} confirm ${d.id}`));
  }
  if (s.expired) out.push(note(`decision ${d.id} expired: last confirmed ${d.verified_on}, over ${cfg.decisions.expiry_days} days ago, so its rule no longer loads after the next sync: run ${CMD} confirm ${d.id} or ${CMD} retire ${d.id}`));
  if (s.oversized) out.push(note(`decision ${d.id} is oversized: its rule is ${s.oversized.lines} lines, cap ${cfg.decisions.max_lines}, so it is cut: shorten it by hand, then run ${CMD} sync`));
  if (s.fallback) out.push(note(`decision ${d.id}: verified_at ${sha7(d.verified_at)} is not in this clone; compared from the decision file's last commit`));
  return out;
}

/** §9's doctor lines and the counts `check` prints. Read-only: local git only, and it never throws on a git failure. */
export function decisionLines(root: string, cfg: HarnessConfig, today: string, git?: Git): { lines: DecisionLine[]; summary: DecisionSummary } {
  const set = readDecisions(root, today);
  const fix = (text: string): DecisionLine => ({ level: 'fix', text });
  const lines = set.errors.map((e) => fix(`${shown(e)}: correct it by hand, then run ${CMD} sync`));
  let plan: SyncPlan | null = null;
  try {
    plan = planSync(root, set, cfg.decisions, today);
  } catch (e) { // e.g. a rule file that is a symlink: report it, never crash
    lines.push(fix(`${shown((e as Error).message)}: replace it with a real file or rename it`));
  }
  if (plan && outOfSync(plan)) lines.push(fix(`decision rules are out of sync with ${DECISIONS_DIR}/: run ${CMD} sync`));
  for (const f of plan?.foreign ?? []) lines.push(fix(`${shown(f)} is named like a harness decision rule but isn't harness's: rename it`));
  const inSync = plan !== null && !outOfSync(plan) && plan.foreign.length === 0;
  const { active, states, note } = staleOf(root, cfg, today, set.decisions, git);
  lines.push({ level: 'ok', text: set.decisions.length ? `decisions: ${active.length} active, rules ${inSync ? 'in sync' : 'out of sync'}` : 'no team decisions yet' });
  if (note) lines.push({ level: 'note', text: shown(note) });
  active.forEach((d, i) => lines.push(...stateLines(d, states[i]!, cfg)));
  const count = (f: (s: Staleness) => boolean) => states.filter(f).length;
  const summary = {
    n: set.decisions.length, errors: invalidFiles(set.errors) + (plan ? plan.foreign.length : 1),
    stale: count(isStale), expired: count((s) => s.expired), oversized: count((s) => s.oversized !== null), inSync,
  };
  return { lines, summary };
}

/** `harness remember check`: for CI. Exit 1 on an invalid file or rules out of sync; staleness alone never fails it. */
export function check(root: string, cfg: HarnessConfig, today: string, out: (s: string) => void, git?: Git): number {
  const { lines, summary: s } = decisionLines(root, cfg, today, git);
  lines.forEach((l) => out(`${l.level} ${l.text}`));
  out(`${s.n} decisions: ${s.errors} errors, ${s.stale} stale, ${s.expired} expired, ${s.oversized} oversized, rules ${s.inSync ? 'in sync' : 'out of sync'}`);
  return s.errors || !s.inSync ? 1 : 0;
}
