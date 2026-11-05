import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOver, measure, type Git } from '../checks/pr-size/measure.js';
import { suggestBranches } from '../core/branch-prefix.js';
import { esc, loadConfig } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { readManifest } from '../install/apply.js';
import { dirtyPaths } from '../install/git-status.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { ownCommand, shq } from './init.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness git branch [--suggest <topic>]|commit|push|pr [--title <t>]';
const NETWORK = /could not resolve host|unable to access|network is unreachable|connection (refused|timed out|reset)|timed out|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|error connecting to/i;

/** Steps run by the skill only after the person says yes: one step per call, never on the default branch. */
export function gitStep(args: string[], { root, out, exec = defaultExec, git: sizeGit }: CliEnv & { exec?: Exec; git?: Git }): number {
  const [sub, ...rest] = args;
  const titleAt = rest.indexOf('--title');
  const topic = sub === 'branch' && rest[0] === '--suggest' ? rest[1] : undefined;
  const title = titleAt >= 0 ? rest[titleAt + 1] : undefined;
  if (!['branch', 'commit', 'push', 'pr'].includes(sub) || rest.length !== (sub === 'pr' && titleAt === 0 ? 2 : sub === 'branch' && rest[0] === '--suggest' ? 2 : 0) || (rest[0] === '--suggest' && (!topic || topic.startsWith('--'))) || (titleAt >= 0 && (!title || title.startsWith('--')))) return out(USAGE), 2;

  const git = (...a: string[]) => exec('git', ['-C', root, ...a]);
  const m = readManifest(root);
  if (!m) return out('harness is not installed here. Run `/harness:init` first.'), 1;
  const { config } = loadConfig(root);
  const preset = config.preset;
  if (topic !== undefined) return preset ? (out(suggestBranches(preset.git.branch_prefixes, topic).map(esc).join('\n')), 0) : (out('No preset is recorded in .harness/config.yaml; nothing to suggest from.'), 1);
  const branch = git('branch', '--show-current').stdout.trim();
  // Not detect(): its last fallback is the current branch, which would make a feature branch the "default".
  const exists = (b: string) => git('rev-parse', '--verify', '-q', `refs/heads/${b}`).status === 0;
  const head = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim().replace(/^origin\//, '');
  // Every candidate counts as default for the refusals (a global init.defaultBranch can disagree with the repo's real one).
  const candidates = [...new Set([head, git('config', 'init.defaultBranch').stdout.trim(), 'main', 'master'].filter(Boolean))];
  const def = candidates.find((b) => exists(b) || git('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`).status === 0);
  if (!def) return out("Can't tell the default branch. Run `git remote set-head origin -a`, then run again."), 1;
  const lines = (s: string) => s.trim().split(/\r?\n/).map(esc).join('\n');
  const failed = (cmd: string, r: { stderr?: string; stdout: string }) => {
    const err = (r.stderr || r.stdout).trim();
    return out(NETWORK.test(err) ? `${cmd} failed: the sandbox or the network blocked it (${lines(err)}). ${ownCommand('git', [sub, ...rest])}` : `${cmd} failed: ${lines(err)}\nFix that, then run \`harness git ${sub}\` again.`), 1;
  };

  const mine = [...m.files.map((f) => f.rel), MANIFEST_REL];

  if (sub === 'branch') {
    // A dirty directory ("dir/") is fine when it only holds harness files.
    const other = dirtyPaths(root).filter((p) => !mine.some((f) => f === p || (p.endsWith('/') && f.startsWith(p))));
    if (other.length) return out(`Commit or stash these first: ${other.map(esc).join(', ')}.`), 1;
    const b = `chore/ai-workflow-${config.catalog_version}`;
    if (exists(b)) return out(`Branch ${esc(b)} already exists. Delete it or rename it, then run again.`), 1;
    const r = git('checkout', '-b', b);
    return r.status ? failed('git checkout', r) : (out(`Switched to a new branch ${esc(b)}.`), 0);
  }

  if (!branch || candidates.includes(branch)) {
    const then = sub === 'commit' ? 'Run harness git branch first.' : sub === 'push' ? 'Harness never pushes the default branch.' : 'Run harness git branch first.';
    return out(`You are on ${esc(branch || 'a detached HEAD')}. ${then}`), 1;
  }

  if (sub === 'commit') {
    for (const k of ['user.name', 'user.email']) if (!git('config', k).stdout.trim()) return out('Set your git user.name and user.email, then run again.'), 1;
    // Deleted files stay in the list (`add -A` stages the deletion); skip only paths that never existed.
    const dirty = dirtyPaths(root);
    const paths = mine.filter((f) => existsSync(join(root, f)) || dirty.includes(f));
    if (!paths.length) return out('No harness files to commit.'), 1;
    // Literal: a manifest path with * ? [ or a leading : must not match anything else.
    const lit = (...a: string[]) => git('--literal-pathspecs', ...a);
    if (preset?.git.no_ai_trailer && config.git.commit_trailer) return out(`The ${esc(preset.id)} preset bans AI trailers; clear git.commit_trailer.`), 1;
    const add = lit('add', '-A', '--', ...paths);
    if (add.status) return failed('git add', add);
    const msg = `chore: add AI workflow (harness ${m.version}, catalog ${config.catalog_version})${config.git.commit_trailer ? `\n\n${config.git.commit_trailer}` : ''}`;
    // Pathspec limits the commit to the harness paths, so anything else the person staged stays out.
    const r = lit('commit', '-m', msg, '--', ...paths);
    return r.status ? failed('git commit', r) : (out(`Committed on ${esc(branch)}.`), 0);
  }

  if (sub === 'push') {
    const r = git('push', '-u', 'origin', branch);
    return r.status ? failed('git push', r) : (out(`Pushed ${esc(branch)} to origin.`), 0);
  }

  if (preset?.git.pr_size_warning) {
    const size = measure(root, { base: def, head: branch }, config, { git: sizeGit });
    if ('error' in size) out(`PR size not measured: ${size.error}.`);
    else if (isOver(size, config.pr_size)) out(`This PR has ${size.lines} changed lines in ${size.files} files; the limit is ${config.pr_size.max_lines} lines or ${config.pr_size.max_files} files.`);
  }
  const REPORT = '.harness/report.md';
  const create = ['pr', 'create', '--base', def, '--head', branch, '--title', title ?? 'chore: add AI workflow', '--body-file'];
  const auth = exec('gh', ['auth', 'status']);
  if (auth.missing || auth.status) return out(`${auth.missing ? 'gh is not installed' : 'gh could not confirm a sign-in'}. Run this yourself: gh ${[...create, REPORT].map(shq).join(' ')}`), 0;
  const report = join(root, REPORT);
  if (!existsSync(report)) return out(`No report at \`${REPORT}\`. Run /harness:init first, then run again.`), 1;
  const r = exec('gh', [...create, report]);
  return r.status ? failed('gh pr create', r) : (out(lines(r.stdout)), 0);
}
