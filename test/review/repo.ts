import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Synthetic temp repos for the review tests: no network, content made up here.
/** A file's content, or: null deletes it; `exec` is mode 100755; `link` is a symlink blob; `gitlink` a submodule entry. */
export type Entry = string | Buffer | null | { exec: string } | { link: string } | { gitlink: string } | { indexOnly: string };
export type Files = Record<string, Entry>;

export const git = (root: string, ...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', input: '' });

/** Writes `files` and commits them; symlinks and gitlinks go straight into the index, so no OS symlink support is needed. */
export function commit(root: string, files: Files, msg = 'c'): string {
  const special: [string, string, string][] = [];
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, ...rel.split('/'));
    if (v === null) { rmSync(p, { force: true }); continue; }
    // a name this OS can't create on disk (`a:b.ts` on Windows writes an NTFS stream of `a`): straight into the index
    if (typeof v === 'object' && !Buffer.isBuffer(v) && 'indexOnly' in v) { special.push(['100644', execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: v.indexOnly, encoding: 'utf8' }).trim(), rel]); continue; }
    mkdirSync(dirname(p), { recursive: true });
    if (typeof v === 'string' || Buffer.isBuffer(v)) writeFileSync(p, v);
    else if ('exec' in v) writeFileSync(p, v.exec);
    else if ('link' in v) special.push(['120000', execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: v.link, encoding: 'utf8' }).trim(), rel]);    else special.push(['160000', v.gitlink, rel]);
  }
  git(root, 'add', '-A');
  for (const [rel, v] of Object.entries(files)) if (v && typeof v === 'object' && !Buffer.isBuffer(v) && 'exec' in v) git(root, 'update-index', '--chmod=+x', '--', rel);
  for (const [mode, sha, rel] of special) git(root, 'update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`);
  git(root, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(root, 'rev-parse', 'HEAD').trim();
}

/** A repo with a base commit and a head commit on top of it. */
export function repoWith(base: Files, head: Files): { root: string; base: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'h-review-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 'test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.protectNTFS', 'false']]) git(root, 'config', k!, v!); // protectNTFS: Git for Windows refuses NTFS-hostile index paths; the fixture keeps them in the tree, never on disk
  const b = commit(root, base, 'base');
  return { root, base: b, head: commit(root, head, 'head') };
}
