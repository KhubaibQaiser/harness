// `@path` import expansion for CLAUDE.md-style files. Repo text is untrusted: depth, count and size are capped, and
// nothing outside the root (lexically or through a symlink) is ever read.
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as nodePath from 'node:path';

type PlatformPath = typeof nodePath;
import { defaultExec } from '../core/exec.js';
import { childEnv } from './count-api.js';
import { MAX_FILE_BYTES, fenceAfter, lf, stripComments } from './text.js';

export const MAX_HOPS = 4;
/** Files kept per expansion call. Claude Code has no such cap; hitting it is reported as a `cap` skip, never silent. */
export const MAX_IMPORTED = 100;
/** `@` tokens examined per expansion call (found, external, duplicate or missing alike), so a hostile file stays bounded. */
export const MAX_ATTEMPTS = 1000;
const LS_FILES_MS = 2000;
// `\ ` is an escaped space in a path (Claude Code docs). Trailing punctuation and #fragments are not stripped: its tokenizer isn't documented.
const IMPORT = /(?:^|\s)@((?:\\ |\S)+)/g;
const FOREIGN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/; // a Windows drive or UNC path, which no POSIX resolve() understands
const CODE_SPAN = /(`+)[^`]*?\1/g;

export interface RepoIO {
  read(abs: string): string | null;
  size(abs: string): number | null;
  lsFiles(root: string): string[] | null;
  /** Real path with symlinks resolved, or null. Required: an IO without it has every import treated as external. */
  real(abs: string): string | null;
  /** Entry names of a directory, or null when it is not one. */
  list(abs: string): string[] | null;
}

export const realIO: RepoIO = {
  read(abs) {
    try { return statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null; } catch { return null; }
  },
  size(abs) {
    try { const st = statSync(abs); return st.isFile() ? st.size : null; } catch { return null; }
  },
  lsFiles(root) {
    const r = defaultExec('git', ['-C', root, 'ls-files', '-z'], { timeoutMs: LS_FILES_MS, env: childEnv() });
    return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
  },
  real(abs) {
    try { return realpathSync(abs); } catch { return null; }
  },
  list(abs) {
    try { return readdirSync(abs); } catch { return null; }
  },
};

/** Separator-safe containment: `relative()` must not climb out or jump to another drive (an absolute result). `p` is injectable so win32 rules are testable anywhere. */
export const insideWith = (p: Pick<PlatformPath, 'relative' | 'isAbsolute' | 'sep'>, root: string, abs: string): boolean => {
  const rel = p.relative(root, abs);
  return rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
};
export const inside = (root: string, abs: string): boolean => insideWith(nodePath, root, abs);

/** Repo-relative paths are POSIX everywhere (manifest, `seen`, skip rules, output). */
export const relPosix = (p: Pick<PlatformPath, 'relative' | 'sep'>, root: string, abs: string): string => p.relative(root, abs).split(p.sep).join('/');

export interface Imported { path: string; text: string; by: string }

function importsIn(text: string): string[] {
  const found: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const inFence = fence !== null;
    fence = fenceAfter(line, fence);
    if (inFence || fence !== null) continue;
    for (const m of line.replace(CODE_SPAN, ' ').matchAll(IMPORT)) found.push(m[1].replace(/\\ /g, ' '));
  }
  return found;
}

export type SkipReason = 'oversize' | 'binary' | 'unreadable' | 'cap' | 'ignored';
export interface Skipped { path: string; by: string; reason: SkipReason }
type Loaded = { text: string } | { reason: SkipReason | 'missing' };

/** Sized before it is read; LF endings, comments kept. */
export function loadRaw(abs: string, io: RepoIO): Loaded {
  const size = io.size(abs);
  if (size === null) return { reason: 'missing' }; // Claude Code loads nothing for it either
  if (size > MAX_FILE_BYTES) return { reason: 'oversize' };
  const text = io.read(abs);
  if (text === null) return { reason: 'unreadable' };
  return text.includes('\0') ? { reason: 'binary' } : { text: lf(text) };
}

function load(abs: string, io: RepoIO): Loaded {
  const got = loadRaw(abs, io);
  return 'text' in got ? { text: stripComments(got.text) } : got;
}

/** The absolute path of an import inside the repo, or null when it is external or can't be verified (fail closed). */
function resolveInside(root: string, realRoot: string, fromDir: string, raw: string, io: RepoIO): string | null {
  if (raw.startsWith('~') || (FOREIGN_ABS.test(raw) && !isAbsolute(raw))) return null;
  const abs = resolve(root, fromDir, raw);
  if (!inside(root, abs) || typeof io.real !== 'function') return null;
  const real = io.real(abs);
  if (real === null) return io.size(abs) === null ? abs : null; // missing is not external; an unresolvable existing file is
  return inside(realRoot, real) ? abs : null;
}

interface Hop { path: string; text: string; hop: number }

export function expandImports(root: string, start: { path: string; text: string }, io: RepoIO, seen: Set<string>, skip: (rel: string) => boolean): { files: Imported[]; external: string[]; skipped: Skipped[] } {
  const files: Imported[] = [];
  const skipped: Skipped[] = [];
  const external = new Set<string>();
  const realRoot = (typeof io.real === 'function' ? io.real(root) : null) ?? root;
  const queue: Hop[] = [{ ...start, hop: 0 }];
  let attempts = 0;
  let capped = false;
  seen.add(start.path);
  // A file reached under two names (a symlink) is one file: `seen` holds names, this holds what they resolve to.
  const realOf = (rel: string): string | null => (typeof io.real === 'function' ? io.real(resolve(root, rel)) : null);
  const seenReal = new Set([...seen].map(realOf).filter((r): r is string => r !== null));
  for (let cur = queue.shift(); cur && !capped; cur = queue.shift()) {
    if (cur.hop >= MAX_HOPS) continue;
    for (const raw of importsIn(cur.text)) {
      const abs = resolveInside(root, realRoot, dirname(cur.path), raw, io);
      const rel = abs === null ? '' : relPosix(nodePath, root, abs);
      if (abs !== null && seen.has(rel)) continue;
      if (++attempts > MAX_ATTEMPTS) { skipped.push({ path: rel || raw, by: cur.path, reason: 'cap' }); capped = true; break; }
      if (abs === null) { external.add(raw); continue; }
      seen.add(rel);
      const real = realOf(rel);
      if (real !== null && seenReal.has(real)) continue;
      if (real !== null) seenReal.add(real);
      if (skip(rel)) { skipped.push({ path: rel, by: cur.path, reason: 'ignored' }); continue; }
      const got = load(abs, io);
      if (!('text' in got)) { if (got.reason !== 'missing') skipped.push({ path: rel, by: cur.path, reason: got.reason }); continue; }
      if (files.length >= MAX_IMPORTED) { skipped.push({ path: rel, by: cur.path, reason: 'cap' }); capped = true; break; }
      files.push({ path: rel, text: got.text, by: cur.path });
      queue.push({ path: rel, text: got.text, hop: cur.hop + 1 });
    }
  }
  return { files, external: [...external], skipped };
}
