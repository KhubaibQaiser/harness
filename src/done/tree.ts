// The working-tree hash (spec §4.2): what a ledger row or verdict is stamped with. Built over a throwaway copy of the
// index, so the real index is never written, and over the whole tree minus harness's own writes.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAFE_GIT } from '../core/git-safe.js';
import { HARNESS_LOCAL } from '../core/paths.js';

export const TREE_EXCLUDES = [...HARNESS_LOCAL.map((p) => p.replace(/\/$/, '')), '.harness/tmp', '.harness/verdicts'];

export function treeHash(root: string, o: { timeoutMs?: number } = {}): string {
  const timeout = o.timeoutMs ?? 5000;
  // An agent-set GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_CONFIG_* must not redirect the hash.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  const git = (args: string[], env: NodeJS.ProcessEnv): string => {
    const r = spawnSync('git', [...SAFE_GIT, ...args], { cwd: root, env, timeout, encoding: 'utf8', windowsHide: true });
    const what = `git ${args[0]}`;
    if (r.error) throw new Error(`tree hash: ${what} failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tree hash: ${what} exited ${r.status}: ${String(r.stderr).trim()}`);
    return String(r.stdout).trim();
  };
  const real = resolve(root, git(['rev-parse', '--git-path', 'index'], base));
  const tmp = mkdtempSync(join(tmpdir(), 'harness-tree-'));
  try {
    const index = join(tmp, 'index');
    if (existsSync(real)) copyFileSync(real, index); // an unborn repo has no index yet
    const env = { ...base, GIT_INDEX_FILE: index };
    git(['add', '-A', '--', '.', ...TREE_EXCLUDES.map((p) => `:(top,exclude)${p}`)], env);
    const hash = git(['write-tree'], env);
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error(`tree hash: write-tree printed ${JSON.stringify(hash)}`);
    return hash;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
