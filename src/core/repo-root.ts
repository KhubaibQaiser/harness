import { execFileSync } from 'node:child_process';
import { childEnv } from '../budget/count-api.js';
import { SAFE_GIT } from './git-safe.js';

const cache = new Map<string, string>();

/** The git top level of `cwd`, or null when it is not in a repo. */
export function gitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', [...SAFE_GIT, 'rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 2000, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  let r = cache.get(cwd);
  if (r === undefined) {
    r = gitRoot(cwd) ?? cwd;
    cache.set(cwd, r);
  }
  return r;
}
