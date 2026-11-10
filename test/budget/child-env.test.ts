// Spec §4: the key is never passed to a child process. The only spawn in src/budget is git ls-files.
import { afterEach, expect, test, vi } from 'vitest';

const SENTINEL = 'sk-ant-TEST-SENTINEL-0000';
const calls: { cmd: string; env?: NodeJS.ProcessEnv }[] = [];
vi.mock('../../src/core/exec.js', () => ({
  defaultExec: (cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv } = {}) => (calls.push({ cmd, env: o.env }), { status: 0, stdout: 'a\0' }),
}));
const { realIO } = await import('../../src/budget/imports.js');
const { childEnv } = await import('../../src/budget/count-api.js');

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; calls.length = 0; });

test('git ls-files gets an env without ANTHROPIC_API_KEY, and the rest of the env', () => {
  process.env.ANTHROPIC_API_KEY = SENTINEL;
  expect(realIO.lsFiles('/r')).toEqual(['a']);
  expect(calls).toHaveLength(1);
  expect(calls[0].env).toBeDefined();
  expect(calls[0].env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(calls[0].env!.PATH).toBe(process.env.PATH);
  expect(process.env.ANTHROPIC_API_KEY).toBe(SENTINEL); // the parent keeps it
});

test('childEnv drops the key from any env it is given', () => {
  expect(childEnv({ ANTHROPIC_API_KEY: SENTINEL, A: '1' })).toEqual({ A: '1' });
});
