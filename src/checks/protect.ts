// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import nodePath, { resolve } from 'node:path';
import picomatch from 'picomatch';
import { matches, TASKS_DIR, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { editTarget, isShell } from '../hooks/edit-target.js';
import { becomesDecision, codeNames, decisionRoutes, decisionsDeny, editorAsk, editorFiles, globHits } from './decisions-protect.js';
import type { Decision } from '../hooks/types.js';
import { commandStart, decodeAnsiC, EXPANDS, fileWriteTargets, gitArgs, ifsReading, lexLine, MAX_SHELL_NESTING, NESTING_WHY, PROTECTED_TEXT, quoteFree, rmTargets, shellNesting, targetDir, withoutHeredocBodies, WRITER_ALIAS } from './guard.js';
import { balanced, commandName, cPayloads, remember, segments, SHELLS, stdinPrograms, unquote, withWorkBudget, words } from '../core/shell-words.js';
import { SAFE_DIFF, SAFE_GIT } from '../core/git-safe.js';
import { type OptTable, readOptions, valuesOf } from '../core/options.js';
import { globGuardAsk, guardedPaths, plainHeads, wrapperForms } from '../core/command-head.js';
import { GIT_CMDS } from './gh-writes.js';

export const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/logs/**', '.harness/backup/**', '.harness/results/**', '.harness/reviews/**', `${TASKS_DIR}/**`, '.harness/config.yaml', '.harness/manifest.json', '.harness/apply.lock', '.harness/tmp', '.harness/tmp/**', '.claude/settings.json', '.claude/settings.local.json'];
const PROTECTED_CONCRETE = ['.harness', '.harness/hooks', '.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/state', '.harness/state/tdd-pause.json', '.harness/logs', '.harness/logs/events.jsonl', '.harness/backup', '.harness/results', '.harness/reviews', TASKS_DIR, '.harness/config.yaml', '.harness/manifest.json', '.harness/apply.lock', '.harness/tmp', '.harness/tmp/.gitignore', '.claude', '.claude/settings.json', '.claude/settings.local.json'];
/**
 * Protected paths the sandbox leaves writable, because the agent's own Bash writes them through harness (protect still
 * guards them as text):
 * - `.harness/tmp`: the skills' work folders (`harness workdir`);
 * - `.harness/logs`: the event log every harness command appends to;
 * - `.harness/results`: the TDD reporter's output. The agent's test run (`npm test` in its sandboxed Bash) writes it;
 *   denied, every red-first check would find no results and the TDD gates would block all edits;
 * - `.harness/reviews`: the review CLI (`harness review`) writes its records from the agent's Bash; denied, it fails
 *   with EPERM. protect's text check and the Edit deny rule still guard it.
 */
export const DENY_WRITE_SKIPPED = ['.harness/tmp', '.harness/logs', '.harness/results', '.harness/reviews'];
/** Claude Code's `sandbox.filesystem.denyWrite` for harness, from protect's table: each protected path (a `/**` folder
 *  as the folder), `./`-relative, minus DENY_WRITE_SKIPPED. A path added to PROTECTED is denied by the sandbox too. */
export const denyWritePaths = (table: readonly string[] = PROTECTED): string[] => [
  ...new Set(table.map((g) => g.replace(/\/\*\*$/, '')).filter((p) => !DENY_WRITE_SKIPPED.some((s) => p === s || p.startsWith(`${s}/`))).map((p) => `./${p}`)),
];
/** Extra paths the Stop gate's srt fence denies writes to, beyond protect's table (P5 extends this). */
export const STOP_PROTECTED_EXTRA = ['.claude/hooks', '.claude/skills', '.devcontainer', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
export const stopDenyWritePaths = (): string[] => [...new Set([...denyWritePaths(), ...STOP_PROTECTED_EXTRA.map((p) => `./${p}`)])];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';
const NM_REASON = 'node_modules is managed by the package manager, not edited by hand: change package.json and run an install instead.';
const INLINE_WHY = 'Inline code (node -e, python -c and the like) that names';
const NM_INLINE = `${INLINE_WHY} node_modules is denied: it may write there, and a text match cannot tell a read from a write. node_modules is managed by the package manager: change package.json and run an install instead.`;
const H_INLINE = `${INLINE_WHY} harness files or Claude settings is denied: it may write them, and a text match cannot tell a read from a write. ${REASON}`;
// Owner rule: nobody edits node_modules directly. Installs still go through the guard's install gate.
const inNodeModules = (root: string, p: string): boolean => !!toRepoPath(root, p)?.toLowerCase().split('/').includes('node_modules');

// Kept per text (round 28): expand and each target reader ask it of the same commands. Callers must not mutate it.
const segTokens = remember((cmd: string): string[][] =>
  cmd.split(/[;&|\n]+/).map((seg) => [...(seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])].map((t) => t.replace(/^['"]|['"]$/g, ''))));

// The command plus the strings of any bash|sh|zsh -c inside it, recursively.
function expand(cmd: string): string[] {
  const out = [cmd];
  for (const toks of segTokens(cmd)) {
    const k = toks.findIndex((t) => /^(ba|z|da)?sh$/.test(t));
    const c = toks.findIndex((t, i) => i > k && /^-[a-z]*c$/.test(t));
    if (k >= 0 && c > 0 && toks[c + 1]) out.push(...expand(toks[c + 1]));
  }
  return out;
}

/**
 * The folders `cd` and `pushd` move to in one command line, each from the one before (re-review): later relative paths
 * land there. null when one can't be resolved (`$X`, `-`, `~`, a glob, no argument). ponytail: a union, not an order:
 * every relative path is read from the root and from each folder, and `popd` is not followed (stricter only).
 */
function cdDirs(cmds: string[]): string[] | null {
  const out: string[] = [];
  let at = '.';
  for (const all of cmds.flatMap(segTokens)) {
    const toks = /^[({]*(builtin|command)$/.test(all[0] ?? '') ? all.slice(1) : all; // builtin cd / command cd are a cd
    if (!/^[({]*(cd|pushd)$/.test(toks[0] ?? '')) continue;
    const arg = toks.slice(1).find((t) => t !== '--' && !/^-[LPe@]+$/.test(t))?.replace(/[)}]+$/, '');
    if (!arg || arg === '-' || arg.startsWith('~') || /[$`*?[{\\]/.test(arg)) return null; // a ~ mid-word (RUNNER~1) is literal
    at = nodePath.isAbsolute(arg) ? arg : nodePath.posix.join(at, arg);
    out.push(at);
  }
  return out;
}
const CD_REASON = "The command changes to a folder protect can't resolve ($X, -, ~ or no folder), so it can't tell where its writes land. Confirm the command.";
const EDITOR_PROTECTED_REASON = 'An editor run by the agent writes the file itself, and this is a harness file or a Claude settings file. Confirm only if the person asked for this edit.';
const relative = (ps: string[]): string[] => ps.filter((p) => p && !nodePath.isAbsolute(p));
const fromDirs = (dirs: string[], ps: string[]): string[] => [...ps, ...dirs.flatMap((d) => relative(ps).map((p) => nodePath.posix.join(d, p)))];

// mv: every path (source and destination); cp: the destination. ponytail: ignores -t DIR; splits on ; & | even inside quotes.
function moveCopyTargets(cmds: string[]): { mv: string[]; cp: string[] } {
  const r = { mv: [] as string[], cp: [] as string[] };
  for (const toks of cmds.flatMap(segTokens)) {
    const named = (t: string) => WRITER_ALIAS[t] ?? t; // gcp/gmv; a path-qualified /bin/cp is read by the plain-head reading, not here
    const i = toks.findIndex((t) => named(t) === 'mv' || named(t) === 'cp');
    if (i < 0) continue;
    const bucket = named(toks[i]) === 'mv' ? r.mv : r.cp;
    const dir = targetDir(toks.slice(i + 1)); // -t DIR / --target-directory: that folder is written
    if (dir !== null) { bucket.push(dir); continue; }
    const args = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    if (named(toks[i]) === 'mv') bucket.push(...args);
    else bucket.push(...args.slice(-1));
  }
  return r;
}

// git checkout/restore paths. Without "--", checkout's first non-flag arg is a ref (or a branch being switched to).
function gitRestoreTargets(cmds: string[]): string[] {
  const out: string[] = [];
  for (const toks of cmds.flatMap(segTokens)) {
    const [sub, ...rest] = gitArgs(toks);
    if (sub !== 'checkout' && sub !== 'restore') continue;
    const d = rest.indexOf('--');
    const plain = rest.filter((t) => !t.startsWith('-'));
    // "git checkout ." has no ref; with two or more args the first may be one, or a file when it isn't a ref: read both ways.
    out.push(...(d >= 0 ? rest.slice(d + 1) : plain));
  }
  return out;
}

/**
 * What one git command changes in the worktree, as `git diff --name-only [from [to]] -- paths` reads it: `from` alone is
 * that tree against the worktree, neither is the index against the worktree; `untracked` is a stash's untracked tree.
 * `sw` is a checkout/switch whose first word may be a ref or a file; `fail` is a form harness can't check first.
 */
type Diff = { from?: string; to?: string; paths?: string[]; untracked?: string };
type Move = { dir: string; diffs: Diff[]; sw?: { ref: string; sw: boolean; paths: string[] } } | { dir: string; fail: 'unknown' | 'pull' };
// Plain named paths are judged by the direct-write rule (gitRestoreTargets); git reads magic (`:(exclude)src`) and globs
// (`*.yaml` matches `.harness/config.yaml`) itself, so those are diffed.
const SPEC_MAGIC = /^:|[*?[]/;
const MOVERS = new Set(['checkout', 'switch', 'restore', 'reset', 'merge', 'rebase', 'cherry-pick', 'revert', 'stash', 'read-tree', 'checkout-index', 'pull', 'am']);
// Positional words, past options whose value is the next word. A bare `-` is the previous branch.
const positional = (args: string[], value?: RegExp): string[] => {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (value?.test(args[i]!)) i += 1;
    else if (args[i] === '-') pos.push('@{-1}');
    else if (!args[i]!.startsWith('-')) pos.push(args[i]!);
  }
  return pos;
};
// Grouping around a command (`(git …)`, `{ git …; }`, `! git …`) is not one of its words.
const ungrouped = (toks: string[]): string[] => {
  const t = toks.map((w, i) => (i === 0 ? w.replace(/^[({!]+/, '') : w));
  const last = t.length - 1, w = t[last] ?? '';
  if (w.split(')').length > w.split('(').length) t[last] = w.replace(/\)+$/, '');
  return t.filter(Boolean);
};
/** True when `sub` is a git alias here, or the lookup fails or times out. git ignores an alias named like a builtin. */
const aliased = (dir: string, sub: string): boolean => {
  if (!/^[A-Za-z0-9][\w-]*$/.test(sub)) return false; // no alias has this name: git can't run it as one
  const r = git(dir, ['config', '--get', `alias.${sub}`]);
  return !(r.status === 1 && !r.stderr && !r.error);
};
// ponytail: checkout's remote-tracking DWIM (`git checkout foo` with only origin/foo) reads as a file checkout.
function refMove(raw: string[], cwd: string): Move | null {
  const toks = ungrouped(raw);
  let j = 0;
  while (j < toks.length && /^\w+=/.test(toks[j]!)) j += 1; // VAR=value before the command
  const [sub, ...rest] = gitArgs(toks), k = toks.indexOf('git');
  let dir = cwd;
  for (let i = k + 1; toks[i]?.startsWith('-'); i += /^-[Cc]$/.test(toks[i]!) ? 2 : 1) if (toks[i] === '-C') dir = resolve(dir, toks[i + 1] ?? '');
  const unknown: Move = { dir, fail: 'unknown' };
  // A head built at run time ($(which git), $G) may be git.
  if (/[$`]/.test(toks[j] ?? '') && toks.some((t) => MOVERS.has(t))) return unknown;
  if (!sub) return null;
  // Global options that change config, the git programs run, the repo, the worktree or the refs git reads.
  const odd = toks.slice(k + 1, toks.length - rest.length - 1).some((g) => /^(-c|--config-env|--exec-path|--git-dir|--work-tree|--namespace)/.test(g));
  if (!MOVERS.has(sub)) return !GIT_CMDS.has(sub) && (odd || aliased(dir, sub)) ? unknown : null; // an alias may run a mover
  // git run by another command (env, command, exec, sudo, xargs …) may get more words or another environment.
  if (k !== j || odd) return unknown;
  // Expansions, another git dir or worktree, and words git reads past its options or from a file are not followed.
  if (toks.some((t) => /[$`\\]|\{[^}]*(,|\.\.)|^~|^GIT_\w+=|^--pathspec-from-file|^--stdin$|^--end-of-options$/.test(t))) return unknown;
  const has = (re: RegExp) => rest.some((t) => re.test(t));
  const dd = rest.indexOf('--'), opts = dd < 0 ? rest : rest.slice(0, dd), after = dd < 0 ? [] : rest.slice(dd + 1);
  if (sub === 'pull') return { dir, fail: 'pull' };
  if (sub === 'am') return unknown;
  // A paused merge, rebase or sequencer goes on from state files the agent can write.
  if (/^(merge|rebase|cherry-pick|revert)$/.test(sub) && has(/^--(continue|skip|abort)$/)) return unknown;
  if (has(/^--(quit|show-current-patch|edit-todo)$/)) return null;
  switch (sub) {
    case 'checkout': case 'switch': {
      const pos = positional(opts, /^(-[a-zA-Z]*[bBcC]|--orphan)$/); // value is the new branch name (also in a cluster: -fb x)
      if (dd >= 0 && after.length) return pos.length > 1 ? unknown : after.some((p) => SPEC_MAGIC.test(p)) ? { dir, diffs: [{ from: pos[0], paths: after }] } : null;
      if (dd >= 0 && pos.length > 1) return unknown; // `<ref> --` with nothing after is a move to <ref>
      if (!pos.length) return has(/^(-f|--force|--discard-changes)$/) ? { dir, diffs: [{ from: 'HEAD' }] } : null;
      if (sub === 'switch' && pos.length > 1) return unknown;
      return pos.length > 1 && !pos.some((p) => SPEC_MAGIC.test(p)) ? null : { dir, diffs: [], sw: { ref: pos[0]!, sw: sub === 'switch', paths: pos.slice(1) } };
    }
    case 'restore': {
      const staged = has(/^(--staged|-S|-SW|-WS)$/), worktree = has(/^(--worktree|-W|-SW|-WS)$/);
      const s = opts.findIndex((t) => t === '-s' || t === '--source');
      const src = s >= 0 ? opts[s + 1] : opts.find((t) => /^(--source=|-s.)/.test(t))?.replace(/^--source=|^-s/, '');
      const paths = [...positional(opts, /^(-s|--source)$/), ...after];
      return (staged && !worktree) || !paths.some((p) => SPEC_MAGIC.test(p)) ? null : { dir, diffs: [{ from: src ?? (staged ? 'HEAD' : undefined), paths }] };
    }
    case 'reset': {
      if (!has(/^--(hard|keep|merge)$/)) return null; // --soft and a plain reset leave the worktree alone
      const pos = positional(opts);
      return dd >= 0 || pos.length > 1 ? unknown : { dir, diffs: [{ from: pos[0] ?? 'HEAD' }] };
    }
    case 'merge': {
      const pos = positional(opts, /^(-[mFsX]|--(message|file|strategy|strategy-option|into-name|cleanup))$/);
      return { dir, diffs: (pos.length ? pos : ['@{upstream}']).map((r) => ({ from: `HEAD...${r}` })) }; // what each side brings in since the merge base
    }
    case 'cherry-pick': case 'revert': {
      const pos = positional(opts, /^(-X|--strategy|--strategy-option|--cleanup)$/);
      if (has(/^(-m|--mainline)/) || !pos.length || pos.some((r) => /\.\.|\^[!@-]/.test(r))) return unknown; // a range or another parent
      return { dir, diffs: pos.map((r) => ({ from: `${r}^`, to: r })) };
    }
    case 'rebase': {
      if (has(/^(-i|--interactive|-x|--exec|--root|-r|--rebase-merges)(=|$)/)) return unknown;
      const o = opts.indexOf('--onto'), onto = o >= 0 ? opts[o + 1] : opts.find((t) => t.startsWith('--onto='))?.slice(7);
      const pos = positional(opts, /^(--onto|-s|--strategy|-X|--strategy-option)$/);
      if (pos.length > 1) return unknown; // `rebase <upstream> <branch>` checks out the branch first
      return { dir, diffs: [onto ? { from: 'HEAD', to: onto } : { from: `HEAD...${pos[0] ?? '@{upstream}'}` }] };
    }
    case 'stash': {
      const [op, ...args] = rest;
      if (op === 'apply' || op === 'pop') {
        const pos = positional(args.filter((t) => t !== '--'));
        const ref = /^\d+$/.test(pos[0] ?? '') ? `stash@{${pos[0]}}` : pos[0] ?? 'stash@{0}';
        return pos.length > 1 ? unknown : { dir, diffs: [{ from: `${ref}^1`, to: ref }, { untracked: ref }] };
      }
      if (op === 'branch') return unknown;
      if (op !== undefined && op !== 'push' && op !== 'save' && !op.startsWith('-')) return null; // list, show, drop, create, store, clear
      // A push resets the worktree to HEAD; -u and -a also remove untracked and ignored files.
      return has(/^(-[a-zA-Z]*[ua][a-zA-Z]*|--include-untracked|--all)$/) ? unknown : { dir, diffs: [{ from: 'HEAD' }] };
    }
    case 'read-tree': {
      if (!has(/^-[a-zA-Z]*u[a-zA-Z]*$/)) return null; // without -u only the index changes
      const pos = positional(opts);
      return pos.length !== 1 || has(/^--(prefix|empty)/) ? unknown : { dir, diffs: [{ from: pos[0] }] };
    }
    default: { // checkout-index
      if (has(/^--(prefix|temp)/)) return unknown;
      const paths = [...positional(opts), ...after];
      return has(/^(-[a-zA-Z]*a[a-zA-Z]*|--all)$/) ? { dir, diffs: [{}] } : paths.length ? { dir, diffs: [{ paths }] } : null;
    }
  }
}

const git = (dir: string, args: string[]) => spawnSync('git', [...SAFE_GIT, ...args], { cwd: dir, encoding: 'utf8', timeout: 1500 });
// protect's table as git pathspecs from the repo top, case-insensitive (macOS and Windows checkouts ignore case).
const PROTECTED_SPECS = [...new Set(PROTECTED.map((g) => g.replace(/\/\*\*$/, '')))].map((p) => `:(top,icase)${p}`);
/** The protected files a diff changes, or null when git fails, times out or a ref doesn't resolve. */
function protectedChanges(dir: string, d: Diff): string[] | null {
  let r;
  if (d.untracked !== undefined) {
    const rp = git(dir, ['rev-parse', '-q', '--verify', `${d.untracked}^3`]); // not ^3^{commit}: git 2.46 resolves that to the stash itself
    if (rp.status === 1) return []; // no untracked part
    if (rp.status !== 0 || rp.error) return null;
    r = git(dir, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', `${d.untracked}^3`]);
  } else {
    const revs = [d.from, d.to].filter((x): x is string => !!x);
    r = git(dir, ['-c', 'diff.relative=false', 'diff', ...SAFE_DIFF, '--no-renames', '--name-only', '-z', ...revs, '--', ...(d.paths ?? PROTECTED_SPECS)]);
  }
  return r.status === 0 && !r.error ? r.stdout.split('\0').filter((n) => n && matches(n.toLowerCase(), PROTECTED)) : null;
}

const UNATTENDED_GIT = "Unattended runs can't change harness's protected files through git; the person runs it.";
/**
 * Git commands that move the worktree to another ref (checkout, switch, restore, reset --hard, merge, rebase, cherry-pick,
 * revert, stash, read-tree -u, checkout-index) ask when they change a protected file, and deny unattended. A switch to a
 * ref with no .harness/hooks/dispatch.mjs asks too: every hook would then fail open until someone switches back. Any
 * error, an unread form, or another command before it on the line (it may move refs first) fails closed.
 */
function refMoveAsk(cmds: string[], cwd: string, unattended: boolean): Decision | null {
  const ask = (reason: string): Decision => ({ kind: 'ask', reason, check: 'protect' });
  const say = (why: string, tail = UNATTENDED_GIT): Decision => (unattended ? { kind: 'deny', reason: `${why} ${tail}`, check: 'protect' } : ask(`${why} Confirm it.`));
  let busy = false;
  for (const toks of cmds.flatMap(segTokens)) {
    const m = refMove(toks, cwd);
    if (!m) {
      if (toks.length && !readOnly(toks) && !/^[({]*(cd|pushd)$/.test(toks[0]!)) busy = true;
      continue;
    }
    const c = toks.join(' ');
    if (busy) return say(`\`${c}\` follows another command on the same line, which may move refs or the index first, so harness can't check what it changes.`, 'Run the git command on its own so harness can check what it changes.');
    busy = true;
    if ('fail' in m) {
      if (m.fail === 'unknown') return say(`Could not check what \`${c}\` changes in harness's protected files.`);
      return unattended
        ? { kind: 'deny', reason: `\`${c}\` fetches before harness can check what it changes. Run git fetch, then git merge <ref>, so harness can check what it changes.`, check: 'protect' }
        : ask(`\`${c}\` fetches before harness can check what it changes in harness's protected files. Confirm it.`);
    }
    // git follows refs/replace/*; harness's diffs don't (--no-replace-objects), so they could read other content.
    const rr = git(m.dir, ['for-each-ref', '--count=1', 'refs/replace/']);
    if (rr.status !== 0 || rr.error) return say(`Could not check what \`${c}\` changes in harness's protected files.`);
    if (rr.stdout.trim()) return say(`Could not check what \`${c}\` changes in harness's protected files: the repo has replacement refs (refs/replace/), which git follows when it checks out.`);
    let diffs = m.diffs;
    if (m.sw) {
      const { ref, sw, paths } = m.sw;
      const failed = ask(`Could not check that ${ref} has the harness hooks. Confirm the switch.`);
      const rp = git(m.dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      if (rp.status === 1 && !sw) diffs = [{ paths: [ref, ...paths] }]; // not a ref: checkout of files from the index
      else if (rp.status !== 0) return failed;
      else if (paths.length) diffs = [{ from: ref, paths }];
      else {
        const cf = git(m.dir, ['cat-file', '-e', `${ref}:.harness/hooks/dispatch.mjs`]);
        if (cf.status === null || cf.error) return failed;
        if (cf.status !== 0) return ask(`Switching to ${ref} removes the harness hooks (no .harness/hooks/dispatch.mjs there). Confirm the switch.`);
        diffs = [{ from: ref }];
      }
    }
    const names = new Set<string>();
    for (const d of diffs) {
      const n = protectedChanges(m.dir, d);
      if (n === null) return say(`Could not check what \`${c}\` changes in harness's protected files.`);
      n.forEach((x) => names.add(x));
    }
    if (names.size) return say(`\`${c}\` changes harness's protected files (${[...names].slice(0, 3).join(', ')}).`);
  }
  return null;
}

const base = (t: string) => t.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
const RSYNC_VALUE = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--log-file', '--partial-dir', '-T', '--temp-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--chmod', '--chown', '--port', '--password-file', '--bwlimit', '--timeout', '--max-size', '--min-size', '-B', '--block-size', '--suffix', '-M', '--remote-option', '--rsync-path']);
// tar's options for the getopt reader: value letters and long names (GNU tar takes an unambiguous long prefix).
const TAR_OPTS: OptTable = {
  v: 'CfTXbHKLNVgFI', lv: ['directory', 'file', 'files-from', 'exclude-from', 'blocking-factor', 'format', 'starting-file', 'tape-length', 'newer', 'label', 'listed-incremental', 'info-script', 'use-compress-program', 'exclude', 'transform', 'owner', 'group', 'mode', 'strip-components', 'to-command'],
  lo: ['one-top-level', 'backup', 'checkpoint'],
  lf: ['extract', 'get', 'create', 'append', 'update', 'list', 'compare', 'delete', 'verbose', 'gzip', 'gunzip', 'bzip2', 'xz', 'zstd', 'lzma', 'keep-old-files', 'overwrite', 'preserve-permissions', 'same-owner', 'no-same-owner', 'absolute-names', 'wildcards', 'no-recursion', 'totals', 'auto-compress', 'ignore-zeros', 'skip-old-files', 'unlink-first', 'recursive-unlink'],
  prefix: true,
};
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv']);
/**
 * Targets of touch, find -delete/-exec rm (its start paths), tar extract (-C/--directory) and create (-f), unzip -d
 * and rsync's destination. ponytail: tar's key letters are read only from its first argument.
 */
function moreWriteTargets(cmds: string[]): string[] {
  const out: string[] = [];
  for (const toks of cmds.flatMap(segTokens)) {
    const named = (t: string) => WRITER_ALIAS[base(t)] ?? base(t); // gtar, bsdtar read as tar
    const i = toks.findIndex((t) => ['touch', 'find', 'tar', 'unzip', 'rsync'].includes(named(t)));
    if (i < 0) continue;
    const args = toks.slice(i + 1);
    const name = named(toks[i]);
    // `-C DIR`, `--directory DIR` or `--directory=DIR`. ponytail: an attached `-CDIR` is not read.
    const valueOf = (short: string, long: string): string[] =>
      args.flatMap((t, j) => (t === short || t === long ? [args[j + 1] ?? ''] : t.startsWith(long + '=') ? [t.slice(long.length + 1)] : []));
    if (name === 'touch') {
      for (let j = 0; j < args.length; j++) {
        if (/^-[tdr]$/.test(args[j])) j++;
        else if (!args[j].startsWith('-')) out.push(args[j]);
      }
    } else if (name === 'find') {
      const deletes = args.includes('-delete') || args.some((t, j) => /^-(exec|execdir|ok|okdir)$/.test(t) && DELETERS.has(base(args[j + 1] ?? '')));
      const starts = args.slice(0, Math.max(0, args.findIndex((t) => /^[-(!]/.test(t)))).filter(Boolean);
      if (deletes) out.push(...(starts.length ? starts : ['.']));
    } else if (name === 'tar') {
      // Read the getopt way, in any order (-C.harness, -zxC DIR, --dir=, --direc). An old-style key (`xC DIR -f a.tar`)
      // hands each value letter the next word, as tar does. Extract writes into -C/--one-top-level and writes each member
      // named; create/append/update write the -f archive.
      let a = args;
      if (/^[a-zA-Z]+$/.test(a[0] ?? '')) {
        const key: string[] = [];
        let r = 1;
        for (const c of a[0]) { key.push(`-${c}`); if (TAR_OPTS.v!.includes(c)) key.push(a[r++] ?? ''); }
        a = [...key, ...a.slice(r)];
      }
      const p = readOptions(a, TAR_OPTS), has = (s: string, l: string) => p.flags.includes(s) || p.flags.includes(l);
      if (has('-x', '--extract') || has('--get', '--get')) out.push(...valuesOf(p, ['-C', '--directory', '--one-top-level']), ...p.pos);
      if (has('-c', '--create') || has('-r', '--append') || has('-u', '--update')) out.push(...valuesOf(p, ['-f', '--file']));
    } else if (name === 'unzip') out.push(...valueOf('-d', '--directory'));
    else if (name === 'rsync') {
      // Options may follow the paths, and some take the next word (--exclude node_modules, -e ssh).
      const pos = args.filter((t, j) => !t.startsWith('-') && !RSYNC_VALUE.has(args[j - 1] ?? ''));
      if (pos.length >= 2) out.push(pos[pos.length - 1]);
    }
  }
  return out.filter(Boolean);
}

/** Every path a shell command may write, move, delete or restore (bash -c included), as written. */
export function shellWriteTargets(cmd: string): string[] {
  const cmds = expand(cmd);
  const mc = moveCopyTargets(cmds);
  return [...cmds.flatMap(fileWriteTargets), ...cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets)), ...mc.mv, ...mc.cp, ...gitRestoreTargets(cmds), ...moreWriteTargets(cmds)];
}

/** shellWriteTargets with each relative one also read from every cd/pushd folder before it. `unresolved`: a relative
 *  write follows a cd that can't be resolved ($X, -, ~), so where it lands is unknown. */
export function shellWritePaths(cmd: string): { paths: string[]; unresolved: boolean } {
  const ts = shellWriteTargets(cmd), dirs = cdDirs(expand(cmd));
  return { paths: fromDirs(dirs ?? [], ts), unresolved: dirs === null && relative(ts).length > 0 };
}

// Interpreters and the options that make their next word inline code. Only the interpreter's own options, before its
// first argument (the script it runs), count: `node node_modules/.bin/jest -c x` runs a file, `node -e '…'` is code.
type Interp = { inline: RegExp; value?: Set<string>; stop?: Set<string>; sub?: string };
// node -pe and -ep are clusters of -p and -e.
const NODE: Interp = { inline: /^(-[a-zA-Z]*[ep][a-zA-Z]*|--eval|--print)(=|$)/, value: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file', '--title']) };
const PY: Interp = { inline: /^-[a-zA-Z]*c$/, value: new Set(['-W', '-X']), stop: new Set(['-m']) };
const INTERPRETERS: Record<string, Interp> = {
  node: NODE, nodejs: NODE, bun: { ...NODE, value: new Set(['-r', '--preload', '--cwd', '--config']) },
  tsx: { ...NODE, value: new Set([...NODE.value!, '--tsconfig']) },
  'ts-node': { inline: NODE.inline, value: new Set(['-P', '--project', '-r', '--require', '-O', '--compiler-options', '-C', '--compiler', '-I', '--ignore', '--cwd']) },
  python: PY, python3: PY, deno: { inline: /^$/, sub: 'eval' },
  perl: { inline: /^-[a-zA-Z]*[eE]$/, value: new Set(['-I', '-M', '-m']) }, ruby: { inline: /^-[a-zA-Z]*e$/, value: new Set(['-r', '-I', '-C']) },
  php: { inline: /^-r$/, value: new Set(['-c', '-d']) },
};
/**
 * The inline code a command runs, with the arguments that invocation passes to it (the code may write them, as perl -i
 * or node -e "…" "$1" can), up to the end of that command or a redirection. `-c` payloads are read too. The
 * interpreter may be named by a path, and may sit behind any runner (npx, pnpm exec, env, timeout, …).
 */
function inlineCode(cmd: string, depth = 0): string[] {
  const out: string[] = [];
  // Quoting that doesn't balance may have split the command wrongly: check all of it, not less.
  if (!balanced(cmd)) out.push(cmd);
  for (const seg of segments(cmd)) {
    const ws = words(seg);
    // The basic rule: an interpreter word with an inline-code option, at any word, whatever wraps it (cross-env,
    // dotenv --, nvm exec, ionice …). The arguments it passes to the code count only when it is where the command
    // runs, so `echo node -e x node_modules` is just an echo.
    const start = commandStart(ws.map((w) => w.replace(/["']/g, '')), (name) => Object.hasOwn(INTERPRETERS, name));
    for (let i = 0; i < ws.length; i++) {
      const it = INTERPRETERS[commandName(ws[i])];
      if (!it) continue;
      for (let j = i + 1; j < ws.length; j++) {
        const t = unquote(ws[j]);
        const code = !t.startsWith('-') ? (it.sub && t === it.sub ? j + 1 : -1) : it.inline.test(t) ? (/=/.test(t) ? j : j + 1) : -2;
        if (code === -2) { if (it.stop?.has(t)) break; if (it.value?.has(t)) j++; continue; }
        if (code === -1) break; // the script or subcommand: not inline code
        const end = ws.findIndex((x, k) => k >= code && /^\d*[<>]/.test(x));
        const args = ws.slice(code, i === start ? (end < 0 ? ws.length : end) : code + 1).map(unquote);
        if (code === j) args[0] = t.slice(t.indexOf('=') + 1); // --eval=CODE
        out.push(args.join(' '));
        break;
      }
    }
  }
  if (depth < 3) {
    for (const p of cPayloads(cmd)) out.push(...inlineCode(p, depth + 1));
    // A program fed on stdin to an interpreter (echo … | node, node <<'EOF') is inline code; to a shell, a command line.
    // A body inside one already kept is a substring of it, and the segment tests match it there: skip it, so heredocs
    // with no end line stay linear (re-review 20, P1).
    let kept = -1;
    for (const p of stdinProgramsOf(cmd)) {
      if (SHELLS.has(p.name)) out.push(...inlineCode(p.text, depth + 1));
      else if (!p.lines || p.lines[1] > kept) { out.push(p.text); kept = p.lines?.[1] ?? kept; }
    }
  }
  return out;
}
const stdinProgramsOf = remember((cmd: string) =>
  stdinPrograms(cmd, (ws) => commandStart(ws, (n) => SHELLS.has(n) || Object.hasOwn(INTERPRETERS, n))).filter((p) => SHELLS.has(p.name) || Object.hasOwn(INTERPRETERS, p.name)));
// A protected name as a path segment (not node_modules.txt or my_node_modules).
const NM_SEG = /(^|[\\/'"`\s(,=:])node_modules([\\/'"`\s),;:]|$)/i;
const H_SEG = /(^|[\\/'"`\s(,=:])(\.harness|\.claude[\\/]settings[^\\/'"`\s),;:]*)([\\/'"`\s),;:]|$)/i;
const BUILT_REASON = 'This command names a protected harness path and also expands words, uses a glob or a redirect, cds, sources or runs a script, sets a variable (read, printf -v, declare, an array) or defines a function, so protect cannot tell what it writes.';
// Commands that change what a later word means, or run another file. cd and pushd count only into a protected dir, or
// a glob or expansion that could be one.
const BINDS = new Set(['source', '.', 'read', 'mapfile', 'readarray', 'declare', 'typeset', 'export', 'local', 'readonly']);
const binds = (ws: string[]): boolean => {
  const n = ws.length ? commandName(ws[0]) : '';
  if (n === 'cd' || n === 'pushd') {
    const t = ws.slice(1).find((w) => !w.startsWith('-')) ?? '';
    return /[$`]/.test(t) || PROTECTED_TEXT.test(unquote(t)) || globNamesProtected([t]);
  }
  return BINDS.has(n) || (n === 'printf' && ws.includes('-v')) || (SHELLS.has(n) && ws.length > 1 && !ws.includes('-c')); // bash FILE
};
const REDIRECT_TO_FILE = /\d*>>?\|?\s*(?!&|\/dev\/null\b)\S/;
const READ_ONLY = new Set(['cat', 'ls', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'diff', 'stat', 'file', 'less']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'ls-files', 'rev-parse']);
const HARNESS_READ = new Set(['doctor', 'status', 'explain', 'why', 'stats']);
/** A plain read: a read-only command with no redirect to a file. Its globs (ls .harness/*) and quotes are not writes. */
const readOnly = (ws: string[]): boolean => {
  const u = ws.map(unquote);
  const n = u.length ? commandName(u[0]) : '';
  return (READ_ONLY.has(n) || (n === 'git' && GIT_READ.has(gitArgs(u)[0])) || (n === 'harness' && HARNESS_READ.has(u[1]))) && !REDIRECT_TO_FILE.test(ws.join(' '));
};
const MESSAGE_FLAGS = new Set(['-m', '--message', '-F', '--file', '-b', '--body', '--body-file', '-t', '--title']);
// `$(cat <<'EOF' … EOF)`, Claude Code's commit and PR body form, and a one-word `.harness` in backticks are message text.
// Round 26 (re-review 23b, N1, N2): one linear walk over lines. A body ends only at the first line that is exactly its
// delimiter (leading tabs under `<<-`; no blanks, CR or `)`), and the next line must start with `)` after blanks; what
// follows that `)` stays text. A body under an unquoted delimiter that expands (lexer's EXPANDS), or a body line ending
// in `\` (it can join the end line), is code. Any opener that does not close that way leaves the whole text as code.
const CAT_OPEN = /^cat[ \t]+<<-?[ \t]*(['"]?)[A-Za-z_]\w*\1$/; // the opener ends its line; lexLine reads its delimiter
// Round 27 (re-review 24b, N4): an opener counts only as `"$(cat` with the lexer reading no open quote before that `"`,
// on its line (from the last close on) or on any earlier line, so `'$(cat <<'EOF'` is text, as in the shell.
const withoutCatMessages = (t: string): string => {
  const lines = t.split('\n'), out: string[] = [];
  let lexed = 0, neutral = true; // out[0, lexed) lexed so far, each ending outside a quote; lazy and linear
  for (let i = 0; i < lines.length; i++) {
    let cur = lines[i], from = 0, at = 0;
    for (;;) {
      const k = cur.lastIndexOf('$(cat');
      if (k < from || cur[k - 1] !== '"' || !CAT_OPEN.test(cur.slice(k + 2))) break;
      for (; neutral && lexed < out.length; lexed++) neutral = lexLine(out[lexed]) !== null;
      const op = neutral && lexLine(cur.slice(at, k - 1)) ? lexLine(cur.slice(k + 2))?.ends[0] : undefined;
      if (!op) break;
      let j = i + 1;
      for (; j < lines.length && (op.dash ? lines[j].replace(/^\t+/, '') : lines[j]) !== op.word; j++)
        if (lines[j].endsWith('\\') || (!op.literal && EXPANDS.test(lines[j]))) return t;
      const close = /^[ \t]*\)/.exec(lines[j + 1] ?? '');
      if (j >= lines.length || !close) return t;
      cur = cur.slice(0, k) + lines[j + 1].slice(close[0].length);
      from = k;
      at = k - 1; // cur[0, k - 1) lexed neutral; the next opener's prefix is lexed from this `"`
      i = j + 1;
    }
    out.push(cur);
  }
  return out.join('\n');
};
// A word with a substitution is a message only in Claude Code's exact shape, after -m, --message(=) or --body(=): it
// starts `"$(cat <<` and, bodies removed, is just `""` (it ends `)"` after the close line, no quote outside the bodies).
const CAT_FLAGS = new Set(['-m', '--message', '--body']);
const isMessage = (w: string, flag: string): boolean => {
  const eq = /^--(message|body|body-file|title|file)=/.exec(w)?.[0];
  const v = eq ? w.slice(eq.length) : w;
  if (!/\$\(|`/.test(v.replace(/`[^`\s]*`/g, ''))) return true;
  return (eq ? /^--(message|body)=$/.test(eq) : CAT_FLAGS.has(flag)) && v.startsWith('"$(cat <<') && withoutCatMessages(v) === '""';
};
/** A segment's words without its data: the text of an echo or printf whose output nobody reads as code (no redirect, no
 *  substitution in the command), and the message, body and title values of git and gh that run no other substitution. */
const codeWords = (ws: string[], consumed: boolean): string[] => {
  const n = ws.length ? commandName(ws[0]) : '';
  if ((n === 'echo' || n === 'printf') && !ws.includes('-v') && !consumed && !ws.some((w) => /[<>]/.test(w))) return ws.slice(0, 1);
  if (n === 'git' || n === 'gh') return ws.filter((w, i) => !((MESSAGE_FLAGS.has(ws[i - 1]) || /^--(message|body|body-file|title|file)=/.test(w)) && isMessage(w, ws[i - 1])));
  return ws;
};
const WRITERS = new Set(['tee', 'cp', 'mv', 'install', 'dd', 'ln', 'rsync', 'truncate', 'touch']);
/** xargs or find -exec/-execdir/-ok running a writer (or sed -i, or a redirect): the path comes from another program. */
const feedsWriter = (ws: string[]): boolean => {
  const u = ws.map(unquote);
  const k = commandStart([...u]);
  if (!u.slice(0, k).some((w) => ['xargs', 'find'].includes(commandName(w)))) return false;
  const n = commandName(u[k] ?? '');
  return WRITERS.has(n) || (n === 'sed' && u.slice(k).some((w) => /^-[a-zA-Z]*i|^--in-place/.test(w))) || u.slice(k).some((w) => />/.test(w));
};
/** The command names a protected path (heredoc bodies, echo/printf text and commit or PR messages are data, not names) and
 *  also has an expansion or substitution, an array or function definition, a redirect to a file, or a segment that binds or
 *  runs something (cd into a protected dir, source, ., read, printf -v, declare, bash FILE). Outside a plain read, a glob that
 *  can match a protected name, or a quote or backslash inside a protected path (tee .harness/"config.yaml"), counts on its
 *  own. xargs or find -exec feeding a writer asks, and so does any xargs when the text names a protected path. Plain reads
 *  (cat, ls, git diff) and writes protect parses (cp .harness/x /tmp) are judged as before.
 *  ponytail: a name built from pieces (x=.har; y=ness), or a path passed to a script the agent wrote, is not seen. */
const touchesProtectedText = (cmd: string): boolean => {
  const body = withoutHeredocBodies(cmd);
  const consumed = /\$\(|`|\|/.test(withoutCatMessages(body)); // echo output read by a substitution or a pipe
  const segs = segments(body).map((s) => codeWords(words(s), consumed));
  const text = segs.map((ws) => ws.join(' ')).join(' ; ');
  const names = (t: string) => [t, quoteFree(t), decodeAnsiC(t)].some((x) => PROTECTED_TEXT.test(x)); // decodeAnsiC: x='\x2eharness'; ${x@E}
  if (segs.some(feedsWriter) || (names(cmd) && segs.some((ws) => ws.some((w) => commandName(unquote(w)) === 'xargs')))) return true;
  const writes = segs.filter((ws) => !readOnly(ws));
  if (writes.some((ws) => globNamesProtected(ws) || ws.some((w) => /['"\\]/.test(w) && PROTECTED_TEXT.test(unquote(w))))) return true;
  return names(text) && (/`/.test(withoutCatMessages(body).replace(/`[^`\s]*`/g, "")) || /[$`]|\w=\(|\(\s*\)|\bfunction\s/.test(text) || REDIRECT_TO_FILE.test(text) ||
    writes.some((ws) => ws.some((w) => /[*?[{]/.test(w) && /harness|claude/i.test(w))) || segs.some(binds));
};
const GLOB = /[*?[{]/;
/** A glob word that can match a protected name: a component that matches `.harness` or `.claude` (cd .har*ss, tee
 *  .har?ess/x), or the whole word matching a protected path. As in bash, * and ? do not match a leading dot, so
 *  `ls src/*.ts` and `cat *.md` do not count. */
function globNamesProtected(ws: string[]): boolean {
  return ws.map(unquote).some((w) => {
    if (!/[*?[]/.test(w)) return false;
    const m = (p: string) => picomatch(p, { nocase: true }); // macOS and Windows ignore case
    return w.split(/[\\/]/).some((c) => /[*?[]/.test(c) && ['.harness', '.claude'].some((n) => m(c)(n))) || PROTECTED_CONCRETE.some((p) => m(w.replace(/^\.\//, ''))(p));
  });
}
const isProtectedGlob = (root: string, t: string): boolean => globHits(root, t, PROTECTED_CONCRETE);
// Whole-tree pathspecs restore .harness and .claude too: ".", ":/", the root, or any ancestor of it.
// `path` is a test seam for Windows (backslashes, `..`, drive letters, case-insensitive compare).
export const isWholeTree = (root: string, t: string, path: typeof nodePath = nodePath): boolean => {
  const rel = path.relative(path.resolve(root, t.replace(/^:[\\/]/, '')), path.resolve(root));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

const TMP = '.harness/tmp';
/** Inside a skill's work folder (`harness workdir`): lexically `.harness/tmp/<id>[/…]`, no `..` left, no protected name
 *  below it, no symlink on the way from `.harness` down and no hard-linked file, so the write lands where it reads.
 *  `.harness/tmp` and its .gitignore are not. */
export function inWorkdir(root: string, p: string): boolean {
  const rel = nodePath.relative(root, nodePath.resolve(root, p)).split(nodePath.sep).join('/');
  if (!rel.startsWith(TMP + '/') || rel === TMP + '/.gitignore') return false;
  const segs = rel.split('/');
  // A link made in the same command isn't on disk yet: through it, a protected file is reached only by naming it.
  if (segs.slice(2).some((s) => /^(\.harness|\.claude|node_modules)$/i.test(s))) return false;
  for (let i = 1; i <= segs.length; i++) {
    try {
      const st = lstatSync(nodePath.join(root, ...segs.slice(0, i)));
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) return false;
    } catch {
      break; // missing: nothing below it exists either
    }
  }
  return true;
}
// Commands that can make, copy or move a link into the work folder in the same line, before lstat could see it: the
// line then gets no exemption, and neither does one with inline code (node -e, python -c, sh -c, a heredoc to either).
// ponytail: a script file run in the same command is not seen (see Known limits).
const LINKERS = /^(ln|link|cp|mv|rsync|tar|bsdtar|gtar|unzip|ditto|cpio|bsdcpio|pax|git|patch|jar|7z|7za|unar|ar|install|osascript)$/;
const placesLinks = (cmd: string, cmds: string[], code: string[]): boolean =>
  code.length > 0 || cPayloads(cmd).length > 0 || stdinProgramsOf(cmd).length > 0 || cmds.flatMap(segTokens).some((toks) => toks.some((t) => !t.includes('.harness/tmp') && LINKERS.test(base(t))));
const LINK_REASON = 'This command can place links (ln, cp, mv, tar, git, inline code and the like), so protect cannot tell what a write into .harness/tmp reaches. Confirm the command.';
// The `.harness/tmp/<id>` prefix of a literal work-folder path, swapped for a plain word so the "names a protected path"
// ask skips it; the rest of the path stays. A whole word, bare or in one pair of quotes, in a line with no expansion,
// backslash, `..` or cd, where nothing can change what it means. ${CLAUDE_PLUGIN_ROOT} is the skills' form.
const TMP_WORD = /(?<=^|[\s<>|;&(])(?:(['"])((?:\/[\w.\/@+ -]*\/)?\.harness\/tmp\/[\w.@+-]+)([\w.\/@+ -]*)\1|((?:\/[\w.\/@+-]*\/)?\.harness\/tmp\/[\w.@+-]+)([\w.\/@+-]*))(?=$|[\s;&|)<>])/g;
const withoutWorkdirs = (root: string, cmd: string): string =>
  /[$`\\]|\.\.|\b(cd|pushd)\b/.test(cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', '')) ? cmd
    : cmd.replace(TMP_WORD, (w, q, qp, qt, up, ut) => {
      const p = qp ?? up, t = qt ?? ut, quote = q ?? '';
      return inWorkdir(root, p + t) ? `${quote}workdir${t}${quote}` : w;
    });

// A bare directory (rm -rf .harness/hooks) counts as inside its own glob.
// Done contract: a remote-tracking ref or remote URL vouches for a task contract, so git's ref and config files change
// only through git commands. Text-level only, never in denyWrite: git itself writes them from the agent's sandboxed Bash.
const GIT_WHY = "Git's refs and config are changed by git commands, not written directly: a forged remote-tracking ref could vouch for a task contract.";
const isGitState = (root: string, p: string): boolean => {
  const rel = toRepoPath(root, p)?.toLowerCase();
  return rel !== undefined && (['.git/config', '.git/packed-refs', '.git/head', '.git/refs'].includes(rel) || rel.startsWith('.git/refs/'));
};
const isProtected = (root: string, p: string, exempt = true): boolean => {
  if (exempt && inWorkdir(root, p)) return false;
  const lex = nodePath.relative(root, nodePath.resolve(root, p)).split(nodePath.sep).join('/').toLowerCase();
  if (lex === TMP || lex.startsWith(TMP + '/')) return true; // a symlinked tmp would read as outside the repo below
  const rel = toRepoPath(root, p)?.toLowerCase() ?? null; // macOS is case-insensitive
  return rel !== null && (rel === '.harness' || rel === '.claude' || matches(rel, PROTECTED) || matches(`${rel}/x`, PROTECTED));
};

export const protect: Check = {
  name: 'protect',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    const { input, root, config } = ctx;
    if (config?.checks.protect === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = input;
    let paths: string[] = [];
    let exempt = true; // the work-folder exemption, off for a shell line that may place a link first
    const target = editTarget(input);
    const nm = { kind: 'deny' as const, reason: NM_REASON, check: 'protect' };
    if (target !== null && inNodeModules(root, target)) return nm;
    if (target !== null && isGitState(root, target)) return { kind: 'deny', reason: GIT_WHY, check: 'protect' };
    if (target !== null) paths = [target];
    else if (isShell(tool_name)) {
      const cmd = String(tool_input.command ?? '');
      // Each nested program is read again for every level around it: past the cap, deny fast, before the hook times out.
      if (shellNesting(cmd) > MAX_SHELL_NESTING) return { kind: 'deny', reason: NESTING_WHY, check: 'protect' };
      // A program fed to a shell on stdin is a command line of its own (echo 'rm -rf node_modules' | bash).
      // So is the command as the shell splits it on $IFS (tee$IFS.harness/x).
      const ifs = ifsReading(cmd);
      for (const text of [...stdinProgramsOf(cmd).filter((p) => SHELLS.has(p.name)).map((p) => p.text), ...(ifs === null || ifs === cmd ? [] : [ifs])]) {
        const d = protect.run({ ...ctx, input: { ...input, tool_input: { command: text } } }) as Decision;
        if (d.kind === 'deny') return d;
      }
      // A text match can't tell a read from a write, so inline code that names these paths is denied whatever it does.
      const code = inlineCode(cmd);
      if (code.some((c) => NM_SEG.test(c))) return { kind: 'deny', reason: NM_INLINE, check: 'protect' };
      if (shellWriteTargets(cmd).some((t) => t && inNodeModules(root, t))) return nm;
      // Inline interpreter code (node -e, python -c, …) that names a protected path: its writes can't be parsed.
      // ponytail: textual only; a path built from pieces (".har" + "ness") still gets past.
      if (code.some((c) => H_SEG.test(c))) return { kind: 'deny', reason: H_INLINE, check: 'protect' };
      const cmds = expand(cmd);
      exempt = !placesLinks(cmd, cmds, code);
      const mc = moveCopyTargets(cmds);
      const rmT = cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets));
      const removed = [...rmT, ...mc.mv];
      const git = gitRestoreTargets(cmds);
      if (git.some((t) => isWholeTree(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      if ([...removed, ...mc.cp, ...git].some((t) => GLOB.test(t) && isProtectedGlob(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      // A cd earlier in the line moves where relative paths land: each is read from the root and from every cd folder.
      const dirs = cdDirs(cmds) ?? [], at = (ps: string[]) => fromDirs(dirs, ps);
      const segs = cmds.flatMap(segTokens), edited = at(editorFiles(cmds.flatMap((c) => segments(c).map((g) => words(g).map(unquote))))); // quote-aware: ex -sc '%s/a/b/|wq'
      paths = [...new Set(at([...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git, ...moreWriteTargets(cmds)]))]; // once each: every check of one touches the disk (re-review 22b, F4)
      if (paths.some((p) => p && isGitState(root, p))) return { kind: 'deny', reason: GIT_WHY, check: 'protect' };
      // Decisions: the directory routes (cp into a folder, tar -C, find -delete) and git restores replace what is under them.
      const dr = decisionRoutes(root, segs, dirs), names = codeNames(code), rmAt = at(rmT);
      const dd = decisionsDeny(root, config, [...paths, ...dr.writes, ...names], [...rmAt, ...dr.removed, ...at(git), ...names]);
      if (dd) return dd;
      const hit = paths.filter((p) => p && isProtected(root, p, exempt));
      // Protected only because the exemption is off: ask. tmp itself, its .gitignore or a protected name below it: deny.
      if (hit.length) return !exempt && hit.every((p) => inWorkdir(root, p)) ? { kind: 'ask', reason: LINK_REASON, check: 'protect' } : { kind: 'deny', reason: REASON, check: 'protect' }; // before the cd ask (re-review 2, N1)
      // An editor (vim, ex, sudoedit, …) writes the file itself; on a protected path the agent confirms rather than being denied.
      if (edited.some((p) => p && isProtected(root, p, exempt))) return { kind: 'ask', reason: EDITOR_PROTECTED_REASON, check: 'protect' };
      if (cdDirs(cmds) === null && relative([...paths, ...dr.writes, ...dr.removed, ...edited]).length) return { kind: 'ask', reason: CD_REASON, check: 'protect' };
      const da = becomesDecision(root, config, { tool: tool_name ?? '', input: tool_input, target: null, shellWrites: [...paths, ...dr.writes].filter((p) => !rmAt.includes(p)) }) ?? editorAsk(root, config, edited);
      // A path built at run time (p=.harness/x; tee $p, tee .harness/conf*, cd .harness && …) is not parsed: ask.
      const built = touchesProtectedText(exempt ? withoutWorkdirs(root, cmd) : cmd);
      if (!paths.some((p) => p && isProtected(root, p, exempt))) return da ?? (built ? { kind: 'ask', reason: BUILT_REASON, check: 'protect' } : refMoveAsk(cmds, input.cwd || root, ctx.unattended) ?? { kind: 'allow' });
    }
    if (target !== null) { const dd = decisionsDeny(root, config, [target], []); if (dd) return dd; }
    const da = target === null ? null : becomesDecision(root, config, { tool: tool_name ?? '', input: tool_input, target, shellWrites: [] });
    return paths.some((p) => p && isProtected(root, p, exempt)) ? { kind: 'deny', reason: REASON, check: 'protect' } : da ?? { kind: 'allow' };
  },
};
// One work budget per run, the nested runs above included (re-review 21, P1b): past it WorkBudget is thrown and the
// dispatcher denies.
const unbudgeted = protect.run;
// Commands whose writes protect reads: a path to one after a wrapper no table knows still heads its own segment.
// Built on first use, not at load: install/merge imports this module (denyWritePaths) from inside guard's own import
// graph, so guard's WRITER_ALIAS may not be initialized yet when this module loads.
let writeHeads: ReadonlySet<string> | undefined;
const WRITE_HEADS = (): ReadonlySet<string> => (writeHeads ??= new Set([...WRITERS, ...DELETERS, 'sed', 'perl', 'git', 'curl', 'wget', 'sort', 'time', 'tar', 'unzip', 'find', 'openssl', 'patch', 'xxd', 'sudoedit', 'ex', 'vim', 'nvim', ...Object.keys(WRITER_ALIAS)]));
const rank = (d: Decision): number => (d.kind === 'deny' ? 2 : d.kind === 'ask' ? 1 : 0);
const GUARDED_ASK = 'A path that names a writer (`./bin/tee`) was reduced to that writer and then names a protected path, but protect cannot tell a read from a write here. Confirm the command.';
const GLOB_ASK = 'A glob in a command path could match a writer and a protected path, so protect cannot tell what it writes. Confirm the command.';
/** The command as written, its wrapper readings (wrappers split off, or removed before a pipe), and the guarded-path
 *  reading (a path to a writer read as that writer). The strictest wins; a wrapper reading may deny, but the guarded-path
 *  reading only ever asks — on its own `cat ./bin/tee .harness/x` is a read, so it must not deny (re-review round 3, item 4). */
function withPlainHeads(ctx: Parameters<Check['run']>[0]): Decision {
  const d = unbudgeted(ctx) as Decision;
  if (d.kind === 'deny' || !isShell(ctx.input.tool_name)) return d;
  const cmd = withoutHeredocBodies(String(ctx.input.tool_input?.command ?? '')); // data bodies hold no command
  const run = (command: string) => unbudgeted({ ...ctx, input: { ...ctx.input, tool_input: { ...ctx.input.tool_input, command } } }) as Decision;
  let worst = d;
  const take = (r: Decision) => { if (rank(r) > rank(worst)) worst = r; };
  for (const command of wrapperForms(cmd).texts) take(run(command));
  const gp = guardedPaths(cmd, WRITE_HEADS());
  if (gp) { const r = run(gp); if (r.kind !== 'allow') take({ kind: 'ask', reason: GUARDED_ASK, check: 'protect' }); } // deny capped to ask
  if (globGuardAsk(cmd, WRITE_HEADS())) take({ kind: 'ask', reason: GLOB_ASK, check: 'protect' });
  return worst;
}
protect.run = (ctx) => withWorkBudget(() => withPlainHeads(ctx));
