import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { appendEvent, readEvents } from '../../src/core/events.js';

test('appendEvent creates dirs; readEvents returns events and skips malformed lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-ev-'));
  expect(readEvents(root)).toEqual([]);
  const e = { ts: 't1', session: 's', check: 'guard', decision: 'deny', reason: 'r', files: ['a'] };
  appendEvent(root, e);
  appendFileSync(join(root, '.harness/logs/events.jsonl'), 'not json\n');
  appendEvent(root, { ...e, ts: 't2' });
  expect(readEvents(root).map((x) => x.ts)).toEqual(['t1', 't2']);
});
