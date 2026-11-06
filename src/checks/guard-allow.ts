// The allowlist for message data (owner ruling, round 11). A plain-string message, or a `-F -`/`--body-file -` stdin
// heredoc, is data only when every simple command on the line is a known-safe one: a list of what can run the text
// again can never be complete (trap, strace, `pnpm --silent exec`, direnv exec, …), so anything else makes it code.
import { pieces, unquote, words } from '../core/shell-words.js';
import { commandWordAt, SHELLS } from './guard-reruns.js';

/** Commands a message may share a line with: they run no text they are given. */
const SAFE = new Set(['git', 'gh', 'cd', 'pushd', 'popd', 'echo', 'printf', 'true', 'false', 'test', '[', '[[', 'pwd', 'ls', 'cat', 'mkdir', 'touch']);
/** Keywords and closers that run nothing themselves. `for`, `case` and `select` are not here: their words are not commands. */
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done']);
/** Readers allowed only as a later pipeline stage, with plain options. */
const PIPE_READERS = new Set(['head', 'tail', 'wc']);
/** Safe only when nothing reads their output. */
const NOT_PIPED = new Set(['echo', 'printf', 'cat']);
/** Wrappers that exec their argv as is, with their own options: `time -p`, `nice -n N`, `command -p`, `env VAR=…`. */
const PLAIN_WRAPPERS = new Set(['command', 'env', 'time', 'nice', 'nohup']);
/** git subcommands that run nothing they are given. Not config, rebase, bisect, submodule, an alias, … */
const GIT_SAFE = new Set(['add', 'commit', 'push', 'pull', 'fetch', 'status', 'diff', 'log', 'show', 'branch', 'checkout', 'switch',
  'restore', 'reset', 'merge', 'tag', 'notes', 'stash', 'rm', 'mv', 'init', 'clone', 'remote', 'rev-parse', 'cat-file', 'ls-files', 'blame',
  'describe', 'shortlog', 'cherry-pick', 'revert', 'grep', 'am', 'apply', 'format-patch', 'worktree', 'gc', 'reflog', 'clean', 'rev-list',
  'symbolic-ref', 'update-ref', 'ls-remote']);
const GH_SAFE = new Set(['pr', 'issue', 'release', 'repo', 'run', 'workflow', 'api', 'status', 'label', 'search', 'browse']);
/** git's global options that take the next word. Only `-c user.*` is a safe config value. */
const GIT_VALUE = /^(?:-C|-c|--git-dir|--work-tree|--namespace)$/;

/** The subcommand of git or gh past its global options, or null when an option is not a plain one. */
function subcommand(cmd: string, a: string[]): string | null {
  let i = 0;
  for (; a[i]?.startsWith('-'); i++) {
    if (cmd === 'git' && (a[i] === '-c' ? !/^user\.(?:name|email)=/.test(a[i + 1] ?? '') : /^--(?:config-env|exec-path)|^-c./.test(a[i]))) return null;
    if ((cmd === 'git' && GIT_VALUE.test(a[i])) || (cmd === 'gh' && (a[i] === '-R' || a[i] === '--repo'))) i++;
  }
  return a[i] ?? null;
}

/** True when `ws` from `k` is a safe command, given whether a pipe comes before and after it. */
function safeCommand(ws: string[], k: number, pipedIn: boolean, pipedOut: boolean): boolean {
  for (;;) {
    k = commandWordAt(ws, k, KEYWORDS);
    if (k >= ws.length) return true;
    if (!PLAIN_WRAPPERS.has(ws[k])) break;
    const w = ws[k++];
    if (w === 'env') { if (ws[k]?.startsWith('-')) return false; continue; } // env -i, -S, -u: not plain
    while (ws[k]?.startsWith('-')) k += w === 'nice' && ws[k] === '-n' ? 2 : 1;
  }
  const name = ws[k], rest = ws.slice(k + 1);
  if (PIPE_READERS.has(name)) return pipedIn && rest.every((o) => /^-?[A-Za-z0-9]+$/.test(o));
  if (!SAFE.has(name) || (NOT_PIPED.has(name) && pipedOut)) return false;
  if (name === 'git') return GIT_SAFE.has(subcommand('git', rest) ?? '');
  if (name === 'gh') return GH_SAFE.has(subcommand('gh', rest) ?? '');
  return true;
}

/** True when every simple command of `cmd` (heredoc bodies taken out) is on the safe list, and nothing on the line
 *  substitutes a command (`$(…)`, a backtick, `<(…)`): those run commands too. */
export function onlySafeCommands(cmd: string): boolean {
  if (/\$\(|`|[<>]\(/.test(cmd.replace(/'[^']*'/g, "''"))) return false;
  const ps = pieces(cmd);
  return ps.every((p, i) => safeCommand(words(p.text).map(unquote), 0, i > 0 && ps[i - 1].sep === '|', p.sep === '|'));
}

/** git output that can be written to a file, and the words that run a file. */
const GIT_OUTPUT = new Set(['log', 'show', 'rev-parse', 'cat-file']);
/**
 * True when the line writes git's output to a file (`git log …`, `show`, `rev-parse` or `cat-file` with `>`, `>>` or
 * piped to `tee`) and also runs a file (`sh`, `bash`, `source`, `.`, `./x`, `chmod +x`): a message from an earlier
 * commit can become the script (`git log -1 --format=%B > x.sh; sh x.sh`). Always blocked.
 */
export function writesGitOutputAndRunsFile(cmd: string): boolean {
  const ps = pieces(cmd);
  let writes = false, runs = false;
  ps.forEach((p, i) => {
    const ws = words(p.text).map(unquote), k = commandWordAt(ws), name = ws[k] ?? '';
    const next = ps[i + 1] ? words(ps[i + 1].text).map(unquote) : [];
    const toFile = ws.some((w) => /^(?:\d*|&)>/.test(w)) || (p.sep === '|' && next[commandWordAt(next)] === 'tee');
    if (name === 'git' && GIT_OUTPUT.has(subcommand('git', ws.slice(k + 1)) ?? '') && toFile) writes = true;
    const base = name.split('/').pop()!, chmodX = base === 'chmod' && ws.some((w) => /^[ugoa]*\+[rwX]*x/.test(w));
    if (SHELLS.has(base) || base === 'source' || name === '.' || /^\.{0,2}\//.test(name) || chmodX) runs = true;
  });
  return writes && runs;
}
