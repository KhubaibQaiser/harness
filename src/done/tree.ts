// The working-tree hash (spec §4.2): what a ledger row or verdict is stamped with. Built over a throwaway copy of the
// index, so the real index is never written, and over the whole tree minus harness's own writes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE_GIT } from '../core/git-safe.js';
import { HARNESS_LOCAL } from '../core/paths.js';

export const TREE_EXCLUDES = [...HARNESS_LOCAL.map((p) => p.replace(/\/$/, '')), '.harness/tmp', '.harness/verdicts'];

const STOCK_LFS = { clean: 'git-lfs clean -- %f', process: 'git-lfs filter-process' };

/** `-c` pairs that stop every configured clean/process filter from running; stock git-lfs stays, or every LFS repo reads dirty. */
function filterOffs(listing: string): string[] {
  const filters = new Map<string, { clean?: string; process?: string }>();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    const m = /^filter\.(.+)\.([^.]+)$/.exec(key);
    if (!m) continue;
    const f = filters.get(m[1]!) ?? {};
    if (m[2] === 'clean' || m[2] === 'process') f[m[2]] = nl < 0 ? '' : entry.slice(nl + 1);
    filters.set(m[1]!, f);
  }
  const out: string[] = [];
  for (const [n, f] of filters) {
    if (n === 'lfs' && (f.clean === undefined || f.clean === STOCK_LFS.clean) && (f.process === undefined || f.process === STOCK_LFS.process)) continue;
    out.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
  }
  return out;
}

// The index starts empty, so git has no stat cache to trust: every file is hashed from disk. That makes the result immune to a
// racy-clean entry, assume-unchanged, skip-worktree, core.ignoreStat and forged stat data in the real index, which is never read.
// ponytail: ignore rules outside the tree (.git/info/exclude, core.excludesFile) still hide untracked files; documented in Known limits.
export function treeHash(root: string, o: { timeoutMs?: number } = {}): string {
  const deadline = Date.now() + (o.timeoutMs ?? 5000); // one budget for all git calls
  // An agent-set GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_CONFIG_* must not redirect the hash.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  const git = (args: string[], env: NodeJS.ProcessEnv, pre: string[] = []): string => {
    const left = deadline - Date.now();
    const what = `git ${args[0]}`;
    if (left <= 0) throw new Error(`tree hash: timed out before ${what}`);
    const r = spawnSync('git', [...SAFE_GIT, ...pre, ...args], { cwd: root, env, timeout: left, encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error(`tree hash: ${what} failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tree hash: ${what} exited ${r.status}: ${String(r.stderr).trim()}`);
    return String(r.stdout);
  };
  const tmp = mkdtempSync(join(tmpdir(), 'harness-tree-'));
  try {
    // exit 1 = no filter lines; any other failure must not pass as "no filters"
    const lst = spawnSync('git', [...SAFE_GIT, 'config', '-z', '--get-regexp', '^filter\\.'], { cwd: root, env: base, timeout: Math.max(1, deadline - Date.now()), encoding: 'utf8', windowsHide: true });
    if (lst.error || (lst.status !== 0 && lst.status !== 1)) throw new Error(`tree hash: git config failed: ${lst.error?.message ?? String(lst.stderr).trim()}`);
    const env = { ...base, GIT_INDEX_FILE: join(tmp, 'index') };
    // write-tree too: it rewrites the index and re-hashes racily clean entries through the clean filter.
    const pre = ['-c', 'core.sparseCheckout=false', ...filterOffs(String(lst.stdout))];
    git(['add', '-A', '--', ':/', ...TREE_EXCLUDES.map((p) => `:(top,exclude)${p}`)], env, pre);
    const hash = git(['write-tree'], env, pre).trim();
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error(`tree hash: write-tree printed ${JSON.stringify(hash)}`);
    return hash;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a leftover temp folder is harmless; never mask the real error */ }
  }
}
