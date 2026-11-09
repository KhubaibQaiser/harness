// Spec §4: the key never reaches a child process. Every CLI run (harness context among them) spawns git rev-parse here.
import { afterEach, expect, test, vi } from 'vitest';

const SENTINEL = 'sk-ant-TEST-SENTINEL-0000';
const calls: { env?: NodeJS.ProcessEnv }[] = [];
vi.mock('node:child_process', () => ({ execFileSync: (_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => (calls.push({ env: o.env }), '/r\n') }));
const { gitRoot } = await import('../../src/core/repo-root.js');

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; calls.length = 0; });

test('git rev-parse gets the env without ANTHROPIC_API_KEY', () => {
  process.env.ANTHROPIC_API_KEY = SENTINEL;
  expect(gitRoot('/r')).toBe('/r');
  expect(calls[0].env).toBeDefined();
  expect(calls[0].env).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(calls[0].env!.PATH).toBe(process.env.PATH);
});
