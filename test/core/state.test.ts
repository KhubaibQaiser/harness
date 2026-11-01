import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { clearTurn, isSafeSessionId, readState, writeState } from '../../src/core/state.js';

const stateTs = join(process.cwd(), 'src/core/state.ts');
const root = mkdtempSync(join(tmpdir(), 'h-st-'));

function runChildWrite(r: string, session: string, i: number): Promise<void> {
  const code = `import { readState, writeState } from ${JSON.stringify(stateTs)};
const s = readState(${JSON.stringify(r)}, ${JSON.stringify(session)});
s.files = Array.from({ length: 2000 }, (_, k) => 'f' + ${i} + '-' + k);
writeState(${JSON.stringify(r)}, ${JSON.stringify(session)}, s);`;
  return new Promise((res, rej) =>
    execFile(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], (err, _o, se) =>
      err ? rej(new Error(se)) : res(),
    ),
  );
}

test('missing state is fresh, not persisted until written', () => {
  const r = mkdtempSync(join(tmpdir(), 'h-st-'));
  const s = readState(r, 'x');
  expect(s).toMatchObject({ files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 });
  expect(Math.abs(s.startedAt - Date.now())).toBeLessThan(5000);
  expect(existsSync(join(r, '.harness/state/x.json'))).toBe(false);
  writeState(r, 'x', s);
  expect(readState(r, 'x').startedAt).toBe(s.startedAt);
});

test('clearTurn resets the per-turn fields (files, approved, stopAttempts) and keeps redTests', () => {
  const r = mkdtempSync(join(tmpdir(), 'h-st-'));
  const s = readState(r, 'x');
  writeState(r, 'x', { ...s, files: ['a'], approved: true, redTests: ['t'], stopAttempts: 2 });
  clearTurn(r, 'x');
  expect(readState(r, 'x')).toMatchObject({ files: [], approved: false, redTests: ['t'], stopAttempts: 0 });
});

test('concurrent writeState never leaves partial JSON', async () => {
  await Promise.all(Array.from({ length: 50 }, (_, i) => runChildWrite(root, 's', i)));
  expect(() => readState(root, 's')).not.toThrow();
  expect(readState(root, 's').files).toHaveLength(2000);
  expect(readdirSync(join(root, '.harness/state')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
}, 60000);

test('corrupt or non-object state file yields fresh state', () => {
  const r = mkdtempSync(join(tmpdir(), 'h-st-'));
  mkdirSync(join(r, '.harness/state'), { recursive: true });
  for (const body of ['{oops', '[1]', '7', 'null']) {
    writeFileSync(join(r, '.harness/state/x.json'), body);
    expect(readState(r, 'x')).toMatchObject({ files: [], approved: false, stopAttempts: 0 });
  }
});

test('isSafeSessionId rejects traversal and odd characters', () => {
  for (const id of ['', '.', '..', 'a/b', 'a b', '../x']) expect(isSafeSessionId(id)).toBe(false);
  for (const id of ['abc-1_2.3', '.hidden', '...']) expect(isSafeSessionId(id)).toBe(true);
});
