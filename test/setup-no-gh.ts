import { vi } from 'vitest';

// Unit tests never reach GitHub: a spawn of the real `gh` throws. Doctor tests inject a fake `gh` instead.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: ((cmd: string, ...rest: unknown[]) => {
    if (cmd === 'gh') throw new Error('the test spawned the real gh; pass a fake gh to doctor');
    return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.spawnSync };
});
