import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { payloadSha, readRecord, writeRecord, type ReviewRecord } from '../../src/review/record.js';

// A synthetic record, made up here.
const payload = { body: 'Suggested verdict: Comment', comments: [{ path: 'a.ts', line: 1, side: 'RIGHT' as const, body: '[nit] x' }] };
const rec = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({
  schema: 'harness-pr-review/1', repo: 'o/r', pr: 7, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), created: '2026-11-13T00:00:00.000Z',
  findings: [], omitted: [], verdict: 'Comment', payload, payload_sha256: payloadSha(payload), posted: null, history: [], ...o,
});

describe('record', () => {
  test('payload_sha256 is the sha256 of JSON.stringify(payload)', () => {
    expect(payloadSha(payload)).toBe(createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  });
  test('write then read', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
    writeRecord(root, rec());
    expect(readRecord(root, 7)).toEqual(rec());
    expect(JSON.parse(readFileSync(join(root, '.harness/state/review-hashes.json'), 'utf8'))).toHaveProperty('7');
  });
  test('Review Focus 5: a second finish keeps the earlier posted block in history', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
    const posted = { review_id: 42, at: '2026-11-13T01:00:00.000Z', mode: 'new' as const };
    writeRecord(root, rec({ posted }));
    writeRecord(root, rec());
    const r = readRecord(root, 7) as ReviewRecord;
    expect(r.posted).toBeNull();
    expect(r.history).toEqual([posted]);
    writeRecord(root, rec());
    expect((readRecord(root, 7) as ReviewRecord).history).toEqual([posted]);
  });
  test('a hand edit is refused; a missing record says so', () => {
    const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
    writeRecord(root, rec());
    const p = join(root, '.harness/reviews/7.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"Comment"', '"Approve"'));
    expect(readRecord(root, 7)).toEqual({ error: 'review: .harness/reviews/7.json changed since --finish; run harness review --finish again' });
    expect(readRecord(root, 8)).toEqual({ error: 'review: no review for PR #8; run the review first' });
  });
});
