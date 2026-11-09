import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isOver, limitText, measure, type Git } from '../checks/pr-size/measure.js';
import { raisedLimit, readProgress } from '../checks/pr-size/progress.js';
import { suggestBranches } from '../core/branch-prefix.js';
import { esc, type HarnessConfig, loadConfig } from '../core/config.js';
import { defaultExec, type Exec } from '../core/exec.js';
import { readManifest } from '../install/apply.js';
import { dirtyPaths } from '../install/git-status.js';
import { MANIFEST_REL } from '../install/manifest.js';
import { ownCommand, shq } from './init.js';
import type { CliEnv } from './index.js';

const USAGE = 'Usage: harness git branch [--suggest <topic>]|commit|push|pr [--title <t>]';
const NETWORK = /could not resolve host|unable to access|network is unreachable|connection (refused|timed out|reset)|timed out|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|error connecting to/i;

/** The preset's PR size warning, or null within the limit. The branch's recorded raise is its max (N5), as in the check. */
function sizeWarning(root: string, config: HarnessConfig, want: { base: string; head: string }, git?: Git): string | null {
  const size = measure(root, want, config, git ? { git } : {});
  if ('error' in size) return `PR size not measured: ${size.error}.`;
  const lim = raisedLimit(config.pr_size, readProgress(root), () => want.head);
  return isOver(size, lim) ? `This PR has ${size.lines} changed lines in ${size.files} files; the limit is ${limitText(lim.max_lines, lim.max_files)}.` : null;
}

type Run = { status: number; stdout: string; stderr?: string };
type GitRun = (...a: string[]) => Run;
type Manifest = NonNullable<ReturnType<typeof readManifest>>;
interface Parsed { sub: string; rest: string[]; topic?: string; title?: string }
interface Ctx {
  root: string; out: CliEnv['out']; exec: Exec; git: GitRun; sizeGit?: Git; m: Manifest; config: HarnessConfig;
  preset: HarnessConfig['preset']; sub: string; rest: string[]; title?: string; branch: string; def: string;
  candidates: string[]; exists: (b: string) => boolean; mine: string[];
}

const lines = (s: string) => s.trim().split(/\r?\n/).map(esc).join('\n');
const SUBS = ['branch', 'commit', 'push', 'pr'];
const WITH_VALUE = 2;

/** The parsed arguments, or null when they do not fit the usage line. */
function parseArgs(args: string[]): Parsed | null {
  const [sub, ...rest] = args;
  const titleAt = rest.indexOf('--title');
  const topic = sub === 'branch' && rest[0] === '--suggest' ? rest[1] : undefined;
  const title = titleAt >= 0 ? rest[titleAt + 1] : undefined;
  const expected = (sub === 'pr' && titleAt === 0) || (sub === 'branch' && rest[0] === '--suggest') ? WITH_VALUE : 0;
  const badValue = (v: string | undefined) => !v || v.startsWith('--');
  if (!SUBS.includes(sub) || rest.length !== expected || (rest[0] === '--suggest' && badValue(topic)) || (titleAt >= 0 && badValue(title))) return null;
  return { sub, rest, topic, title };
}

/** Every candidate counts as default for the refusals (a global init.defaultBranch can disagree with the repo's real one). */
function findDefault(git: GitRun, exists: (b: string) => boolean): { candidates: string[]; def: string | undefined } {
  const head = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').stdout.trim().replace(/^origin\//, '');
  const candidates = [...new Set([head, git('config', 'init.defaultBranch').stdout.trim(), 'main', 'master'].filter(Boolean))];
  const def = candidates.find((b) => exists(b) || git('rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`).status === 0);
  return { candidates, def };
}

function failed(c: Ctx, cmd: string, r: { stderr?: string; stdout: string }): number {
  const err = (r.stderr || r.stdout).trim();
  return c.out(NETWORK.test(err) ? `${cmd} failed: the sandbox or the network blocked it (${lines(err)}). ${ownCommand('git', [c.sub, ...c.rest])}` : `${cmd} failed: ${lines(err)}\nFix that, then run \`harness git ${c.sub}\` again.`), 1;
}

function stepBranch(c: Ctx): number {
  // A dirty directory ("dir/") is fine when it only holds harness files.
  const other = dirtyPaths(c.root).filter((p) => !c.mine.some((f) => f === p || (p.endsWith('/') && f.startsWith(p))));
  if (other.length) return c.out(`Commit or stash these first: ${other.map(esc).join(', ')}.`), 1;
  const b = `chore/ai-workflow-${c.config.catalog_version}`;
  if (c.exists(b)) return c.out(`Branch ${esc(b)} already exists. Delete it or rename it, then run again.`), 1;
  const r = c.git('checkout', '-b', b);
  return r.status ? failed(c, 'git checkout', r) : (c.out(`Switched to a new branch ${esc(b)}.`), 0);
}

function stepCommit(c: Ctx): number {
  const { git, config, preset, branch } = c;
  for (const k of ['user.name', 'user.email']) if (!git('config', k).stdout.trim()) return c.out('Set your git user.name and user.email, then run again.'), 1;
  // Deleted files stay in the list (`add -A` stages the deletion); skip only paths that never existed.
  const dirty = dirtyPaths(c.root);
  const paths = c.mine.filter((f) => existsSync(join(c.root, f)) || dirty.includes(f));
  if (!paths.length) return c.out('No harness files to commit.'), 1;
  // Literal: a manifest path with * ? [ or a leading : must not match anything else.
  const lit = (...a: string[]) => git('--literal-pathspecs', ...a);
  if (preset?.git.no_ai_trailer && config.git.commit_trailer) return c.out(`The ${esc(preset.id)} preset bans AI trailers; clear git.commit_trailer.`), 1;
  const add = lit('add', '-A', '--', ...paths);
  if (add.status) return failed(c, 'git add', add);
  const msg = `chore: add AI workflow (harness ${c.m.version}, catalog ${config.catalog_version})${config.git.commit_trailer ? `\n\n${config.git.commit_trailer}` : ''}`;
  // Pathspec limits the commit to the harness paths, so anything else the person staged stays out.
  const r = lit('commit', '-m', msg, '--', ...paths);
  return r.status ? failed(c, 'git commit', r) : (c.out(`Committed on ${esc(branch)}.`), 0);
}

function stepPush(c: Ctx): number {
  const r = c.git('push', '-u', 'origin', c.branch);
  return r.status ? failed(c, 'git push', r) : (c.out(`Pushed ${esc(c.branch)} to origin.`), 0);
}

function stepPr(c: Ctx): number {
  if (c.preset?.git.pr_size_warning) {
    const warning = sizeWarning(c.root, c.config, { base: c.def, head: c.branch }, c.sizeGit);
    if (warning) c.out(warning);
  }
  const REPORT = '.harness/report.md';
  const create = ['pr', 'create', '--base', c.def, '--head', c.branch, '--title', c.title ?? 'chore: add AI workflow', '--body-file'];
  const auth = c.exec('gh', ['auth', 'status']);
  if (auth.missing || auth.status) return c.out(`${auth.missing ? 'gh is not installed' : 'gh could not confirm a sign-in'}. Run this yourself: gh ${[...create, REPORT].map(shq).join(' ')}`), 0;
  const report = join(c.root, REPORT);
  if (!existsSync(report)) return c.out(`No report at \`${REPORT}\`. Run /harness:init first, then run again.`), 1;
  const r = c.exec('gh', [...create, report]);
  return r.status ? failed(c, 'gh pr create', r) : (c.out(lines(r.stdout)), 0);
}

/** Steps run by the skill only after the person says yes: one step per call, never on the default branch. */
export function gitStep(args: string[], { root, out, exec = defaultExec, git: sizeGit }: CliEnv & { exec?: Exec; git?: Git }): number {
  const p = parseArgs(args);
  if (!p) return out(USAGE), 2;
  const { sub, rest, topic, title } = p;

  const git: GitRun = (...a) => exec('git', ['-C', root, ...a]);
  const m = readManifest(root);
  if (!m) return out('harness is not installed here. Run `/harness:init` first.'), 1;
  const { config } = loadConfig(root);
  const preset = config.preset;
  if (topic !== undefined) return preset ? (out(suggestBranches(preset.git.branch_prefixes, topic).map(esc).join('\n')), 0) : (out('No preset is recorded in .harness/config.yaml; nothing to suggest from.'), 1);
  const branch = git('branch', '--show-current').stdout.trim();
  // Not detect(): its last fallback is the current branch, which would make a feature branch the "default".
  const exists = (b: string) => git('rev-parse', '--verify', '-q', `refs/heads/${b}`).status === 0;
  const { candidates, def } = findDefault(git, exists);
  if (!def) return out("Can't tell the default branch. Run `git remote set-head origin -a`, then run again."), 1;
  const c: Ctx = { root, out, exec, git, sizeGit, m, config, preset, sub, rest, title, branch, def, candidates, exists, mine: [...m.files.map((f) => f.rel), MANIFEST_REL] };

  if (sub === 'branch') return stepBranch(c);
  if (!branch || candidates.includes(branch)) {
    const then = sub === 'push' ? 'Harness never pushes the default branch.' : 'Run harness git branch first.';
    return out(`You are on ${esc(branch || 'a detached HEAD')}. ${then}`), 1;
  }
  if (sub === 'commit') return stepCommit(c);
  return sub === 'push' ? stepPush(c) : stepPr(c);
}
