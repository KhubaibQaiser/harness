// mcp-writes: MCP tool calls (owner ruling, 2026-11-13), judged by the tool's name (mcp__<server>__<tool>), split into
// words at `_`, `-`, `.` and camelCase. On a git-host server only reads pass; an opaque (uuid) server asks on any write
// verb; auto-merge with a write verb is denied anywhere, the desktop's mcp__ccd_pr__set_auto_merge included.
import type { Check } from '../hooks/dispatch.js';

/** `MergePullRequest`, `merge-pull-request`, `pulls.merge` -> merge, pull, request. */
const wordsOf = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const READ = new Set(['get', 'list', 'search', 'read', 'view', 'describe', 'fetch', 'find', 'show', 'download', 'lookup', 'count', 'inspect']);
const WRITE = new Set(['merge', 'close', 'delete', 'remove', 'create', 'update', 'edit', 'push', 'write', 'comment', 'review', 'approve', 'reopen', 'lock', 'unlock', 'transfer', 'archive',
  'rename', 'dismiss', 'publish', 'release', 'deploy', 'rerun', 'cancel', 'submit', 'revert', 'fork', 'assign', 'add', 'upload', 'dispatch', 'trigger', 'run', 'set', 'enable', 'disable',
  'star', 'unstar', 'mark', 'rebase', 'enqueue', 'queue', 'patch', 'put', 'post', 'request', 'resolve', 'squash', 'accept', 'label', 'manage', 'execute', 'call', 'apply', 'sync', 'move',
  'insert', 'modify', 'replace', 'change', 'toggle', 'subscribe', 'unsubscribe', 'invite', 'block', 'unblock', 'pin', 'unpin', 'convert', 'import', 'restore', 'reset', 'clear']);
// A git host by its server name, or a tool naming one of a git host's own objects (a pull or merge request, a gist).
const GIT_HOST = /github|gitlab|gitea|bitbucket|forgejo|codeberg/;
const GIT_OBJECT = /(?:^|_)(?:pull_?requests?|merge_?requests?|pr|prs|gists?)(?:_|$)/;
const OPAQUE = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f-]{16,}$/i; // a uuid or hex id instead of a name

const AUTO_MERGE_WHY = 'An MCP tool that turns on auto-merge lets the PR merge with no person at the moment of merge, so harness never lets the agent use it. Ask the person to merge, or to turn on auto-merge themselves.';

export const mcpWrites: Check = {
  name: 'mcp-writes',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    const name = ctx.input.tool_name ?? '';
    if (!name.startsWith('mcp__') || ctx.config?.checks.guard === false) return { kind: 'allow' };
    const [, server = '', ...rest] = name.split('__'), sw = wordsOf(server);
    // `pull_request`/`merge_request` is an object, not the verb "request": one word `pr` before the verbs are read.
    const joined = wordsOf(rest.join('_')).join('_'), w = joined.replace(/(?:pull|merge)_?requests?/g, 'pr').split('_');
    // Auto-merge is denied with a write verb, or alone (`autoMerge`); only a read verb first lets it pass (`get_automerge_config`).
    const autoMerge = /automerge|auto_merge/.test(joined), verbs = w.filter((x) => WRITE.has(x) && !(autoMerge && (x === 'merge')));
    if (autoMerge && (verbs.length || !READ.has(w[0] ?? ''))) return { kind: 'deny', reason: AUTO_MERGE_WHY, check: 'mcp-writes' };
    const firstRead = READ.has(w[0] ?? ''), read = firstRead || (READ.has(w.at(-1) ?? '') && !w.some((x) => WRITE.has(x)));
    // A host server: its name (GitHub, claude_ai_GitHub), a `gh` word, or a pr server (the desktop's ccd_pr); or a tool naming a host object.
    const host = GIT_HOST.test(server.toLowerCase()) || sw.includes('gh') || sw.at(-1) === 'pr' || GIT_OBJECT.test(joined);
    if (host ? !read : OPAQUE.test(server) && w.some((x) => WRITE.has(x)))
      return { kind: 'ask', reason: `The MCP tool ${name} may change shared state on a git host (only its read tools run freely; a merge, comment, push or the like needs your yes).`, check: 'mcp-writes' };
    return { kind: 'allow' };
  },
};
