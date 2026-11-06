// Measures a PR as GitHub shows it: the three-dot diff from the merge base to the head, with spec §5's counting rules.
import { spawnSync } from 'node:child_process';
import { esc, type HarnessConfig } from '../../core/config.js';
import { matches } from '../../core/paths.js';
import { UNTRACKED, untrackedLines } from './untracked.js';

export { UNTRACKED };

export type Git = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; error?: NodeJS.ErrnoException };
// 64 MB: the default 1 MB buffer would fail a huge PR's numstat as ENOBUFS, and an unmeasured PR is allowed.
export const realGit = (root: string): Git => (args, timeout) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error as NodeJS.ErrnoException | undefined };
};

/** §4 trust boundary: a name from the agent's command text can never reach git as an option or a range. */
export const plainBranch = (n: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(n) && !n.includes('..');

export type SizeConfig = Pick<HarnessConfig, 'pr_size' | 'multi_file_gate' | 'stop'>;
export interface Size { base: string; head: string; lines: number; files: number; top: { path: string; lines: number }[]; excluded: string[] }
export interface Unmeasured { error: string; base?: string }

export const isOver = (s: Pick<Size, 'lines' | 'files'>, c: HarnessConfig['pr_size']): boolean => s.lines > c.max_lines || s.files > c.max_files;

export function currentBranch(git: Git): string | null {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 2000);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

class Stop {
  constructor(readonly error: string) {}
}

export function measure(root: string, want: { base?: string; head?: string; worktree?: boolean }, config: SizeConfig, opts: { git?: Git; now?: () => number; budgetMs?: number } = {}): Size | Unmeasured {
  for (const k of ['base', 'head'] as const) if (want[k] !== undefined && !(k === 'head' && want.worktree) && !plainBranch(want[k])) return { error: `\`--${k}\` is not a plain branch name` };
  const git = opts.git ?? realGit(root);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? 6000);
  const run = (args: string[]) => {
    const timeout = Math.min(2000, deadline - now());
    if (timeout <= 0) throw new Stop('git timed out');
    const r = git(args, timeout);
    if (r.error?.code === 'ENOENT') throw new Stop('git not found');
    if (r.error?.code === 'ETIMEDOUT') throw new Stop('git timed out');
    // Any other spawn failure (EACCES, ENOBUFS, a signal) is named, so it is never read as "ref not found".
    if (r.error || r.status === null) throw new Stop(`git failed (${esc(r.error?.code ?? 'killed')})`);
    return r;
  };
  const sha = (ref: string) => {
    const r = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  // Remote first (GitHub compares against it), then local only, then as written for a base_ref like upstream/develop (plan drift 9).
  const findBase = (n: string) => {
    for (const [ref, shown] of [[`refs/remotes/origin/${n}`, `origin/${n}`], [`refs/heads/${n}`, n], [n, n]]) {
      const s = sha(ref);
      if (s) return { sha: s, shown };
    }
    return null;
  };
  let base: { sha: string; shown: string } | null = null;
  try {
    if (want.base !== undefined) {
      base = findBase(want.base);
      if (!base) return { error: `base \`${esc(want.base)}\` not found; fetch it first` };
    } else {
      const r = run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
      const def = r.status === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
      if (def && plainBranch(def)) base = findBase(def);
      const ref = config.stop.base_ref;
      if (!base && plainBranch(ref)) base = findBase(ref);
      if (!base) return { error: def ? `no base: origin/HEAD (origin/${esc(def)}) and stop.base_ref (${esc(ref)}) were not found; fetch it first` : `no base: origin/HEAD is not set and stop.base_ref (${esc(ref)}) was not found; fetch it first` };
    }
    const b = base;
    const fail = (error: string): Unmeasured => ({ error, base: b.shown });
    const wt = want.worktree === true;
    const headName = wt ? 'working tree' : (want.head ?? 'HEAD');
    const headSha = want.head === undefined || wt ? sha('HEAD') : (sha(`refs/heads/${want.head}`) ?? sha(`refs/remotes/origin/${want.head}`));
    if (!headSha) return fail(`head \`${esc(headName)}\` not found`);

    let range = `${b.sha}...${headSha}`;
    if (wt) {
      const mb = run(['merge-base', b.sha, 'HEAD']);
      if (mb.status !== 0 || !mb.stdout.trim()) return fail('no merge base with HEAD');
      range = mb.stdout.trim();
    }
    const num = run(['-c', 'core.quotePath=false', 'diff', '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', range]);
    const del = run(['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', '--diff-filter=D', '--no-ext-diff', range]);
    if (num.status !== 0 || del.status !== 0) return fail('git diff failed');
    const others = wt ? run(['ls-files', '--others', '--exclude-standard', '-z']) : null;
    if (others && others.status !== 0) return fail('git ls-files failed');

    const dp = del.stdout.split('\0');
    const deleted = new Set(dp.filter((_, i) => i % 2 === 1));
    const skip = [...config.pr_size.exclude, ...config.multi_file_gate.generated];
    const top: Size['top'] = [];
    const excluded: string[] = [];
    const parts = num.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      const [added = '', removed = '', ...rest] = parts[i]!.split('\t');
      let path = rest.join('\t');
      if (path === '') { i += 2; path = parts[i] ?? ''; } // rename: `a\td\t\0old\0new`, judged by the new path
      if (!path) continue;
      if (matches(path, skip)) excluded.push(path);
      else top.push({ path, lines: added === '-' || deleted.has(path) ? 0 : Number(added) + Number(removed) });
    }
    if (others) {
      let read = 0;
      for (const path of others.stdout.split('\0')) {
        if (!path) continue;
        if (matches(path, skip)) { excluded.push(path); continue; }
        if (read < UNTRACKED.maxFiles && now() >= deadline) throw new Stop('git timed out');
        top.push({ path, lines: read++ < UNTRACKED.maxFiles ? untrackedLines(root, path) : 0 });
      }
    }
    top.sort((x, y) => y.lines - x.lines || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    return { base: b.shown, head: headName, lines: top.reduce((n, f) => n + f.lines, 0), files: top.length, top, excluded: excluded.sort() };
  } catch (e) {
    if (e instanceof Stop) return base ? { error: e.error, base: base.shown } : { error: e.error };
    throw e;
  }
}
