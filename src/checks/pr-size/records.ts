// pr-size's state files under .harness/state: one capped reader and one writer, and the recorded PR branches.
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../core/atomic.js';
import { isObj } from '../../core/config.js';
import { plainBranch } from './measure.js';

const JSON_INDENT = 2;
// One entry per branch, never pruned; a file past this reads as empty rather than slowing every counted edit.
export const MAX_STATE_BYTES = 1_000_000;

/** The parsed file, or undefined when it is missing, unreadable, over `maxBytes` or not JSON. Never throws. */
export function readJson(root: string, rel: string, maxBytes = MAX_STATE_BYTES): unknown {
  try {
    if (statSync(join(root, rel)).size > maxBytes) return undefined;
    return JSON.parse(readFileSync(join(root, rel), 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeJson(root: string, rel: string, value: unknown): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeAtomic(join(root, rel), JSON.stringify(value, null, JSON_INDENT) + '\n');
}

export const RECORD = '.harness/state/pr-branches.json';
export interface PrRecord { base: string; lines: number; files: number; ts: string }

/** The recorded PR branches; anything unreadable or malformed is dropped. Null prototype, so `constructor` is never a branch. */
export function readRecords(root: string): Record<string, PrRecord> {
  const out: Record<string, PrRecord> = Object.create(null);
  const raw = readJson(root, RECORD);
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!plainBranch(k) || !isObj(v) || typeof v.base !== 'string' || typeof v.ts !== 'string') continue;
    if (Number.isInteger(v.lines) && Number.isInteger(v.files)) out[k] = { base: v.base, lines: v.lines as number, files: v.files as number, ts: v.ts };
  }
  return out;
}

export function writeRecord(root: string, branch: string, r: PrRecord): void {
  const all = readRecords(root);
  all[branch] = r;
  writeJson(root, RECORD, all);
}
