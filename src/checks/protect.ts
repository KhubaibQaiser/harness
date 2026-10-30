// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { resolve } from 'node:path';
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { fileWriteTargets, rmTargets } from './guard.js';

const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/config.yaml', '.claude/settings.json', '.claude/settings.local.json'];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';

const segTokens = (cmd: string): string[][] =>
  cmd.split(/[;&|\n]+/).map((seg) => [...(seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])].map((t) => t.replace(/^['"]|['"]$/g, '')));

// mv: every path (source and destination); cp: the destination. ponytail: ignores -t DIR; splits on ; & | even inside quotes.
function moveCopyTargets(cmd: string): { mv: string[]; cp: string[] } {
  const r = { mv: [] as string[], cp: [] as string[] };
  for (const toks of segTokens(cmd)) {
    const i = toks.findIndex((t) => t === 'mv' || t === 'cp');
    if (i < 0) continue;
    const args = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    if (toks[i] === 'mv') r.mv.push(...args);
    else r.cp.push(...args.slice(-1));
  }
  return r;
}

// git checkout/restore paths. Without "--", checkout's first non-flag arg is a ref (or a branch being switched to).
function gitRestoreTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const toks of segTokens(cmd)) {
    const g = toks.indexOf('git');
    const sub = toks[g + 1];
    if (g < 0 || (sub !== 'checkout' && sub !== 'restore')) continue;
    const rest = toks.slice(g + 2);
    const d = rest.indexOf('--');
    const args = (d >= 0 ? rest.slice(d + 1) : rest.filter((t) => !t.startsWith('-')).slice(sub === 'checkout' ? 1 : 0));
    out.push(...args);
    if (sub === 'checkout' && d < 0 && rest.filter((t) => !t.startsWith('-')).length === 1) out.push(...rest.filter((t) => !t.startsWith('-'))); // "git checkout ." has no ref
  }
  return out;
}

const GLOB = /[*?[]/;
// Whole-tree pathspecs restore .harness and .claude too: ".", ":/", the root, or any ancestor of it.
const isWholeTree = (root: string, t: string): boolean => t === ':/' || resolve(root).startsWith(resolve(root, t).replace(/\/$/, '') + '/') || resolve(root, t) === resolve(root);

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
      const mc = moveCopyTargets(cmd);
      const removed = [...rmTargets(cmd).flatMap((r) => r.targets), ...mc.mv];
      const git = gitRestoreTargets(cmd);
      if (git.some((t) => isWholeTree(root, t))) return { kind: 'deny', reason: REASON, check: 'protect' };
      // A glob such as .harness/* is judged by the literal path before the first glob character.
      const globbed = removed.filter((t) => GLOB.test(t)).map((t) => t.slice(0, t.search(GLOB)).replace(/\/$/, ''));
      paths = [...fileWriteTargets(cmd), ...removed, ...mc.cp, ...git, ...globbed];
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
