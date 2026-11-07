// `@path` import expansion for CLAUDE.md-style files. Repo text is untrusted: depth, count and size are capped, and
// nothing outside the root (lexically or through a symlink) is ever read.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { defaultExec } from '../core/exec.js';
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
}

export const realIO: RepoIO = {
  read(abs) {
    try { return statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null; } catch { return null; }
  },
  size(abs) {
    try { const st = statSync(abs); return st.isFile() ? st.size : null; } catch { return null; }
  },
  lsFiles(root) {
    const r = defaultExec('git', ['-C', root, 'ls-files', '-z'], { timeoutMs: LS_FILES_MS });
    return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
  },
  real(abs) {
    try { return realpathSync(abs); } catch { return null; }
  },
};

export const inside = (root: string, abs: string): boolean => {
  const rel = relative(root, abs);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export interface Imported { path: string; text: string; by: string }

const toPosix = (p: string): string => p.split(sep).join('/');

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

function load(abs: string, io: RepoIO): Loaded {
  const size = io.size(abs);
  if (size === null) return { reason: 'missing' }; // Claude Code loads nothing for it either
  if (size > MAX_FILE_BYTES) return { reason: 'oversize' };
  const text = io.read(abs);
  if (text === null) return { reason: 'unreadable' };
  return text.includes('\0') ? { reason: 'binary' } : { text: stripComments(lf(text)) };
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
  for (let cur = queue.shift(); cur && !capped; cur = queue.shift()) {
    if (cur.hop >= MAX_HOPS) continue;
    for (const raw of importsIn(cur.text)) {
      const abs = resolveInside(root, realRoot, dirname(cur.path), raw, io);
      const rel = abs === null ? '' : toPosix(relative(root, abs));
      if (abs !== null && seen.has(rel)) continue;
      if (++attempts > MAX_ATTEMPTS) { skipped.push({ path: rel || raw, by: cur.path, reason: 'cap' }); capped = true; break; }
      if (abs === null) { external.add(raw); continue; }
      seen.add(rel);
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
