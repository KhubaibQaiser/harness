// The allowlist for message data (owner ruling, rounds 11-12). A plain-string message, or a `-F -`/`--body-file -`
// stdin heredoc, is data only when every simple command on the line is a known-safe one, with safe options, no
// assignment prefix, and no command substitution anywhere: a list of what can run the text again can never be complete,
// so anything off the list makes the message code.
import { pieces, unquote, words } from '../core/shell-words.js';
import { BARE_REDIRECT, REDIRECT_WORD, SHELLS } from './guard-reruns.js';

/** Commands a message may share a line with: they run no text they are given and write no files. `test`/`[`/`[[`/
 *  `printf` are out (arithmetic, `-v`, `-eq` subscripts evaluate `$(…)`); `cd`/`pushd`/`popd` are out (a relative write
 *  after them lands in `.git/`); `mkdir`/`touch` are out (they create files). */
const SAFE = new Set(['git', 'gh', 'echo', 'true', 'false', 'pwd', 'ls', 'cat']);
/** Keywords and closers that run nothing themselves. `for`, `case` and `select` are not here: their words are not commands. */
const KEYWORDS = new Set(['{', '}', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'fi', 'done']);
/** Readers allowed only as a later pipeline stage, with plain options. */
const PIPE_READERS = new Set(['head', 'tail', 'wc']);
/** Safe only when nothing reads their output. */
const NOT_PIPED = new Set(['echo', 'cat']);
/** Wrappers that exec their argv as is, with their own options. `env` is out: `env VAR=…` sets a variable that can run
 *  the message (GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, BASH_ENV, …), and with no args it is pointless. */
const PLAIN_WRAPPERS = new Set(['command', 'time', 'nice', 'nohup']);

/** A per-command option checker: `short` is the allowed single-dash letters, `long` the allowed `--names`. */
function optionSet(short: string, long: string) {
  return { short: new Set(short.split(' ').filter(Boolean).map((s) => s.replace(/[?].*/, ''))), long: new Set(long.split(' ').filter(Boolean).map((l) => l.replace(/[?:].*/, ''))) };
}
/** git subcommands that run nothing they are given and change no working-tree file (with hooks present, a later
 *  commit would run what checkout, apply, stash, reset and the like wrote), each mapped to the options it may take besides COMMON_GIT. An
 *  option not listed here or in COMMON_GIT makes the message code (reject unknown by default), so a value-running
 *  option (`-O`, `--upload-pack`, `--receive-pack`, `--exec`, `--ext-diff`, `--textconv`, `-s`, …) is never allowed. */
const COMMON_GIT = optionSet('q v p n f', 'quiet verbose dry-run porcelain no-pager color no-color all help no-optional-locks');
const GIT_SUB: Record<string, ReturnType<typeof optionSet>> = {
  add: optionSet('A a u f p n e v i', 'all force dry-run patch update intent-to-add no-ignore-removal pathspec-from-file renormalize ignore-errors'),
  commit: optionSet('a m F C S s q v n o z', 'all message file reuse-message amend no-verify allow-empty allow-empty-message signoff no-signoff no-edit fixup squash only include short long null author date reset-author gpg-sign no-gpg-sign cleanup pathspec-from-file dry-run'),
  push: optionSet('u f n v q d', 'set-upstream force force-with-lease force-if-includes tags follow-tags delete dry-run no-verify atomic all prune porcelain set-upstream-to'),
  fetch: optionSet('f n v q p t a', 'all prune prune-tags tags no-tags depth deepen unshallow force dry-run atomic'),
  tag: optionSet('a s m F f n l d v', 'annotate sign message file force list delete contains no-contains merged no-merged points-at sort column no-sign'),
  notes: optionSet('m F f C', 'message file force reuse-message'),
  log: optionSet('n p q L S G', 'oneline stat shortstat numstat name-only name-status graph decorate no-decorate abbrev-commit no-abbrev-commit pretty format date author committer grep all branches tags remotes reverse merges no-merges first-parent follow since until after before max-count skip color no-color walk-reflogs patch no-patch raw'),
  show: optionSet('q s p', 'oneline stat format pretty name-only name-status abbrev-commit no-patch raw color no-color'),
  diff: optionSet('p q s w b z M C R', 'stat shortstat numstat name-only name-status cached staged no-index color no-color word-diff ignore-space-change ignore-all-space function-context unified no-color-moved patience histogram minimal find-renames find-copies diff-filter'),
  status: optionSet('s b z u v', 'short long porcelain branch show-stash untracked-files ignored no-renames find-renames column no-column'),
  branch: optionSet('a r v l d D f m M q t u', 'all remotes list delete force move copy merged no-merged contains no-contains points-at set-upstream-to unset-upstream track no-track show-current column sort verbose quiet'),
  remote: optionSet('v', 'verbose'),
  'rev-parse': optionSet('q', 'abbrev-ref short verify quiet symbolic symbolic-full-name show-toplevel git-dir is-inside-work-tree show-prefix show-cdup default'),
  'cat-file': optionSet('p t s e', 'batch batch-check allow-unknown-type'),
  'ls-files': optionSet('z c d m o s t u k', 'cached deleted modified others stage unmerged killed exclude-standard full-name error-unmatch'),
  blame: optionSet('L w s e p M C', 'line-porcelain porcelain incremental show-stats root abbrev'),
  describe: optionSet('', 'tags all contains abbrev long always dirty broken match exclude first-parent'),
  shortlog: optionSet('n s e w', 'numbered summary email committer group no-merges'),
  grep: optionSet('n l L i w v c e E F P', 'line-number files-with-matches files-without-match ignore-case word-regexp invert-match count extended-regexp fixed-strings perl-regexp cached no-index untracked recurse-submodules name-only context before-context after-context color no-color and or not all-match'),
  gc: optionSet('', 'aggressive auto prune no-prune quiet force'),
  reflog: optionSet('n', 'all stale-fix expire expire-unreachable verbose'),
  'rev-list': optionSet('n', 'all branches tags remotes count max-count reverse merges no-merges first-parent since until before after objects pretty format oneline'),
  'symbolic-ref': optionSet('q m d', 'short quiet delete'),
  'update-ref': optionSet('d m', 'create-reflog no-deref stdin'),
  'ls-remote': optionSet('t h q', 'heads tags refs get-url symref exit-code sort'),
};

const GH_SAFE = new Set(['pr', 'issue', 'release', 'repo', 'run', 'workflow', 'api', 'status', 'label', 'search', 'browse']);
/** gh repo subcommands that wrap `git clone` and so take git's pass-through options. */
const GH_REPO_DANGER = new Set(['clone', 'fork']);
/** The options a gh line may take on a message line, rejecting unknown by default the way git's table does, so a gh
 *  option that takes a command or a file it runs can never slip through. `--input`/`-i` (reads a request body file) and
 *  a `--` pass-through to a wrapped git command are absent, so rejected. */
const GH_OPT = optionSet(
  'R t b F d w a l L B H j q s f c X p',
  'repo title body body-file notes notes-file notes-start-tag draft prerelease latest web fill fill-first base head assignee label milestone project reviewer ' +
    'json jq template slurp paginate squash merge rebase delete-branch auto admin disable-auto subject state author app comments limit search sort order ' +
    'json-fields method field raw-field header hostname cache include verbose yes confirm force-with-lease recurse-submodules',
);

/** A plain path: no glob, `$'`, quote or space. Only such a `-C dir` keeps a git command safe on a message line. */
const PLAIN_PATH = /^[\w./~@:+,=%-]+$/;
/** A write target that can turn a message into git config or a hook: anything under `.git/`, a gitconfig, `.husky/`,
 *  `.githooks/` or a `hooks/` dir, or a target the guard cannot read literally (a glob, `$'`). git reads these on its
 *  next run, so git output written there runs even with no message (re-review 11-12). */
const SENSITIVE_WRITE = /(?:^|\/)\.git(?:\/|$)|(?:^|\/)\.?gitconfig$|(?:^|\/)git\/config$|(?:^|\/)\.?(?:husky|githooks)(?:\/|$)|(?:^|\/)hooks(?:\/|$)|[*?[]|\$'/;
/** Every file an output or read-write redirect of a command sends stdout to, each stripped of a leading `&`. A bare fd
 *  dup (`2>&1`, `>&2`) names a number, not a file, and is left out. Covers `>`, `>>`, `>|`, `>!`, `>>!`, `>&`, `&>`,
 *  `&>>`, `<>`, glued or spaced, with any fd number. */
function writeTargets(ws: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const m = /^(?:\d*|&)?(?:>>?[|!]?|>&|&>>?|<>)(.*)$/.exec(ws[i]);
    if (!m) continue;
    const t = (m[1] || ws[++i] || '').replace(/^&/, '');
    if (!/^\d+$/.test(t)) out.push(t);
  }
  return out;
}

const named = (set: { long: Set<string> }, o: string) => set.long.has(o.replace(/^--/, '').replace(/=.*/, ''));

/** True when every option token in `opts` is allowed for a git subcommand (COMMON_GIT plus the subcommand's own). A
 *  non-option word ends the options we must vet; `--` ends options; `-N` is a count shorthand. */
function gitOptionsOk(sub: string, opts: string[]): boolean {
  const set = GIT_SUB[sub];
  if (!set) return false;
  for (const o of opts) {
    if (o === '--') break;
    if (!o.startsWith('-') || /^-\d+$/.test(o)) continue; // a count shorthand (`git log -1`, `-5`) runs nothing
    if (o.startsWith('--')) {
      if (!named(COMMON_GIT, o) && !named(set, o)) return false;
    } else if (![...o.slice(1).replace(/=.*/, '')].every((ch) => COMMON_GIT.short.has(ch) || set.short.has(ch))) return false;
  }
  return true;
}

/** git's safe global options and the index of the subcommand after them, or -1 when a global can run a command (`-c`
 *  other than user.name/email, `--config-env`, `--exec-path`, `-O`, `--open-files-in-pager`). */
function gitSubcommand(a: string[]): number {
  let i = 0;
  for (; a[i]?.startsWith('-'); i++) {
    const o = a[i];
    if (o === '-c') {
      if (!/^user\.(?:name|email)=/.test(a[i + 1] ?? '')) return -1;
      i++;
      continue;
    }
    if (o === '-C') { if (!PLAIN_PATH.test(a[i + 1] ?? '')) return -1; i++; continue; } // a non-plain -C dir may hide a glob or $'
    if (/^(?:-O|--open-files-in-pager|--exec-path|--config-env|--config|-c.|--git-dir|--work-tree|--namespace)/.test(o)) return -1;
  }
  return i;
}
/** gh's safe global options and the index of the subcommand after them. */
function ghSubcommand(a: string[]): number {
  let i = 0;
  for (; a[i]?.startsWith('-'); i++) if (a[i] === '-R' || a[i] === '--repo') i++;
  return i;
}
/** True when every option token on a gh line is in GH_OPT (reject unknown by default); `--` and unknown make it code. */
function ghOptionsOk(rest: string[]): boolean {
  for (const o of rest) {
    if (!o.startsWith('-')) continue;
    if (o === '--') return false;
    if (o.startsWith('--')) {
      if (!named(GH_OPT, o)) return false;
    } else if (![...o.slice(1).replace(/=.*/, '')].every((ch) => GH_OPT.short.has(ch))) return false;
  }
  return true;
}

/** True when the command whose words are `ws`, from `k`, is safe: past keywords, redirects and plain wrappers to a
 *  command on SAFE with safe options, with no assignment prefix anywhere (an assignment can run the message). */
function safeCommand(ws: string[], k: number, pipedIn: boolean, pipedOut: boolean): boolean {
  for (;;) {
    while (k < ws.length && (KEYWORDS.has(ws[k]) || REDIRECT_WORD.test(ws[k]))) k += BARE_REDIRECT.test(ws[k]) ? 2 : 1;
    if (k >= ws.length) return true;
    if (/^\w+=/.test(ws[k])) return false; // GIT_SSH_COMMAND=…, LD_PRELOAD=…: a variable that can run the message
    if (!PLAIN_WRAPPERS.has(ws[k])) break;
    const w = ws[k++];
    while (ws[k]?.startsWith('-')) k += w === 'nice' && ws[k] === '-n' ? 2 : 1;
  }
  if (writeTargets(ws).some((t) => t !== '/dev/null')) return false; // any file write makes the message code
  const name = ws[k], rest = ws.slice(k + 1);
  if (PIPE_READERS.has(name)) return pipedIn && rest.every((o) => /^-?[A-Za-z0-9]+$/.test(o));
  if (!SAFE.has(name) || (NOT_PIPED.has(name) && pipedOut)) return false;
  if (name === 'git') {
    const s = gitSubcommand(rest), sub = rest[s] ?? '';
    if (sub === 'remote' && rest.slice(s + 1).some((w) => !w.startsWith('-'))) return false; // remote add/set-url write config
    return s >= 0 && gitOptionsOk(sub, rest.slice(s + 1));
  }
  if (name === 'gh') {
    const s = ghSubcommand(rest), sub = rest[s] ?? '';
    return GH_SAFE.has(sub) && !(sub === 'repo' && GH_REPO_DANGER.has(rest[s + 1] ?? '')) && ghOptionsOk(rest.slice(s + 1));
  }
  return true;
}

/** True when every simple command of `cmd` (heredoc bodies taken out) is on the safe list, and nothing substitutes a
 *  command. Single quotes are stripped first, so a literal `$(…)` in a quoted message stays data; the one way a
 *  single-quoted `$(…)` runs is inside `test`/`[`/`[[`/`((`/`printf -v`, none of which are safe commands anyway. A
 *  `${…}` or `$[…]` does not quote its single quotes (`${x:'$(…)'}`, `$[ 'a[$(…)]' ]`), so either makes the line code. */
export function onlySafeCommands(cmd: string): boolean {
  if (/\$\(|`|[<>]\(|\$\{|\$\[/.test(cmd.replace(/'[^']*'/g, "''"))) return false;
  const ps = pieces(cmd);
  // A redirect after `}`, `)`, `done`, `fi` or `esac` writes for every command in the group: count every write on the line.
  if (ps.some((p) => writeTargets(words(p.text).map(unquote)).some((t) => t !== '/dev/null'))) return false;
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
    const ws = words(p.text).map(unquote), k = commandWord(ws), name = ws[k] ?? '';
    const next = ps[i + 1] ? words(ps[i + 1].text).map(unquote) : [];
    const toFile = ws.some((w) => /^(?:\d*|&)>/.test(w)) || (p.sep === '|' && next[commandWord(next)] === 'tee');
    if (name === 'git') {
      const s = gitSubcommand(ws.slice(k + 1));
      if (s >= 0 && GIT_OUTPUT.has(ws.slice(k + 1)[s] ?? '') && toFile) writes = true;
    }
    const base = name.split('/').pop()!, chmodX = base === 'chmod' && ws.some((w) => /^[ugoa]*\+[rwX]*x/.test(w));
    if (SHELLS.has(base) || base === 'source' || name === '.' || /^\.{0,2}\//.test(name) || chmodX) runs = true;
  });
  return writes && runs;
}
/**
 * True when the line writes git's output (`git log`, `show`, `rev-parse` or `cat-file`) into a sensitive path (see
 * SENSITIVE_WRITE), with `>`, `>>` or `| tee`: git then reads an earlier message back as config or a hook on its next
 * run. Always blocked, like writesGitOutputAndRunsFile.
 */
export function writesGitOutputToSensitivePath(cmd: string): boolean {
  return pieces(cmd).some((p, i, ps) => {
    const ws = words(p.text).map(unquote), k = commandWord(ws);
    if (ws[k] !== 'git') return false;
    const s = gitSubcommand(ws.slice(k + 1));
    if (s < 0 || !GIT_OUTPUT.has(ws.slice(k + 1)[s] ?? '')) return false;
    const next = ps[i + 1] ? words(ps[i + 1].text).map(unquote) : [];
    const teed = p.sep === '|' && next[commandWord(next)] === 'tee' ? writeTargets(next).concat(next.slice(1).filter((w) => !w.startsWith('-'))) : [];
    // A group's own redirect (`{ git log …; } >> .git/config`) sits in a later piece that runs no command.
    const grouped = ps.slice(i + 1).filter((q) => { const qs = words(q.text).map(unquote); return commandWord(qs) >= qs.length; });
    const groupTargets = grouped.flatMap((q) => writeTargets(words(q.text).map(unquote)));
    return writeTargets(ws).concat(teed, groupTargets).some((t) => SENSITIVE_WRITE.test(t));
  });
}
/** The command word past keywords, assignments and redirections (writesGitOutputAndRunsFile tolerates assignments). */
function commandWord(ws: string[]): number {
  let k = 0;
  while (k < ws.length && (KEYWORDS.has(ws[k]) || /^\w+=/.test(ws[k]) || REDIRECT_WORD.test(ws[k]))) k += BARE_REDIRECT.test(ws[k]) ? 2 : 1;
  return k;
}
