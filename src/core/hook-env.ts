import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.js';

export interface HookEnv { ts: string; node: string; execPath: string; platform: string }
export const HOOK_ENV_REL = '.harness/state/hook-env.json';

/** Records the Node that runs the hooks, for doctor and status. */
export function writeHookEnv(root: string, now: Date = new Date()): void {
  const p = join(root, HOOK_ENV_REL);
  mkdirSync(dirname(p), { recursive: true });
  const env: HookEnv = { ts: now.toISOString(), node: process.version, execPath: process.execPath, platform: process.platform };
  writeAtomic(p, JSON.stringify(env));
}

export function readHookEnv(root: string): HookEnv | null {
  try {
    const v = JSON.parse(readFileSync(join(root, HOOK_ENV_REL), 'utf8')) as HookEnv;
    return v && typeof v === 'object' && typeof v.node === 'string' ? v : null;
  } catch {
    return null;
  }
}
