// `dispatch.mjs --pr-size`: the pr-ship skill's measure call. Prints one JSON line; exit 0 within the limit, 1 over, 2 on any error.
// `dispatch.mjs --pr-size-raise`: checks a raise and prints it (exit 0, or 2 with `error`). It writes nothing; the hook records it.
import { loadConfig } from '../../core/config.js';
import { repoRoot } from '../../core/repo-root.js';
import { RAISE_FLAG, raiseArgs } from './detect.js';
import { currentBranch, type Git, isOver, measure, plainBranch, realGit } from './measure.js';
import { raiseLimits } from './raise.js';

const USAGE = 'usage: dispatch.mjs --pr-size [--base <name>] [--head <name>] [--worktree]';

const RAISE_USAGE = 'usage: dispatch.mjs --pr-size-raise --lines <n> [--files <n>]';

function raiseEntry(argv: string[], cwd: string, fail: (error: string) => 2, out: (line: string) => void): 0 | 2 {
  const args = raiseArgs(argv.filter((a) => a !== RAISE_FLAG));
  if (!args) return fail(RAISE_USAGE);
  try {
    const root = repoRoot(cwd);
    const loaded = loadConfig(root);
    if (loaded.errors.length) return fail(`\`.harness/config.yaml\` is invalid: ${loaded.errors.join('; ')}`);
    const r = raiseLimits(args, loaded.config.pr_size);
    if ('error' in r) return fail(r.error);
    const branch = currentBranch(realGit(root));
    if (branch === null || !plainBranch(branch)) return fail('HEAD is detached or not a plain branch name; check out the branch to raise');
    out(JSON.stringify({ branch, lines: r.lines, files: r.files }));
    return 0;
  } catch (e) {
    return fail(`could not raise: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

export function prSizeEntry(argv: string[], cwd: string, out: (line: string) => void, git?: Git): 0 | 1 | 2 {
  const fail = (error: string): 2 => (out(JSON.stringify({ error })), 2);
  if (argv.includes(RAISE_FLAG)) return raiseEntry(argv, cwd, fail, out);
  const want: { base?: string; head?: string; worktree?: boolean } = {};
  const args = argv.filter((a) => a !== '--pr-size');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worktree') { want.worktree = true; continue; }
    const m = /^--(base|head)(?:=([\s\S]*))?$/.exec(args[i]!);
    if (!m) return fail(USAGE);
    const v = m[2] ?? args[++i];
    if (v === undefined) return fail(USAGE);
    want[m[1] as 'base' | 'head'] = v;
  }
  let root: string, config: ReturnType<typeof loadConfig>['config'], s: ReturnType<typeof measure>;
  try {
    root = repoRoot(cwd);
    const loaded = loadConfig(root);
    if (loaded.errors.length) return fail(`\`.harness/config.yaml\` is invalid: ${loaded.errors.join('; ')}`);
    config = loaded.config;
    s = measure(root, want, config, git ? { git } : {});
  } catch (e) {
    return fail(`could not measure: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); // e.g. not a git repo
  }
  if ('error' in s) return fail(s.error);
  const over = isOver(s, config.pr_size);
  const { target_lines, max_lines, max_files } = config.pr_size;
  out(JSON.stringify({ base: s.base, head: s.head, lines: s.lines, files: s.files, target_lines, max_lines, max_files, over, top: s.top.slice(0, 10), excluded: s.excluded }));
  return over ? 1 : 0;
}
