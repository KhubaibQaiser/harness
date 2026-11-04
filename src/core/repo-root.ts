import { execFileSync } from 'node:child_process';

const cache = new Map<string, string>();

/** The git top level of `cwd`, or null when it is not in a repo. */
export function gitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
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
