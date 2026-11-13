import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { ExecBytes } from '../core/exec.js';
import { LIMITS, neutralise, unsafe } from '../vet/fetch.js';
import { catFile, lsTree } from './base.js';

const WIN_ONLY = 'name not valid on Windows'; // the files stay on this machine, so only this OS's rules apply
// Every file gets this suffix, so no test runner, package manager or tool started in the repo treats a PR file as its own.
export const SNAPSHOT_SUFFIX = '.pr-snapshot';

/** `<dir>` from the head commit's blobs: no checkout, archive, worktree or tar. Symlinks become text files holding the target. `map` takes every written file to its name under `<dir>`. */
export function writeSnapshot(exec: ExecBytes, root: string, headSha: string, dir: string, o: { ignore: (rel: string) => boolean; only?: Set<string> }): { files: number; map: Record<string, string>; omitted: { path: string; why: string }[] } {
  const omitted: { path: string; why: string }[] = [];
  const todo: { path: string; to: string; sha: string; size: number; link: boolean }[] = [];
  for (const e of lsTree(exec, root, headSha)) {
    if (o.only && !o.only.has(e.path)) continue;
    const bad = unsafe(e.path);
    const why = e.path.split('/').some((x) => x.toLowerCase() === '.git') ? 'a .git path, not written' // a nested .git could make the copy a repo
      : e.mode === '160000' ? 'submodule, not read'
      : /^\.env/i.test(e.path.split('/').pop()!) ? 'dotenv file, not read'
      : o.ignore(e.path) ? 'matches .harnessignore, not read'
      : bad && (bad !== WIN_ONLY || process.platform === 'win32') ? bad
      : e.type !== 'blob' ? 'not a file, not read'
      : e.size > LIMITS.fileBytes ? 'over 1 MB, not read' : undefined;
    if (why) omitted.push({ path: e.path, why });
    else todo.push({ path: e.path, to: neutralise(e.path) + SNAPSHOT_SUFFIX, sha: e.sha, size: e.size, link: e.mode === '120000' });
  }
  // Case-insensitive filesystems fold case and Unicode form: names that collide would overwrite each other, so none is written.
  const fold = (s: string) => s.normalize('NFC').toUpperCase().toLowerCase();
  const groups = new Map<string, typeof todo>();
  for (const t of todo) groups.set(fold(t.to), [...(groups.get(fold(t.to)) ?? []), t]);
  const write = todo.filter((t) => {
    const g = groups.get(fold(t.to))!;
    if (g.length > 1) omitted.push({ path: t.path, why: `name collides with ${g.filter((x) => x !== t).map((x) => x.path).join(', ')}` });
    return g.length === 1;
  });

  const data = catFile(exec, root, write.map((t) => t.sha), write.reduce((s, t) => s + t.size + 128, 1024));
  const top = resolve(dir), map: Record<string, string> = {};
  let files = 0;
  mkdirSync(top, { recursive: true });
  write.forEach((t, i) => {
    const d = data[i];
    if (!d) throw new Error(`review: git cat-file did not return ${t.path}`);
    if (!t.link && d.subarray(0, 8000).includes(0)) return void omitted.push({ path: t.path, why: 'binary, not read' });
    const target = resolve(top, ...t.to.split('/'));
    if (!target.startsWith(top + sep)) return void omitted.push({ path: t.path, why: 'outside the snapshot folder, not written' });
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, d, { flag: 'wx' }); // never through a file or link already there
    } catch (err) {
      return void omitted.push({ path: t.path, why: `could not write (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
    }
    files++;
    map[t.path] = t.to;
  });
  return { files, map, omitted };
}
