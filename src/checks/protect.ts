// Harness files and Claude settings are changed by a person; the agent is denied at the tool-call level.
import { matches, toRepoPath } from '../core/paths.js';
import type { Check } from '../hooks/dispatch.js';
import { fileWriteTargets, rmTargets } from './guard.js';

const PROTECTED = ['.harness/hooks/**', '.harness/state/**', '.harness/config.yaml', '.claude/settings.json', '.claude/settings.local.json'];
const REASON = 'Harness files and Claude settings are changed by a person, not the agent.';

// mv: every path (source and destination); cp: the destination. ponytail: ignores -t DIR; splits on ; & | even inside quotes.
function moveCopyTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of cmd.split(/[;&|\n]+/)) {
    const toks = [...(seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? [])].map((t) => t.replace(/^['"]|['"]$/g, ''));
    const i = toks.findIndex((t) => t === 'mv' || t === 'cp');
    if (i < 0) continue;
    const args = toks.slice(i + 1).filter((t) => !t.startsWith('-'));
    out.push(...(toks[i] === 'mv' ? args : args.slice(-1)));
  }
  return out;
}

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
      paths = [...fileWriteTargets(cmd), ...rmTargets(cmd).flatMap((r) => r.targets), ...moveCopyTargets(cmd)];
    }
    return paths.some((p) => p && isProtected(root, p)) ? { kind: 'deny', reason: REASON, check: 'protect' } : { kind: 'allow' };
  },
};
