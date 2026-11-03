import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { HOOK_ENV_REL, readHookEnv, writeHookEnv } from '../../src/core/hook-env.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'h-env-'));

test('writeHookEnv records the running node and readHookEnv reads it back', () => {
  const r = tmp();
  const now = new Date('2026-11-03T10:00:00Z');
  writeHookEnv(r, now);
  expect(readHookEnv(r)).toEqual({ ts: now.toISOString(), node: process.version, execPath: process.execPath, platform: process.platform });
});
test('readHookEnv returns null for a missing file and for non-JSON', () => {
  const r = tmp();
  expect(readHookEnv(r)).toBeNull();
  mkdirSync(join(r, '.harness/state'), { recursive: true });
  writeFileSync(join(r, HOOK_ENV_REL), 'nope{');
  expect(readHookEnv(r)).toBeNull();
  writeFileSync(join(r, HOOK_ENV_REL), '{"node":"v1"}');
  expect(readHookEnv(r)).toBeNull();
});
