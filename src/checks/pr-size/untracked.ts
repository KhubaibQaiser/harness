// Counts lines of untracked files for the working-tree measurement (spec §14.6). Untracked files are untrusted input.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const UNTRACKED = { maxBytes: 1024 * 1024, maxFiles: 2000, sniff: 8000 };
const NEWLINE = 10;

/** Lines in one untracked file: 0 for a symlink, a non-regular file, a binary, or one over maxBytes; never reads past maxBytes. */
export function untrackedLines(root: string, rel: string): number {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return 0;
  const p = join(root, rel);
  let fd: number | undefined;
  try {
    const l = lstatSync(p);
    if (!l.isFile() || l.size > UNTRACKED.maxBytes) return 0;
    fd = openSync(p, 'r');
    if (!fstatSync(fd).isFile()) return 0;
    const buf = Buffer.alloc(UNTRACKED.maxBytes + 1);
    let n = 0;
    for (let r = 1; r > 0 && n < buf.length; n += r) r = readSync(fd, buf, n, buf.length - n, null);
    if (n > UNTRACKED.maxBytes || buf.subarray(0, Math.min(n, UNTRACKED.sniff)).includes(0)) return 0;
    let count = 0;
    for (let i = 0; i < n; i++) if (buf[i] === NEWLINE) count++;
    return n > 0 && buf[n - 1] !== NEWLINE ? count + 1 : count;
  } catch {
    return 0; // vanished or unreadable between ls-files and now: still one file
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
