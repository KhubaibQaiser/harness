import { execFileSync } from 'node:child_process';

const cache = new Map<string, string>();

export function repoRoot(cwd: string): string {
  let r = cache.get(cwd);
  if (r === undefined) {
    try {
      r = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
    } catch {
      r = cwd;
    }
    cache.set(cwd, r);
  }
  return r;
}
