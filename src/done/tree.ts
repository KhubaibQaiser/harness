// The working-tree hash (spec §4.2): what a ledger row or verdict is stamped with. Built over a throwaway index, so the real
// index is never read or written, and over the whole tree minus harness's own writes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE_GIT } from '../core/git-safe.js';
import { HARNESS_LOCAL } from '../core/paths.js';

export const TREE_EXCLUDES = [...HARNESS_LOCAL.map((p) => p.replace(/\/$/, '')), '.harness/tmp', '.harness/verdicts'];

const STOCK_LFS = { clean: 'git-lfs clean -- %f', process: 'git-lfs filter-process' };

/** [key, value] config overrides that stop every configured clean/process filter from running; stock git-lfs stays, or every LFS repo reads dirty. */
export function filterOffs(listing: string): [string, string][] {
  const filters = new Map<string, { clean?: string; process?: string }>();
  let lfsExtension = false; // lfs.extension.<n>.clean programs run inside git-lfs, so LFS is no longer stock
  for (const entry of listing.split('\0').filter(Boolean)) {
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    if (/^lfs\.extension\./i.test(key)) { lfsExtension = true; continue; }
    const m = /^filter\.(.+)\.([^.]+)$/.exec(key);
    if (!m) continue;
    const f = filters.get(m[1]!) ?? {};
    if (m[2] === 'clean' || m[2] === 'process') f[m[2]] = nl < 0 ? '' : entry.slice(nl + 1);
    filters.set(m[1]!, f);
  }
  const out: [string, string][] = [];
  for (const [n, f] of filters) {
    if (n === 'lfs' && !lfsExtension && (f.clean === undefined || f.clean === STOCK_LFS.clean) && (f.process === undefined || f.process === STOCK_LFS.process)) continue;
    out.push([`filter.${n}.clean`, ''], [`filter.${n}.process`, ''], [`filter.${n}.required`, 'false']);
  }
  return out;
}

/** Unborn means HEAD names a branch that doesn't exist in a repo with no refs at all (a fresh repo). A garbage ref or a detached HEAD at a missing object is an error, not an empty tree. */
type Run = (args: string[], env: NodeJS.ProcessEnv, ok?: number[]) => { status: number; stdout: string; stderr: string };
function unborn(run: Run, env: NodeJS.ProcessEnv): boolean {
  const sym = run(['symbolic-ref', '-q', 'HEAD'], env, [0, 1]); // 1: detached; a broken HEAD exits 128 and throws
  if (sym.status !== 0 || run(['show-ref', '--verify', '-q', sym.stdout.trim()], env, [0, 1]).status !== 1) return false;
  // On an orphan branch no HEAD supplies the tracked files, so .git/info/exclude could hide edits to them: fail closed.
  const refs = run(['for-each-ref', '--count=1'], env);
  // for-each-ref skips a broken ref with only a warning: a repo whose refs are all broken is not a fresh repo.
  if (refs.stderr.trim()) throw new Error(`tree hash: broken ref: ${refs.stderr.trim()}`);
  if (refs.stdout.trim()) throw new Error("the tree hash can't be computed on an orphan branch; commit first");
  return true;
}

// The temp index is seeded from HEAD (read-tree leaves stat data zeroed and sets no assume-unchanged or skip-worktree bit), so
// `add -A` still hashes every file from disk: a racy-clean entry, assume-unchanged, skip-worktree, core.ignoreStat and forged stat
// data in the real index (never read) can't hide an edit. HEAD supplies what disk can't: modes under core.fileMode=false, symlinks
// under core.symlinks=false, gitlinks of uninitialised submodules, tracked files that match an ignore rule.
// Config overrides go through GIT_CONFIG_* env, not -c, because -c splits a key at its first `=` (a filter named `x=y`).
// ponytail: ignore rules outside the tree (.git/info/exclude, core.excludesFile) still hide NEW untracked files, and git-lfs is
// found on PATH; both in Known limits. A new `git add -f` of an ignored file that isn't committed yet is not counted.
export function treeHash(root: string, o: { timeoutMs?: number } = {}): string {
  const deadline = Date.now() + (o.timeoutMs ?? 5000); // one budget for all git calls
  // An agent-set GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or GIT_CONFIG_* must not redirect the hash.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
  const run: Run = (args, env, ok = [0]) => {
    const left = deadline - Date.now();
    const what = `git ${args[0]}`;
    if (left <= 0) throw new Error(`tree hash: timed out before ${what}`);
    const r = spawnSync('git', [...SAFE_GIT, ...args], { cwd: root, env, timeout: left, encoding: 'utf8', windowsHide: true });
    if (r.error) throw new Error(`tree hash: ${what} failed: ${r.error.message}`);
    if (r.status === null || !ok.includes(r.status)) throw new Error(`tree hash: ${what} exited ${r.status}: ${String(r.stderr).trim()}`);
    return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
  };
  const tmp = mkdtempSync(join(tmpdir(), 'harness-tree-'));
  try {
    const lst = run(['config', '-z', '--get-regexp', '^(filter|lfs)\\.'], base, [0, 1]); // 1 = no such keys
    const pairs: [string, string][] = [['core.sparseCheckout', 'false'], ['core.ignoreStat', 'false'], ...filterOffs(lst.stdout)];
    const env: NodeJS.ProcessEnv = { ...base, GIT_INDEX_FILE: join(tmp, 'index'), GIT_CONFIG_COUNT: String(pairs.length) };
    pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
    if (run(['rev-parse', '--verify', '-q', 'HEAD'], env, [0, 1]).status === 0) run(['read-tree', 'HEAD'], env);
    else if (!unborn(run, env)) throw new Error('tree hash: HEAD does not resolve to a commit');
    // write-tree runs the filters too: it rewrites the index and re-hashes racily clean entries through the clean filter.
    // Add everything, then drop harness's folders from the temp index: an exclude pathspec naming a folder that .gitignore
    // ignores (init's own lines) makes `git add` exit 1 (ship audit M4). --cached: the working tree is never touched.
    run(['add', '-A', '--', ':/'], env);
    run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...TREE_EXCLUDES.map((p) => `:(top,literal)${p}`)], env);
    const hash = run(['write-tree'], env).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error(`tree hash: write-tree printed ${JSON.stringify(hash)}`);
    return hash;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a leftover temp folder is harmless; never mask the real error */ }
  }
}
