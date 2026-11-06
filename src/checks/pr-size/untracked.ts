// Counts lines of untracked files for the working-tree measurement (spec §14.6). Untracked files are untrusted input.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { matches } from '../../core/paths.js';

export const UNTRACKED = { maxBytes: 1024 * 1024, maxFiles: 2000, sniff: 8000 };
const NEWLINE = 10;
const CHUNK = 64 * 1024;
const chunk = Buffer.allocUnsafe(CHUNK); // one reusable read buffer, never a maxBytes allocation per file
// O_NOFOLLOW is undefined on Windows, where the lstat check stands alone.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Reads up to maxBytes+1 in chunks: 0 on a NUL in the first `sniff` bytes or on more than maxBytes. */
function scan(fd: number): number {
  let total = 0;
  let count = 0;
  let last = NEWLINE;
  for (;;) {
    const n = readSync(fd, chunk, 0, Math.min(CHUNK, UNTRACKED.maxBytes + 1 - total), null);
    if (n === 0) break;
    if (total < UNTRACKED.sniff && chunk.subarray(0, Math.min(n, UNTRACKED.sniff - total)).includes(0)) return 0;
    for (let i = 0; i < n; i++) if (chunk[i] === NEWLINE) count++;
    last = chunk[n - 1]!;
    total += n;
    if (total > UNTRACKED.maxBytes) return 0;
  }
  return total > 0 && last !== NEWLINE ? count + 1 : count;
}

/** Lines in one untracked file: 0 for a symlink, a non-regular file, a binary, or one over maxBytes; never reads past maxBytes. */
export function untrackedLines(root: string, rel: string): number {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 0;
  const p = join(root, rel);
  let fd: number | undefined;
  try {
    const l = lstatSync(p);
    if (!l.isFile() || l.size > UNTRACKED.maxBytes) return 0;
    fd = openSync(p, OPEN_FLAGS);
    return fstatSync(fd).isFile() ? scan(fd) : 0;
  } catch {
    return 0; // vanished, unreadable, or swapped for a symlink (ELOOP): still one file
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface Sink { skip: string[]; top: { path: string; lines: number }[]; excluded: string[] }

/** Adds the `ls-files -z` listing to the sink. `expired` is checked before each read; true stops, and the result is false. */
export function addUntracked(root: string, listing: string, sink: Sink, expired: () => boolean): boolean {
  let read = 0;
  for (const path of listing.split('\0')) {
    if (!path) continue;
    if (matches(path, sink.skip)) { sink.excluded.push(path); continue; }
    if (read < UNTRACKED.maxFiles && expired()) return false;
    sink.top.push({ path, lines: read++ < UNTRACKED.maxFiles ? untrackedLines(root, path) : 0 });
  }
  return true;
}
