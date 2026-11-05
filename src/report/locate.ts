import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isSafeSessionId } from '../core/state.js';

export type GitRun = (args: string[]) => { status: number | null; stdout: string };
export interface SessionFile { session: string; main: string; subagents: string[]; mtimeMs: number }
export type SkipReason = 'outside-repo' | 'unsafe-id' | 'symlink' | 'older-than-window' | 'no-cwd' | 'unreadable';
export interface Located { projectsDir: string; sessions: SessionFile[]; skipped: Partial<Record<SkipReason, number>> }

const MAX_LINES = 64;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000; // bounds every directory listing

// ponytail: UNVERIFIED (spec 3.1) that CLAUDE_CONFIG_DIR is the variable name; verify when a real run is allowed.
export const projectsDir = (env: NodeJS.ProcessEnv, home: string): string =>
  env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects');

// ponytail: UNVERIFIED (spec 3.1) folder-name rule; it only picks candidates, the cwd check decides.
export const encodeProjectDir = (p: string): string => p.replace(/[^A-Za-z0-9]/g, '-');

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

export function repoPaths(root: string, git: GitRun): string[] {
  const out = new Set<string>();
  const add = (p: string): void => { out.add(p); out.add(real(p)); };
  add(root);
  const r = git(['worktree', 'list', '--porcelain']);
  if (r.status === 0) for (const l of r.stdout.split('\n')) if (l.startsWith('worktree ')) add(l.slice(9).trim());
  return [...out];
}

// ponytail: darwin and win32 are treated as case-insensitive (default volumes); a case-sensitive APFS volume would over-match.
const fold = (p: string, platform: NodeJS.Platform): string => {
  const r = resolve(p);
  return platform === 'darwin' || platform === 'win32' ? r.toLowerCase() : r;
};

export function insideRepo(cwd: string, paths: string[], platform: NodeJS.Platform): boolean {
  const c = fold(cwd, platform);
  return paths.some((p) => {
    const r = fold(p, platform);
    return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Bounded listing; a missing dir is empty, any other failure is counted via `onFail`. */
function ls(dir: string, onFail: () => void): string[] {
  try { return readdirSync(dir).slice(0, MAX_ENTRIES); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onFail();
    return [];
  }
}

/** First string `cwd` in the first 64 lines / 1 MB; undefined when absent, null when unreadable. */
function firstCwd(file: string, open: typeof openSync): string | undefined | null {
  let fd: number | undefined;
  try {
    fd = open(file, 'r');
    const buf = Buffer.alloc(MAX_BYTES);
    const n = readSync(fd, buf, 0, MAX_BYTES, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, MAX_LINES)) {
      try {
        const c = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd;
        if (typeof c === 'string') return c;
      } catch { /* a partial or bad line */ }
    }
    return undefined;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function locateSessions(root: string, opts: { env: NodeJS.ProcessEnv; home: string; sinceMs: number; git: GitRun; platform?: NodeJS.Platform; open?: typeof openSync }): Promise<Located> {
  const platform = opts.platform ?? process.platform;
  const dir = projectsDir(opts.env, opts.home);
  const skipped: Located['skipped'] = {};
  const skip = (r: SkipReason): void => { skipped[r] = (skipped[r] ?? 0) + 1; };
  const paths = repoPaths(root, opts.git);
  const prefixes = paths.map((p) => fold(encodeProjectDir(p), platform));
  const sessions: SessionFile[] = [];
  for (const folder of ls(dir, () => skip('unreadable'))) {
    const f = fold(folder, platform);
    if (!prefixes.some((e) => f === e || f.startsWith(e + '-'))) continue;
    const fdir = join(dir, folder);
    try {
      const st = lstatSync(fdir);
      if (st.isSymbolicLink()) { skip('symlink'); continue; }
      if (!st.isDirectory()) continue;
    } catch { skip('unreadable'); continue; }
    for (const name of ls(fdir, () => skip('unreadable'))) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -6);
      if (!isSafeSessionId(id)) { skip('unsafe-id'); continue; }
      const main = join(fdir, name);
      let mtimeMs: number;
      try {
        const st = lstatSync(main);
        if (st.isSymbolicLink()) { skip('symlink'); continue; }
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
      } catch { skip('unreadable'); continue; }
      if (mtimeMs < opts.sinceMs) { skip('older-than-window'); continue; }
      const cwd = firstCwd(main, opts.open ?? openSync);
      if (cwd === null) { skip('unreadable'); continue; }
      if (cwd === undefined) { skip('no-cwd'); continue; }
      if (!insideRepo(cwd, paths, platform)) { skip('outside-repo'); continue; }
      sessions.push({ session: id, main, subagents: subagentFiles(join(fdir, id, 'subagents'), () => skip('unreadable')), mtimeMs });
    }
  }
  return { projectsDir: dir, sessions, skipped };
}

function subagentFiles(sdir: string, onFail: () => void): string[] {
  try { if (!lstatSync(sdir).isDirectory()) return []; } catch { return []; }
  return ls(sdir, onFail).filter((n) => /^agent-[A-Za-z0-9._-]+\.jsonl$/.test(n)).map((n) => join(sdir, n)).filter((p) => {
    try { return lstatSync(p).isFile(); } catch { return false; }
  });
}
