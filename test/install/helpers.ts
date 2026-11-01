import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

/** Writes `files` into a fresh temp dir; with git (default) inits and makes one commit. `remoteHead` fakes origin/HEAD -> origin/<name>. */
export function makeRepo(files: Record<string, string>, opts: { git?: boolean; remoteHead?: string; branch?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'harness-repo-'));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  if (opts.git === false) return root;
  git(root, 'init', '-q', '-b', opts.branch ?? 'main');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  if (opts.remoteHead) {
    git(root, 'update-ref', `refs/remotes/origin/${opts.remoteHead}`, 'HEAD');
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${opts.remoteHead}`);
  }
  return root;
}
