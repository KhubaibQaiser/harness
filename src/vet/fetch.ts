import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isNotFound } from '../catalog/resolve.js';
import type { ExecBytes } from '../core/exec.js';
import { readTar } from './tar.js';
import { vetId, type Resolved } from './target.js';

export const LIMITS = { compressed: 25 * 1024 * 1024, files: 5000, fileBytes: 1024 * 1024, unpacked: 100 * 1024 * 1024 };
/** `dir` is absolute, under the OS temp dir (D12), never in the project. `files` are the archive's original paths (posix) that were written; `map` takes each to the path it has under `dir`. */
export interface Fetched { dir: string; files: string[]; map: Record<string, string>; skipped: { path: string; why: string }[]; large: string[] }

const WIN = /[<>:"|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³])(\..*)?$|^con(in|out)\$$/i;
const PREFIX = 'harness-vet-';

/** Why an entry path can't be written safely on any OS, or undefined if it can. */
function unsafe(path: string): string | undefined {
  if (path.startsWith('/')) return 'absolute path';
  const segs = path.replace(/\/$/, '').split('/');
  if (segs.includes('..')) return 'parent path (..)';
  if (path.includes('\\') || segs.some((s) => s === '' || s === '.' || WIN.test(s))) return 'name not valid on Windows';
  return undefined;
}

/** D12: names Claude Code reads as instructions get a .vetted suffix, so nothing in the unpacked tree is auto-loaded. */
function neutralise(path: string): string {
  const segs = path.split('/');
  return segs.map((s, i) => (i === segs.length - 1 ? /^(claude\.md|claude\.local\.md|agents\.md)$/i.test(s) : /^\.claude$/i.test(s)) ? `${s}.vetted` : s).join('/');
}

// ponytail: Task 8 must call cleanTmp(dir) in a try/finally around the whole run (spec 3.5); fetchTarball only cleans up after its own failures.
// ponytail: Task 3 must filter files, skipped and large to the scan scope (r.path, .claude-plugin/, .mcp.json), or out-of-scope entries become findings.
// ponytail: the live `gh api repos/o/r/tarball/<sha>` (redirect to codeload, raw binary stdout) is checked only in the Task 27 live run.
export function fetchTarball(r: Resolved, exec: ExecBytes): Fetched | { error: string } {
  const at = `${r.repo}@${r.sha.slice(0, 7)}`;
  const g = exec('gh', ['api', `repos/${r.repo}/tarball/${r.sha}`], LIMITS.compressed + 1);
  if (g.missing) return { error: 'harness vet needs the GitHub CLI (gh). Install the GitHub CLI (gh), then run harness vet again.' };
  if (g.tooBig || g.stdout.length > LIMITS.compressed) return { error: `${at}: the archive is over 25 MB; vet stops.` };
  if (g.status !== 0) return { error: isNotFound(g.stderr) ? `${at}: tarball not found on GitHub.` : `${at}: could not download the tarball (gh exited ${g.status}). Check your network or run gh auth status, then try again.` };
  let entries;
  try { entries = readTar(g.stdout, LIMITS.unpacked); } catch (e) { return { error: `${at}: ${(e as Error).message}; vet stops.` }; }
  if (entries.filter((e) => e.type === 'file').length > LIMITS.files) return { error: `${at}: the archive has over ${LIMITS.files} files; vet stops.` };

  const skipped: Fetched['skipped'] = [], large: string[] = [];
  const todo: { path: string; to: string; data: Buffer }[] = [];
  for (const e of entries) {
    if (e.type === 'dir') continue;
    const why = e.type === 'symlink' ? 'symlink' : e.type === 'hardlink' ? 'hard link' : e.type === 'other' ? 'special file' : unsafe(e.path);
    if (why) skipped.push({ path: e.path, why });
    else if (e.data.length > LIMITS.fileBytes) large.push(e.path);
    else todo.push({ path: e.path, to: neutralise(e.path), data: e.data });
  }
  // Case-insensitive filesystems (macOS, Windows) fold case and Unicode form: colliding entries would overwrite each other, so none is written.
  const groups = new Map<string, typeof todo>();
  for (const t of todo) {
    const k = t.to.normalize('NFC').toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const clash = new Set<(typeof todo)[number]>();
  for (const g2 of groups.values()) {
    if (g2.length < 2) continue;
    for (const t of g2) {
      clash.add(t);
      const others = g2.filter((o) => o !== t).map((o) => o.path);
      skipped.push({ path: t.path, why: others.every((o) => o === t.path) ? `duplicate entry ${t.path}` : `name collides with ${others.join(', ')}` });
    }
  }

  const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${vetId(r)}-${r.sha.slice(0, 7)}-`));
  const map: Record<string, string> = {};
  try {
    writeFileSync(join(dir, '.gitignore'), '*\n'); // first, so a crash never leaves stageable files
    for (const t of todo) {
      if (clash.has(t)) continue;
      const target = resolve(dir, ...t.to.split('/'));
      if (!target.startsWith(dir + sep)) { skipped.push({ path: t.path, why: 'parent path (..)' }); continue; }
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, t.data);
        map[t.path] = t.to;
      } catch (err) { skipped.push({ path: t.path, why: `could not write (${(err as NodeJS.ErrnoException).code ?? 'error'})` }); }
    }
  } catch (err) {
    cleanTmp(dir);
    return { error: `${at}: could not unpack the archive (${(err as NodeJS.ErrnoException).code ?? 'error'}).` };
  }
  return { dir, files: Object.keys(map).sort(), map, skipped, large };
}

/** Removes an unpacked folder. Refuses anything that is not a harness-vet-* folder directly under the OS temp dir. */
export function cleanTmp(dir: string): void {
  if (dirname(resolve(dir)) !== resolve(tmpdir()) || !basename(dir).startsWith(PREFIX)) return;
  rmSync(dir, { recursive: true, force: true });
}
