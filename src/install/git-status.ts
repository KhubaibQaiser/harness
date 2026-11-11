import { execFileSync } from 'node:child_process';
import { SAFE_GIT } from '../core/git-safe.js';

/** Paths git reports as modified, staged or untracked, relative to the repo root (untracked dirs end in "/"). */
export function dirtyPaths(root: string): string[] {
  const raw = execFileSync('git', [...SAFE_GIT, 'status', '--porcelain', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C' || e[1] === 'R' || e[1] === 'C') paths.push(raw[++i]);
  }
  return paths;
}
