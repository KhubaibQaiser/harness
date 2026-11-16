// The evidence ledger (spec §4.2): one row per exact check run, written only by the evidenceLedger hook into protected state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendNoFollow, ensureRealDir } from '../core/atomic.js';
import { isObj } from '../core/config.js';
import { plainArgv } from './commands.js';
import type { Contract } from './contract.js';

export interface RunRow { kind: 'run'; ts: string; session: string; command: string; exit: number | null; tree: string; contract: string; criteria: string[] }
export interface BlockedRow { kind: 'blocked'; ts: string; session: string; task: string; reason: string; failing_criteria: string[]; tree: string; contract: string }
export type LedgerRow = RunRow | BlockedRow;
export interface Gap { kind: 'check' | 'criterion'; id: string; label: string }

export const LEDGER = '.harness/state/evidence.jsonl';

export function appendRow(root: string, row: LedgerRow): void {
  const p = join(root, LEDGER);
  ensureRealDir(root, '.harness/state');
  appendNoFollow(p, JSON.stringify(row) + '\n');
}

const isRow = (r: unknown): r is LedgerRow =>
  isObj(r) && typeof r.tree === 'string' && typeof r.contract === 'string' &&
  ((r.kind === 'run' && typeof r.command === 'string' && Array.isArray(r.criteria)) || (r.kind === 'blocked' && typeof r.task === 'string' && Array.isArray(r.failing_criteria)));

/** Every well-formed row, oldest first; malformed lines are skipped. */
export function readLedger(root: string): LedgerRow[] {
  const p = join(root, LEDGER);
  if (!existsSync(p)) return [];
  const out: LedgerRow[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    try {
      const r: unknown = JSON.parse(line);
      if (isRow(r)) out.push(r);
    } catch {
      // a torn or blank line: skip
    }
  }
  return out;
}

const fresh = (r: LedgerRow, c: Contract, tree: string) => r.tree === tree && r.contract === c.sha256;
export const sameArgv = (a: string[] | null, b: string[]): boolean => a !== null && a.length === b.length && a.every((w, i) => w === b[i]);

/**
 * Passing evidence at this tree and contract hash, keyed `check:<name>` and `criterion:<id>`, and what has none.
 * A check passes on a fresh row with its exact argv and exit 0; a criterion on a fresh row listing its id. `person` criteria are never gaps.
 */
export function freshEvidence(c: Contract, rows: LedgerRow[], tree: string, argvOf: (check: string) => string[] | null): { pass: Map<string, RunRow>; gaps: Gap[] } {
  const runs = rows.filter((r): r is RunRow => r.kind === 'run' && fresh(r, c, tree));
  const pass = new Map<string, RunRow>();
  const gaps: Gap[] = [];
  for (const name of c.checks) {
    const argv = argvOf(name);
    const row = argv && runs.findLast((r) => r.exit === 0 && sameArgv(plainArgv(r.command), argv));
    if (row) pass.set(`check:${name}`, row);
    else gaps.push({ kind: 'check', id: name, label: argv ? argv.join(' ') : name });
  }
  for (const cr of c.criteria) {
    if ('person' in cr.check) continue;
    const row = runs.findLast((r) => r.criteria.includes(cr.id));
    if (row) pass.set(`criterion:${cr.id}`, row);
    else gaps.push({ kind: 'criterion', id: cr.id, label: 'test' in cr.check ? cr.check.test : cr.check.run });
  }
  return { pass, gaps };
}

/** The newest blocked row for this contract at this tree, or null. */
export function latestBlocked(rows: LedgerRow[], c: Contract, tree: string): BlockedRow | null {
  return rows.findLast((r): r is BlockedRow => r.kind === 'blocked' && r.task === c.id && fresh(r, c, tree)) ?? null;
}
