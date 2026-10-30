// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { resolve } from 'node:path';
import picomatch from 'picomatch';
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { fileWriteTargets, gitArgs, rmTargets } from './guard.js';

const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/config.yaml', '.claude/settings.json', '.claude/settings.local.json'];
const PROTECTED_CONCRETE = ['.harness', '.harness/hooks', '.harness/hooks/dispatch.mjs', '.harness/state', '.harness/state/tdd-pause.json', '.harness/config.yaml', '.claude', '.claude/settings.json', '.claude/settings.local.json'];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';

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

const GLOB = /[*?[{]/;
const isProtectedGlob = (root: string, t: string): boolean => {
  const rel = toRepoPath(root, t.replace(/^:\//, ''))?.toLowerCase().replace(/\[!/g, '[^'); // picomatch mishandles [!x]
  return !!rel && PROTECTED_CONCRETE.some((c) => picomatch(rel, { dot: true })(c));
};
// Whole-tree pathspecs restore .harness and .claude too: ".", ":/", the root, or any ancestor of it.
const isWholeTree = (root: string, t: string): boolean => {
  const p = resolve(root, t.replace(/^:\//, ''));
  return resolve(root) === p || resolve(root).startsWith(p.replace(/\/$/, '') + '/');
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
  run({ input, root, config }) {
    if (config?.checks.protect === false) return { kind: 'allow' };
    const { tool_name, tool_input = {} } = input;
    let paths: string[] = [];
    if (tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'MultiEdit') paths = [String(tool_input.file_path ?? '')];
    else if (tool_name === 'NotebookEdit') paths = [String(tool_input.notebook_path ?? '')];
    else if (tool_name === 'Bash') {
      const cmd = String(tool_input.command ?? '');
      const cmds = expand(cmd);
      const mc = moveCopyTargets(cmds);
      const removed = [...cmds.flatMap((c) => rmTargets(c).flatMap((r) => r.targets)), ...mc.mv];
      const git = gitRestoreTargets(cmds);
      if (git.some((t) => isWholeTree(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      if ([...removed, ...mc.cp, ...git].some((t) => GLOB.test(t) && isProtectedGlob(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      paths = [...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git];
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
