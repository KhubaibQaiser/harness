import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { readStopRecord, STOP_SANDBOX_REL, writeStopRecord } from '../../../src/checks/stop/record.js';

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  return root;
};
const good = { ts: '2026-11-15T00:00:00.000Z', srt: '0.0.83', outcome: 'ran', checks: { 'write canary': 'ok', network: 'ok' } } as const;

test('the record per check after a passing run', () => {
  const root = mk();
  writeStopRecord(root, good);
  expect(readStopRecord(root)).toEqual(good);
});

test('the record is unreadable or corrupt, so read returns null', () => {
  const root = mk();
  const f = join(root, STOP_SANDBOX_REL);
  expect(readStopRecord(root)).toBeNull(); // missing
  for (const text of ['{', JSON.stringify({ ...good, ts: 1 }), JSON.stringify({ srt: null, outcome: 'ran', checks: {} }), '[]', 'null', JSON.stringify({ ...good, outcome: 'passed' }), JSON.stringify({ ...good, srt: 1 }), JSON.stringify({ ...good, checks: { network: 3 } }), JSON.stringify({ ...good, checks: { bogus: 'ok' } }), JSON.stringify({ ...good, reason: 5 }), JSON.stringify({ ...good, reason: 'x'.repeat(70000) })]) {
    writeFileSync(f, text);
    expect(readStopRecord(root), text.slice(0, 40)).toBeNull();
  }
});

test.skipIf(process.platform === 'win32')('a symlinked state folder is never written through', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'h-rec-x-'));
  mkdirSync(join(root, '.harness'));
  symlinkSync(elsewhere, join(root, '.harness/state'));
  writeStopRecord(root, good);
  expect(() => readFileSync(join(elsewhere, 'stop-sandbox.json'))).toThrow();
});

test('a write that fails never throws', () => {
  const root = mk();
  mkdirSync(join(root, STOP_SANDBOX_REL)); // a directory where the file goes
  expect(() => writeStopRecord(root, good)).not.toThrow();
  const file = mkdtempSync(join(tmpdir(), 'h-rec-f-'));
  writeFileSync(join(file, '.harness'), 'a file, not a folder');
  expect(() => writeStopRecord(file, good)).not.toThrow();
});

test.skipIf(process.platform === 'win32')('a state folder reached through a symlinked .harness is never written through', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-rec-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'h-rec-x-'));
  mkdirSync(join(elsewhere, 'state'));
  symlinkSync(elsewhere, join(root, '.harness'));
  writeStopRecord(root, good);
  expect(() => readFileSync(join(elsewhere, 'state/stop-sandbox.json'))).toThrow();
});

test('a written record always reads back: oversize values are capped', () => {
  const root = mk();
  writeStopRecord(root, { ...good, checks: { network: 'x'.repeat(100000) }, reason: 'y'.repeat(100000) });
  const r = readStopRecord(root);
  expect(r?.checks.network).toHaveLength(200);
  expect(r?.reason).toHaveLength(500);
});
