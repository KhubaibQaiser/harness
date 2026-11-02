// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { spawnSync } from 'node:child_process';
import nodePath, { resolve } from 'node:path';
import picomatch from 'picomatch';
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { editTarget } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { fileWriteTargets, gitArgs, rmTargets } from './guard.js';

const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/logs/**', '.harness/backup/**', '.harness/config.yaml', '.harness/manifest.json', '.claude/settings.json', '.claude/settings.local.json'];
const PROTECTED_CONCRETE = ['.harness', '.harness/hooks', '.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/state', '.harness/state/tdd-pause.json', '.harness/logs', '.harness/logs/events.jsonl', '.harness/backup', '.harness/config.yaml', '.harness/manifest.json', '.claude', '.claude/settings.json', '.claude/settings.local.json'];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';
const NM_REASON = 'node_modules is managed by the package manager, not edited by hand: change package.json and run an install instead.';
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

/** Every path a shell command may write, move, delete or restore (bash -c included), as written. */
export function shellWriteTargets(cmd: string): string[] {
  const cmds = expand(cmd);
  const mc = moveCopyTargets(cmds);
  return [...cmds.flatMap(fileWriteTargets), ...cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets)), ...mc.mv, ...mc.cp, ...gitRestoreTargets(cmds)];
}

const INLINE_CODE = /(^|[\s;&|(`])(node|nodejs|deno|bun|python3?|perl|ruby|php)(\.exe)?\s+([^;&|\n]*\s)?(-e|-p|-c|-r|--eval|--print|eval|-pe|-ne)(\s|=|$)/;
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
  run({ input, root, config }) {
    if (config?.checks.protect === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = input;
    let paths: string[] = [];
    const target = editTarget(input);
    const nm = { kind: 'deny' as const, reason: NM_REASON, check: 'protect' };
    if (target !== null && inNodeModules(root, target)) return nm;
    if (target !== null) paths = [target];
    else if (tool_name === 'Bash') {
      const cmd = String(tool_input.command ?? '');
      if (INLINE_CODE.test(cmd) && /node_modules[\\/]/i.test(cmd)) return nm;
      if (shellWriteTargets(cmd).some((t) => t && inNodeModules(root, t))) return nm;
      // Inline interpreter code (node -e, python -c, …) that names a protected path: its writes can't be parsed.
      // ponytail: textual only; a path built from pieces (".har" + "ness") still gets past.
      if (INLINE_CODE.test(cmd) && /\.harness[\\/]|\.claude[\\/]settings/i.test(cmd)) return { kind: 'deny', reason: REASON, check: 'protect' };
      const cmds = expand(cmd);
      const mc = moveCopyTargets(cmds);
      const removed = [...cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets)), ...mc.mv];
      const git = gitRestoreTargets(cmds);
      if (git.some((t) => isWholeTree(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      if ([...removed, ...mc.cp, ...git].some((t) => GLOB.test(t) && isProtectedGlob(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      paths = [...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git];
      if (!paths.some((p) => p && isProtected(root, p))) return switchAsk(cmds, input.cwd || root) ?? { kind: 'allow' };
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
