import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { esc, loadConfig } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { readManifest } from '../install/apply.js';
import { detect } from '../install/detect.js';
import { dirtyPaths } from '../install/git-status.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { sandboxLine, shq } from './init.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness git branch|commit|push|pr [--title <t>]';
const NETWORK = /could not resolve host|unable to access|network is unreachable|connection (refused|timed out|reset)|timed out|EAI_AGAIN|ENOTFOUND|error connecting to/i;

/** True for the repo's default branch, `main` or `master`. */
export const onDefault = (branch: string, defaultBranch: string): boolean => [defaultBranch, 'main', 'master'].includes(branch);

/** Steps run by the skill only after the person says yes: one step per call, never on the default branch. */
export function gitStep(args: string[], { root, out, exec = defaultExec }: CliEnv & { exec?: Exec }): number {
  const [sub, ...rest] = args;
  const titleAt = rest.indexOf('--title');
  const title = titleAt >= 0 ? rest[titleAt + 1] : undefined;
  if (!['branch', 'commit', 'push', 'pr'].includes(sub) || rest.length !== (sub === 'pr' && titleAt === 0 ? 2 : 0) || (titleAt >= 0 && !title)) return out(USAGE), 2;

  const git = (...a: string[]) => exec('git', ['-C', root, ...a]);
  const m = readManifest(root);
  if (!m) return out('harness is not installed here. Run /harness:init first.'), 1;
  const { config } = loadConfig(root);
  const branch = git('branch', '--show-current').stdout.trim();
  const def = detect(root).defaultBranch;
  const failed = (cmd: string, r: { stderr?: string; stdout: string }) => {
    const err = (r.stderr || r.stdout).trim();
    return out(NETWORK.test(err) ? sandboxLine('git', [sub]) : `${cmd} failed: ${esc(err)}`), 1;
  };

  const mine = [...m.files.map((f) => f.rel), MANIFEST_REL];

  if (sub === 'branch') {
    // A dirty directory ("dir/") is fine when it only holds harness files.
    const other = dirtyPaths(root).filter((p) => !mine.some((f) => f === p || (p.endsWith('/') && f.startsWith(p))));
    if (other.length) return out(`Commit or stash these first: ${other.map(esc).join(', ')}.`), 1;
    const b = `chore/ai-workflow-${config.catalog_version}`;
    if (git('rev-parse', '--verify', '-q', `refs/heads/${b}`).status === 0) return out(`Branch ${b} already exists. Delete it or rename it, then run again.`), 1;
    const r = git('checkout', '-b', b);
    return r.status ? failed('git checkout', r) : (out(`Switched to a new branch ${b}.`), 0);
  }

  if (!branch || onDefault(branch, def)) {
    const then = sub === 'commit' ? 'Run harness git branch first.' : sub === 'push' ? 'Harness never pushes the default branch.' : 'Run harness git branch first.';
    return out(`You are on ${esc(branch || 'a detached HEAD')}. ${then}`), 1;
  }

  if (sub === 'commit') {
    for (const k of ['user.name', 'user.email']) if (!git('config', k).stdout.trim()) return out('Set your git user.name and user.email, then run again.'), 1;
    // Deleted files stay in the list (`add -A` stages the deletion); skip only paths that never existed.
    const dirty = dirtyPaths(root);
    const paths = mine.filter((f) => existsSync(join(root, f)) || dirty.includes(f));
    const add = paths.length ? git('add', '-A', '--', ...paths) : { status: 1, stdout: '', stderr: 'nothing to stage' };
    if (add.status) return failed('git add', add);
    const msg = `chore: add AI workflow (harness ${m.version}, catalog ${config.catalog_version})${config.git.commit_trailer ? `\n\n${config.git.commit_trailer}` : ''}`;
    // Pathspec limits the commit to the harness paths, so anything else the person staged stays out.
    const r = git('commit', '-m', msg, '--', ...paths);
    return r.status ? failed('git commit', r) : (out(`Committed on ${branch}.`), 0);
  }

  if (sub === 'push') {
    const r = git('push', '-u', 'origin', branch);
    return r.status ? failed('git push', r) : (out(`Pushed ${branch} to origin.`), 0);
  }

  const create = ['pr', 'create', '--base', def, '--head', branch, '--title', title ?? 'chore: add AI workflow', '--body-file', '.harness/report.md'];
  const auth = exec('gh', ['auth', 'status']);
  if (auth.missing || auth.status) return out(`${auth.missing ? 'gh is not installed' : 'gh is not signed in'}. Run this yourself: gh ${create.map(shq).join(' ')}`), 0;
  const r = exec('gh', create);
  return r.status ? failed('gh pr create', r) : (out(r.stdout.trim()), 0);
}
