// mcp-writes: MCP tool calls (owner ruling, 2026-11-13). A tool that turns on auto-merge is denied on any server, the
// desktop's mcp__ccd_pr__set_auto_merge included; a GitHub or GitLab tool whose name shows a write asks; reads pass.
// Judged by the tool's name only (mcp__<server>__<tool>): harness can't see what a tool does beyond its name.
import type { Check } from '../hooks/dispatch.js';

const AUTO_MERGE = /auto_?merge/i;
const READ = /^(get|list|search|read|view)_/i;
// A conservative verb list, matched as a word of the tool name (create_pull_request, add_issue_comment, merge).
const WRITE = /(?:^|_)(merge|close|delete|remove|create|update|edit|push|write|comment|review|approve|reopen|lock|unlock|transfer|archive|rename|dismiss|publish|release|deploy|rerun|cancel|submit|revert|fork|assign|add|upload|dispatch|trigger)(?:_|$)/i;
// A GitHub or GitLab server by its name (github, gitlab, gh, a pr server such as ccd_pr), or a tool naming one of their objects.
const GIT_HOST = /git(?:hub|lab)|(?:^|[_-])(?:gh|pr)(?:[_-]|$)/i;
const GIT_OBJECT = /pull_?request|merge_?request|repo(?:sitory)?|gist|workflow/i;

const AUTO_MERGE_WHY = 'An MCP tool that turns on auto-merge lets the PR merge with no person at the moment of merge, so harness never lets the agent use it. Ask the person to merge, or to turn on auto-merge themselves.';

export const mcpWrites: Check = {
  name: 'mcp-writes',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    const name = ctx.input.tool_name ?? '';
    if (!name.startsWith('mcp__') || ctx.config?.checks.guard === false) return { kind: 'allow' };
    const [, server = '', ...rest] = name.split('__'), tool = rest.join('__');
    if (AUTO_MERGE.test(name)) return { kind: 'deny', reason: AUTO_MERGE_WHY, check: 'mcp-writes' };
    if (READ.test(tool)) return { kind: 'allow' };
    if (WRITE.test(tool) && (GIT_HOST.test(server) || GIT_OBJECT.test(tool)))
      return { kind: 'ask', reason: `The MCP tool ${name} changes shared state on GitHub or GitLab (a merge, close, comment, push or the like needs your yes).`, check: 'mcp-writes' };
    return { kind: 'allow' };
  },
};
