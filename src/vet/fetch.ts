import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { isNotFound } from '../catalog/resolve.js';
import type { ExecBytes } from '../core/exec.js';
import { readTar } from './tar.js';
import { vetId, type Resolved } from './target.js';

export const LIMITS = { compressed: 25 * 1024 * 1024, files: 5000, fileBytes: 1024 * 1024, unpacked: 100 * 1024 * 1024 };
export interface Fetched { dir: string; rel: string; files: string[]; skipped: { path: string; why: string }[]; large: string[] }

const WIN = /[<>:"|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const tmpDir = (root: string) => join(root, '.harness', 'vet', 'tmp');

/** Why an entry path can't be written safely on any OS, or undefined if it can. */
function unsafe(path: string): string | undefined {
  if (path.startsWith('/')) return 'absolute path';
  const segs = path.replace(/\/$/, '').split('/');
  if (segs.includes('..')) return 'parent path (..)';
  if (path.includes('\\') || segs.some((s) => s === '' || s === '.' || WIN.test(s))) return 'name not valid on Windows';
  return undefined;
}

export function fetchTarball(root: string, r: Resolved, exec: ExecBytes): Fetched | { error: string } {
  const at = `${r.repo}@${r.sha.slice(0, 7)}`;
  const g = exec('gh', ['api', `repos/${r.repo}/tarball/${r.sha}`], LIMITS.compressed + 1);
  if (g.missing) return { error: 'harness vet needs the GitHub CLI (gh). Install the GitHub CLI (gh), then run harness vet again.' };
  if (g.tooBig || g.stdout.length > LIMITS.compressed) return { error: `${at}: the archive is over 25 MB; vet stops.` };
  if (g.status !== 0) return { error: isNotFound(g.stderr) ? `${at}: tarball not found on GitHub.` : `${at}: could not download the tarball (gh exited ${g.status}). Check your network or run gh auth status, then try again.` };
  let entries;
  try { entries = readTar(g.stdout, LIMITS.unpacked); } catch (e) { return { error: `${at}: ${(e as Error).message}; vet stops.` }; }
  if (entries.filter((e) => e.type === 'file').length > LIMITS.files) return { error: `${at}: the archive has over ${LIMITS.files} files; vet stops.` };

  const key = `${vetId(r)}-${r.sha}`;
  const dir = join(tmpDir(root), key);
  cleanTmp(root, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(tmpDir(root), '.gitignore'), '*\n');
  const files = new Set<string>(), skipped: Fetched['skipped'] = [], large: string[] = [];
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const why = e.type === 'symlink' ? 'symlink' : e.type === 'hardlink' ? 'hard link' : e.type === 'other' ? 'special file' : unsafe(e.path);
    if (why) { skipped.push({ path: e.path, why }); continue; }
    if (e.data.length > LIMITS.fileBytes) { large.push(e.path); continue; }
    const target = resolve(dir, ...e.path.split('/'));
    if (!target.startsWith(dir + sep)) { skipped.push({ path: e.path, why: 'parent path (..)' }); continue; }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data);
      files.add(e.path);
    } catch (err) { skipped.push({ path: e.path, why: `could not write (${(err as NodeJS.ErrnoException).code ?? 'error'})` }); }
  }
  return { dir, rel: `.harness/vet/tmp/${key}`, files: [...files].sort(), skipped, large };
}

export function cleanTmp(root: string, key?: string): void {
  rmSync(key ? join(tmpDir(root), key) : tmpDir(root), { recursive: true, force: true });
}
