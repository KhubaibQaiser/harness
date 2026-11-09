// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { spawnSync } from 'node:child_process';
import nodePath, { resolve } from 'node:path';
import picomatch from 'picomatch';
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { editTarget, isShell } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { commandStart, decodeAnsiC, fileWriteTargets, gitArgs, ifsReading, MAX_SHELL_NESTING, NESTING_WHY, PROTECTED_TEXT, quoteFree, rmTargets, shellNesting, withoutHeredocBodies } from './guard.js';
import { balanced, commandName, cPayloads, segments, SHELLS, stdinPrograms, unquote, withWorkBudget, words } from '../core/shell-words.js';

const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/logs/**', '.harness/backup/**', '.harness/results/**', '.harness/config.yaml', '.harness/manifest.json', '.harness/apply.lock', '.claude/settings.json', '.claude/settings.local.json'];
const PROTECTED_CONCRETE = ['.harness', '.harness/hooks', '.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/state', '.harness/state/tdd-pause.json', '.harness/logs', '.harness/logs/events.jsonl', '.harness/backup', '.harness/results', '.harness/config.yaml', '.harness/manifest.json', '.harness/apply.lock', '.claude', '.claude/settings.json', '.claude/settings.local.json'];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';
const NM_REASON = 'node_modules is managed by the package manager, not edited by hand: change package.json and run an install instead.';
const INLINE_WHY = 'Inline code (node -e, python -c and the like) that names';
const NM_INLINE = `${INLINE_WHY} node_modules is denied: it may write there, and a text match cannot tell a read from a write. node_modules is managed by the package manager: change package.json and run an install instead.`;
const H_INLINE = `${INLINE_WHY} harness files or Claude settings is denied: it may write them, and a text match cannot tell a read from a write. ${REASON}`;
// Owner rule: nobody edits node_modules directly. Installs still go through the guard's install gate.
const inNodeModules = (root: string, p: string): boolean => !!toRepoPath(root, p)?.toLowerCase().split('/').includes('node_modules');

const segTokens = (cmd: string): string[][] =>
  cmd.split(/[;&|\n]+/).map((seg) => [...(seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])].map((t) => t.replace(/^['"]|['"]$/g, '')));

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

// mv: every path (source and destination); cp: the destination. ponytail: ignores -t DIR; splits on ; & | even inside quotes.
function moveCopyTargets(cmds: string[]): { mv: string[]; cp: string[] } {
  const r = { mv: [] as string[], cp: [] as string[] };
  for (const toks of cmds.flatMap(segTokens)) {
    const i = toks.findIndex((t) => t === 'mv' || t === 'cp');
    if (i < 0) continue;
    const args = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    if (toks[i] === 'mv') r.mv.push(...args);
    else r.cp.push(...args.slice(-1));
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
    // "git checkout ." has no ref; with two or more args the first is one.
    out.push(...(d >= 0 ? rest.slice(d + 1) : sub === 'checkout' && plain.length > 1 ? plain.slice(1) : plain));
  }
  return out;
}

// The ref a git checkout/switch moves the worktree to, with the dir git runs in; null for file checkouts and new branches off HEAD.
// ponytail: checkout's remote-tracking DWIM (`git checkout foo` with only origin/foo) reads as a file checkout; `-`, @{-1} and --orphan are not looked up.
function switchTarget(toks: string[], cwd: string): { ref: string; dir: string; sw: boolean } | null {
  const [sub, ...rest] = gitArgs(toks);
  if (sub !== 'checkout' && sub !== 'switch') return null;
  let dir = cwd;
  for (let i = toks.indexOf('git') + 1; toks[i]?.startsWith('-'); i += /^-[Cc]$/.test(toks[i]!) ? 2 : 1) if (toks[i] === '-C') dir = resolve(dir, toks[i + 1] ?? '');
  if (rest.includes('--')) return null;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (/^(-[bBcC]|--orphan)$/.test(rest[i]!)) i += 1; // value is the new branch name
    else if (!rest[i]!.startsWith('-')) pos.push(rest[i]!);
  }
  return pos.length === 1 ? { ref: pos[0]!, dir, sw: sub === 'switch' } : null;
}

const git = (dir: string, args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 1500 });

// Ask before moving to a ref with no .harness/hooks/dispatch.mjs: every hook would then fail open until someone switches back.
function switchAsk(cmds: string[], cwd: string): Decision | null {
  for (const toks of cmds.flatMap(segTokens)) {
    const t = switchTarget(toks, cwd);
    if (!t) continue;
    const ask = (reason: string): Decision => ({ kind: 'ask', reason, check: 'protect' });
    const failed = ask(`Could not check that ${t.ref} has the harness hooks. Confirm the switch.`);
    const rp = git(t.dir, ['rev-parse', '--verify', '-q', `${t.ref}^{commit}`]);
    if (rp.status === 1 && !t.sw) continue; // not a ref: checkout of a file
    if (rp.status !== 0) return failed;
    const cf = git(t.dir, ['cat-file', '-e', `${t.ref}:.harness/hooks/dispatch.mjs`]);
    if (cf.status === null || cf.error) return failed;
    if (cf.status !== 0) return ask(`Switching to ${t.ref} removes the harness hooks (no .harness/hooks/dispatch.mjs there). Confirm the switch.`);
  }
  return null;
}

const base = (t: string) => t.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
const RSYNC_VALUE = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--exclude-from', '--include-from', '--files-from', '--log-file', '--partial-dir', '-T', '--temp-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--chmod', '--chown', '--port', '--password-file', '--bwlimit', '--timeout', '--max-size', '--min-size', '-B', '--block-size', '--suffix', '-M', '--remote-option', '--rsync-path']);
const DELETERS = new Set(['rm', 'unlink', 'rmdir', 'shred', 'truncate', 'mv']);
/**
 * Targets of touch, find -delete/-exec rm (its start paths), tar extract (-C/--directory) and create (-f), unzip -d
 * and rsync's destination. ponytail: tar's key letters are read only from its first argument.
 */
function moreWriteTargets(cmds: string[]): string[] {
  const out: string[] = [];
  for (const toks of cmds.flatMap(segTokens)) {
    const i = toks.findIndex((t) => ['touch', 'find', 'tar', 'unzip', 'rsync'].includes(base(t)));
    if (i < 0) continue;
    const args = toks.slice(i + 1);
    const name = base(toks[i]);
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
      const key = args[0] ?? '';
      const keyLetters = /^-?[a-zA-Z]+$/.test(key) && !key.startsWith('--') ? key.replace(/^-/, '') : '';
      const has = (letter: string, long: string) => keyLetters.includes(letter) || args.includes('-' + letter) || args.includes(long);
      if (has('x', '--extract') || args.includes('--get')) out.push(...valueOf('-C', '--directory'));
      if (has('c', '--create') || has('r', '--append') || has('u', '--update')) {
        out.push(...valueOf('-f', '--file'));
        if (keyLetters.includes('f')) out.push(args[1] ?? ''); // tar -czf OUT …
      }
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
const stdinProgramsOf = (cmd: string) =>
  stdinPrograms(cmd, (ws) => commandStart(ws, (n) => SHELLS.has(n) || Object.hasOwn(INTERPRETERS, n))).filter((p) => SHELLS.has(p.name) || Object.hasOwn(INTERPRETERS, p.name));
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
// Round 25 (re-review 22b, F2): only a body that ends at its first end line, as the shell reads it, and that holds no
// substitution when the delimiter is unquoted. A body is not searched past the next `$(cat`, so the scan is linear (F4).
const HEREDOC_CAT = /\$\(cat\s+<<(-?)\s*(['"]?)(\w+)\2\n((?:(?!\$\(cat\s)[\s\S])*?)\n\s*\3\s*\n?\s*\)/g;
const withoutCatMessages = (t: string): string =>
  t.replace(HEREDOC_CAT, (m, dash: string, q: string, w: string, body: string) =>
    body.split('\n').some((l) => (dash ? l.replace(/^\t+/, '') : l) === w) || (!q && /`|\$[({[]/.test(body)) ? m : '');
const isMessage = (w: string): boolean => !/\$\(|`/.test(withoutCatMessages(w).replace(/`[^`\s]*`/g, ''));
/** A segment's words without its data: the text of an echo or printf whose output nobody reads as code (no redirect, no
 *  substitution in the command), and the message, body and title values of git and gh that run no other substitution. */
const codeWords = (ws: string[], consumed: boolean): string[] => {
  const n = ws.length ? commandName(ws[0]) : '';
  if ((n === 'echo' || n === 'printf') && !ws.includes('-v') && !consumed && !ws.some((w) => /[<>]/.test(w))) return ws.slice(0, 1);
  if (n === 'git' || n === 'gh') return ws.filter((w, i) => !((MESSAGE_FLAGS.has(ws[i - 1]) || /^--(message|body|body-file|title|file)=/.test(w)) && isMessage(w)));
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
const isProtectedGlob = (root: string, t: string): boolean => {
  const rel = toRepoPath(root, t.replace(/^:\//, ''))?.toLowerCase().replace(/\[!/g, '[^'); // picomatch mishandles [!x]
  return !!rel && PROTECTED_CONCRETE.some((c) => picomatch(rel, { dot: true })(c));
};
// Whole-tree pathspecs restore .harness and .claude too: ".", ":/", the root, or any ancestor of it.
// `path` is a test seam for Windows (backslashes, `..`, drive letters, case-insensitive compare).
export const isWholeTree = (root: string, t: string, path: typeof nodePath = nodePath): boolean => {
  const rel = path.relative(path.resolve(root, t.replace(/^:[\\/]/, '')), path.resolve(root));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

// A bare directory (rm -rf .harness/hooks) counts as inside its own glob.
const isProtected = (root: string, p: string): boolean => {
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
    const target = editTarget(input);
    const nm = { kind: 'deny' as const, reason: NM_REASON, check: 'protect' };
    if (target !== null && inNodeModules(root, target)) return nm;
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
      const mc = moveCopyTargets(cmds);
      const removed = [...cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets)), ...mc.mv];
      const git = gitRestoreTargets(cmds);
      if (git.some((t) => isWholeTree(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      if ([...removed, ...mc.cp, ...git].some((t) => GLOB.test(t) && isProtectedGlob(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      paths = [...new Set([...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git, ...moreWriteTargets(cmds)])]; // once each: every check of one touches the disk (re-review 22b, F4)
      // A path built at run time (p=.harness/x; tee $p, tee .harness/conf*, cd .harness && …) is not parsed: ask.
      const built = touchesProtectedText(cmd);
      if (!paths.some((p) => p && isProtected(root, p))) return built ? { kind: 'ask', reason: BUILT_REASON, check: 'protect' } : switchAsk(cmds, input.cwd || root) ?? { kind: 'allow' };
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
// One work budget per run, the nested runs above included (re-review 21, P1b): past it WorkBudget is thrown and the
// dispatcher denies.
const unbudgeted = protect.run;
protect.run = (ctx) => withWorkBudget(() => unbudgeted(ctx));
