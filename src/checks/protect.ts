// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { spawnSync } from 'node:child_process';
import nodePath, { resolve } from 'node:path';
import picomatch from 'picomatch';
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { editTarget, isShell } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { commandStart, fileWriteTargets, gitArgs, rmTargets } from './guard.js';
import { balanced, commandName, cPayloads, segments, SHELLS, stdinPrograms, unquote, words } from '../core/shell-words.js';

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
    for (const p of stdinProgramsOf(cmd)) out.push(...(SHELLS.has(p.name) ? inlineCode(p.text, depth + 1) : [p.text]));
  }
  return out;
}
const stdinProgramsOf = (cmd: string) =>
  stdinPrograms(cmd, (ws) => commandStart(ws, (n) => SHELLS.has(n) || Object.hasOwn(INTERPRETERS, n))).filter((p) => SHELLS.has(p.name) || Object.hasOwn(INTERPRETERS, p.name));
// A protected name as a path segment (not node_modules.txt or my_node_modules).
const NM_SEG = /(^|[\\/'"`\s(,=:])node_modules([\\/'"`\s),;:]|$)/i;
const H_SEG = /(^|[\\/'"`\s(,=:])(\.harness|\.claude[\\/]settings[^\\/'"`\s),;:]*)([\\/'"`\s),;:]|$)/i;
const GLOB = /[*?[{]/;
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
      // A program fed to a shell on stdin is a command line of its own (echo 'rm -rf node_modules' | bash).
      for (const p of stdinProgramsOf(cmd).filter((p) => SHELLS.has(p.name))) {
        const d = protect.run({ ...ctx, input: { ...input, tool_input: { command: p.text } } }) as Decision;
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
      paths = [...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git, ...moreWriteTargets(cmds)];
      if (!paths.some((p) => p && isProtected(root, p))) return switchAsk(cmds, input.cwd || root) ?? { kind: 'allow' };
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
