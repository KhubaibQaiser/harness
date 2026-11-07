// `@path` import expansion for CLAUDE.md-style files. Repo text is untrusted: depth, count and size are capped, and
// nothing outside the root (lexically or through a symlink) is ever read.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { defaultExec } from '../core/exec.js';
import { MAX_FILE_BYTES, fenceAfter, lf, stripComments } from './text.js';

export const MAX_HOPS = 4;
/** Files read per expansion (the `seen` set is shared, so this bounds a whole measurement's walk too). */
export const MAX_IMPORTED = 100;
const LS_FILES_MS = 2000;
const IMPORT = /(?:^|\s)@(\S+)/g;
const CODE_SPAN = /(`+)[^`]*?\1/g;

export interface RepoIO {
  read(abs: string): string | null;
  size(abs: string): number | null;
  lsFiles(root: string): string[] | null;
  /** Real path with symlinks resolved, or null. Optional: a fake without it is trusted to stay in its root. */
  real?(abs: string): string | null;
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
    for (const m of line.replace(CODE_SPAN, ' ').matchAll(IMPORT)) found.push(m[1]);
  }
  return found;
}

const isExternalForm = (p: string): boolean => p.startsWith('~') || posix.isAbsolute(p) || win32.isAbsolute(p);

interface Hop { path: string; text: string; hop: number }

function load(root: string, abs: string, io: RepoIO): string | null {
  const size = io.size(abs);
  if (size === null || size > MAX_FILE_BYTES) return null;
  const text = io.read(abs);
  return text === null || text.includes('\0') ? null : stripComments(lf(text));
}

export function expandImports(root: string, start: { path: string; text: string }, io: RepoIO, seen: Set<string>, skip: (rel: string) => boolean): { files: Imported[]; external: string[] } {
  const files: Imported[] = [];
  const external = new Set<string>();
  const realRoot = io.real?.(root) ?? root;
  const queue: Hop[] = [{ ...start, hop: 0 }];
  seen.add(start.path);
  for (let cur = queue.shift(); cur && files.length < MAX_IMPORTED; cur = queue.shift()) {
    if (cur.hop >= MAX_HOPS) continue;
    for (const raw of importsIn(cur.text)) {
      if (files.length >= MAX_IMPORTED) break;
      const abs = isExternalForm(raw) ? null : resolve(root, dirname(cur.path), raw);
      const real = abs === null ? null : (io.real?.(abs) ?? abs);
      if (abs === null || !inside(root, abs) || (io.real && real !== null && !inside(realRoot, real))) { external.add(raw); continue; }
      const rel = toPosix(relative(root, abs));
      if (seen.has(rel) || skip(rel)) continue;
      seen.add(rel);
      const text = load(root, abs, io);
      if (text === null) continue;
      files.push({ path: rel, text, by: cur.path });
      queue.push({ path: rel, text, hop: cur.hop + 1 });
    }
  }
  return { files, external: [...external] };
}
