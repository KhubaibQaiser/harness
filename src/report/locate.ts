import { closeSync, constants, lstatSync, opendirSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isSafeSessionId } from '../core/state.js';

export type GitRun = (args: string[]) => { status: number | null; stdout: string };
export interface SessionFile { session: string; main: string; subagents: string[]; mtimeMs: number }
export type SkipReason = 'outside-repo' | 'unsafe-id' | 'symlink' | 'older-than-window' | 'no-cwd' | 'unreadable' | 'truncated';
export interface Located { projectsDir: string; sessions: SessionFile[]; skipped: Partial<Record<SkipReason, number>> }

const MAX_LINES = 64;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000; // bounds every directory listing
const buf = Buffer.alloc(MAX_BYTES); // reused: locateSessions is synchronous inside

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
  if (!isAbsolute(cwd)) return false; // fail closed: a relative cwd would resolve against the reporter's own cwd
  const c = fold(cwd, platform);
  return paths.some((p) => {
    const r = fold(p, platform);
    if (dirname(r) === r) return false; // a filesystem root as the repo would match every session
    return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Bounded listing: reads at most `max` entries. A missing dir is empty; other failures call `onFail`; hitting the cap calls `onCap`. */
function ls(dir: string, onFail: () => void, onCap: () => void, max: number): string[] {
  const out: string[] = [];
  let d;
  try {
    d = opendirSync(dir);
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (out.length >= max) { onCap(); break; }
      out.push(e.name);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') onFail();
  } finally {
    try { d?.closeSync(); } catch { /* already closed */ }
  }
  return out;
}

/** First string `cwd` in the first 64 lines / 1 MB; undefined when absent, null when unreadable. */
function firstCwd(file: string, open: typeof openSync): string | undefined | null {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW is undefined on Windows; there the lstat check before this call is the only guard.
    fd = open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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

export async function locateSessions(root: string, opts: { env: NodeJS.ProcessEnv; home: string; sinceMs: number; git: GitRun; platform?: NodeJS.Platform; open?: typeof openSync; maxEntries?: number }): Promise<Located> {
  const platform = opts.platform ?? process.platform;
  const dir = projectsDir(opts.env, opts.home);
  const skipped: Located['skipped'] = {};
  const skip = (r: SkipReason): void => { skipped[r] = (skipped[r] ?? 0) + 1; };
  const paths = repoPaths(root, opts.git);
  const prefixes = paths.map((p) => fold(encodeProjectDir(p), platform));
  const sessions: SessionFile[] = [];
  const max = opts.maxEntries ?? MAX_ENTRIES;
  const lsb = (d: string): string[] => ls(d, () => skip('unreadable'), () => skip('truncated'), max);
  for (const folder of lsb(dir)) {
    const f = fold(folder, platform);
    if (!prefixes.some((e) => f === e || f.startsWith(e + '-'))) continue;
    const fdir = join(dir, folder);
    try {
      const st = lstatSync(fdir);
      if (st.isSymbolicLink()) { skip('symlink'); continue; }
      if (!st.isDirectory()) continue;
    } catch { skip('unreadable'); continue; }
    for (const name of lsb(fdir)) {
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
      sessions.push({ session: id, main, subagents: subagentFiles(join(fdir, id), skip, lsb), mtimeMs });
    }
  }
  return { projectsDir: dir, sessions, skipped };
}

/** `<id>/subagents/agent-*.jsonl`; no component of the path may be a symlink. */
function subagentFiles(idDir: string, skip: (r: SkipReason) => void, lsb: (d: string) => string[]): string[] {
  const sdir = join(idDir, 'subagents');
  for (const d of [idDir, sdir]) {
    try {
      const st = lstatSync(d);
      if (st.isSymbolicLink()) { skip('symlink'); return []; }
      if (!st.isDirectory()) return [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') skip('unreadable');
      return [];
    }
  }
  const out: string[] = [];
  for (const n of lsb(sdir)) {
    if (!/^agent-[A-Za-z0-9._-]+\.jsonl$/.test(n)) continue;
    const p = join(sdir, n);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) skip('symlink');
      else if (st.isFile()) out.push(p);
    } catch { skip('unreadable'); }
  }
  return out;
}
