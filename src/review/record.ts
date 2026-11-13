import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrFinding } from '../ai/pr-review.js';
import { writeAtomic } from '../core/atomic.js';

export interface Payload { body: string; comments: { path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }[] }
export interface Posted { review_id: number; at: string; mode: 'new' | 'add' | 'discard' }
export type RecordFinding = PrFinding & { placement: 'inline' | 'summary' | 'dropped'; dropped_reason?: string; judge_why?: string };
/** `.harness/reviews/<pr>.json` (spec §7.5): what --finish decided, and the exact payload --publish would send. */
export interface ReviewRecord {
  schema: 'harness-pr-review/1'; repo: string; pr: number; base_sha: string; head_sha: string; created: string;
  findings: RecordFinding[]; omitted: { path: string; why: string }[]; verdict: 'Request changes' | 'Comment';
  payload: Payload; payload_sha256: string; posted: Posted | null; history: Posted[];
}

const HASHES = '.harness/state/review-hashes.json';
const rel = (pr: number) => `.harness/reviews/${pr}.json`;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const payloadSha = (p: Payload): string => sha256(JSON.stringify(p));

function hashes(root: string): Record<string, string> {
  const p = join(root, ...HASHES.split('/'));
  if (!existsSync(p)) return {};
  const v = JSON.parse(readFileSync(p, 'utf8')) as unknown; // corrupt state throws: never reset it silently
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`review: ${HASHES} is not a mapping`);
  return v as Record<string, string>;
}

/** Reads the record --finish wrote; a byte changed since then (a hand edit, or anything but harness) is refused. */
export function readRecord(root: string, pr: number): ReviewRecord | { error: string } {
  const p = join(root, ...rel(pr).split('/'));
  if (!existsSync(p)) return { error: `review: no review for PR #${pr}; run the review first` };
  const bytes = readFileSync(p);
  if (hashes(root)[String(pr)] !== sha256(bytes)) return { error: `review: ${rel(pr)} changed since --finish; run harness review --finish again` };
  return JSON.parse(bytes.toString('utf8')) as ReviewRecord;
}

/** Writes the record atomically and its hash in protected state. An earlier record's `posted` moves to `history` (Review Focus 5). */
export function writeRecord(root: string, rec: ReviewRecord): void {
  const old = readRecord(root, rec.pr);
  // A changed earlier record is untrusted, so its history is not carried over (readRecord's message says to finish again).
  if (!('error' in old)) rec = { ...rec, history: [...old.history, ...(old.posted ? [old.posted] : [])] };
  const text = JSON.stringify(rec, null, 2) + '\n';
  mkdirSync(join(root, '.harness', 'reviews'), { recursive: true });
  writeAtomic(join(root, ...rel(rec.pr).split('/')), text);
  const h = hashes(root);
  h[String(rec.pr)] = sha256(text);
  mkdirSync(join(root, '.harness', 'state'), { recursive: true });
  writeAtomic(join(root, ...HASHES.split('/')), JSON.stringify(h, null, 2) + '\n');
}
