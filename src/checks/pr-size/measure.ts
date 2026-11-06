// Measures a PR as GitHub shows it: the three-dot diff from the merge base to the head, with spec §5's counting rules.
import { spawnSync } from 'node:child_process';
import { esc, type HarnessConfig } from '../../core/config.js';
import { matches } from '../../core/paths.js';
import { addUntracked, UNTRACKED } from './untracked.js';

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

// One budget per hook (measure's own default is the same 6 s), and never past 9 s from the hook's start, so the whole hook
// (the guard's npm lookup runs first) stays inside the 10 s hook timeout with a margin.
const BUDGET_MS = 6000;
const HOOK_BUDGET_MS = 9000;
export const hookBudgetMs = (startedAt: number | undefined, now: () => number): number => Math.min(BUDGET_MS, (startedAt ?? now()) + HOOK_BUDGET_MS - now());

export function currentBranch(git: Git): string | null {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 2000);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

class Stop {
  constructor(readonly error: string) {}
}

type Run = (args: string[]) => ReturnType<Git>;
type Base = { sha: string; shown: string };
type WantRef = { base?: string; head?: string; worktree?: boolean };
const GIT_CALL_MS = 2000;
const TOTAL_MS = 6000;

function makeRun(git: Git, now: () => number, deadline: number): Run {
  return (args) => {
    const timeout = Math.min(GIT_CALL_MS, deadline - now());
    if (timeout <= 0) throw new Stop('git timed out');
    const r = git(args, timeout);
    if (r.error?.code === 'ENOENT') throw new Stop('git not found');
    if (r.error?.code === 'ETIMEDOUT') throw new Stop('git timed out');
    // Any other spawn failure (EACCES, ENOBUFS, a signal) is named, so it is never read as "ref not found".
    if (r.error || r.status === null) throw new Stop(`git failed (${esc(r.error?.code ?? 'killed')})`);
    return r;
  };
}

const sha = (run: Run, ref: string) => {
  const r = run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
};

// Remote first (GitHub compares against it), then local only, then as written for a base_ref like upstream/develop (plan drift 9).
function findBase(run: Run, n: string): Base | null {
  for (const [ref, shown] of [[`refs/remotes/origin/${n}`, `origin/${n}`], [`refs/heads/${n}`, n], [n, n]]) {
    const s = sha(run, ref!);
    if (s) return { sha: s, shown: shown! };
  }
  return null;
}

function resolveBase(run: Run, want: WantRef, config: SizeConfig): Base | string {
  if (want.base !== undefined) return findBase(run, want.base) ?? `base \`${esc(want.base)}\` not found; fetch it first`;
  const r = run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const def = r.status === 0 ? r.stdout.trim().replace(/^origin\//, '') : '';
  const ref = config.stop.base_ref;
  const found = (def && plainBranch(def) ? findBase(run, def) : null) ?? (plainBranch(ref) ? findBase(run, ref) : null);
  if (found) return found;
  return def ? `no base: origin/HEAD (origin/${esc(def)}) and stop.base_ref (${esc(ref)}) were not found; fetch it first` : `no base: origin/HEAD is not set and stop.base_ref (${esc(ref)}) was not found; fetch it first`;
}

/** The diff target and the head's display name; a string is an error. */
function resolveRange(run: Run, want: WantRef, base: Base): { range: string; headName: string } | string {
  if (want.worktree) {
    if (!sha(run, 'HEAD')) return 'head `HEAD` not found';
    const mb = run(['merge-base', base.sha, 'HEAD']);
    return mb.status === 0 && mb.stdout.trim() ? { range: mb.stdout.trim(), headName: 'working tree' } : 'no merge base with HEAD';
  }
  const headName = want.head ?? 'HEAD';
  const headSha = want.head === undefined ? sha(run, 'HEAD') : (sha(run, `refs/heads/${want.head}`) ?? sha(run, `refs/remotes/origin/${want.head}`));
  return headSha ? { range: `${base.sha}...${headSha}`, headName } : `head \`${esc(headName)}\` not found`;
}

/** Parses the two -z diff outputs into counted and excluded paths. */
function countDiff(numstat: string, nameStatus: string, skip: string[]): Pick<Size, 'top' | 'excluded'> {
  const deleted = new Set(nameStatus.split('\0').filter((_, i) => i % 2 === 1));
  const top: Size['top'] = [];
  const excluded: string[] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const [added = '', removed = '', ...rest] = parts[i]!.split('\t');
    let path = rest.join('\t');
    if (path === '') { i += 2; path = parts[i] ?? ''; } // rename: `a\td\t\0old\0new`, judged by the new path
    if (!path) continue;
    if (matches(path, skip)) excluded.push(path);
    else top.push({ path, lines: added === '-' || deleted.has(path) ? 0 : Number(added) + Number(removed) });
  }
  return { top, excluded };
}

const byLinesThenPath = (x: Size['top'][number], y: Size['top'][number]) => y.lines - x.lines || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/** A worktree measurement ignores `head`, so a head name is not validated there. */
function badName(want: WantRef): string | null {
  for (const k of want.worktree ? (['base'] as const) : (['base', 'head'] as const)) if (want[k] !== undefined && !plainBranch(want[k])) return `\`--${k}\` is not a plain branch name`;
  return null;
}

/** The raw -z outputs (`others` is null outside a worktree measurement); a string is an error. */
function fetchDiff(run: Run, range: string, worktree: boolean): { num: string; del: string; others: string | null } | string {
  const q = ['-c', 'core.quotePath=false', 'diff'];
  const num = run([...q, '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', range]);
  const del = run([...q, '--name-status', '-z', '--diff-filter=D', '--no-ext-diff', range]);
  if (num.status !== 0 || del.status !== 0) return 'git diff failed';
  const others = worktree ? run(['ls-files', '--others', '--exclude-standard', '-z']) : null;
  if (others && others.status !== 0) return 'git ls-files failed';
  return { num: num.stdout, del: del.stdout, others: others ? others.stdout : null };
}

export function measure(root: string, want: WantRef, config: SizeConfig, opts: { git?: Git; now?: () => number; budgetMs?: number } = {}): Size | Unmeasured {
  const bad = badName(want);
  if (bad) return { error: bad };
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? TOTAL_MS);
  const run = makeRun(opts.git ?? realGit(root), now, deadline);
  let shown: string | undefined;
  try {
    const b = resolveBase(run, want, config);
    if (typeof b === 'string') return { error: b };
    shown = b.shown;
    const fail = (error: string): Unmeasured => ({ error, base: b.shown });
    const target = resolveRange(run, want, b);
    if (typeof target === 'string') return fail(target);
    const raw = fetchDiff(run, target.range, want.worktree === true);
    if (typeof raw === 'string') return fail(raw);
    const skip = [...config.pr_size.exclude, ...config.multi_file_gate.generated];
    const { top, excluded } = countDiff(raw.num, raw.del, skip);
    if (raw.others !== null && !addUntracked(root, raw.others, { skip, top, excluded }, () => now() >= deadline)) throw new Stop('git timed out');
    top.sort(byLinesThenPath);
    return { base: b.shown, head: target.headName, lines: top.reduce((n, f) => n + f.lines, 0), files: top.length, top, excluded: excluded.sort() };
  } catch (e) {
    if (e instanceof Stop) return shown ? { error: e.error, base: shown } : { error: e.error };
    throw e;
  }
}
