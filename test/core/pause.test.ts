import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { isPaused, pauseStatus } from '../../src/core/pause.js';

const root = mkdtempSync(join(tmpdir(), 'h-pause-'));
mkdirSync(join(root, '.harness/state'), { recursive: true });
const put = (s: string) => writeFileSync(join(root, '.harness/state/tdd-pause.json'), s);

test('missing and malformed files are off', () => {
  expect(pauseStatus(root)).toBe('off');
  for (const s of ['{nope', '[]', '{"session":"s"}', 'null']) {
    put(s);
    expect(pauseStatus(root)).toBe('off');
    expect(isPaused(root, 's')).toBe(false);
  }
});

test('pending without a session, bound with one', () => {
  put('{"createdAt":"2026-01-01T00:00:00.000Z"}');
  expect(pauseStatus(root)).toBe('pending');
  expect(isPaused(root, 's')).toBe(false);
  put('{"createdAt":"2026-01-01T00:00:00.000Z","session":"s"}');
  expect(pauseStatus(root)).toEqual({ session: 's' });
  expect(isPaused(root, 's')).toBe(true);
  expect(isPaused(root, 't')).toBe(false);
});
