// Owner ruling 2026-11-13: MCP tools that turn on auto-merge are denied; GitHub/GitLab write tools ask; read tools pass.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { mcpWrites } from '../../src/checks/mcp-writes.js';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, registry } from '../../src/hooks/dispatch.js';

const config = loadConfig('/nonexistent-harness-root').config;
const kind = (tool_name: string, cfg = config) =>
  (mcpWrites.run({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name, tool_input: {} }, root: '/p', config: cfg, env: {}, unattended: false } as unknown as Ctx) as { kind: string }).kind;
const all = (names: string[], want: string) => { for (const n of names) expect(kind(n), n).toBe(want); };

test('auto-merge tools are denied, whatever the server', () => {
  all(['mcp__ccd_pr__set_auto_merge', 'mcp__github__enable_auto_merge', 'mcp__gitlab__set_automerge', 'mcp__plugin_engineering_github__enable_pull_request_auto_merge', 'mcp__x__AutoMerge'], 'deny');
});

test('GitHub and GitLab write tools ask', () => {
  all(['mcp__github__merge_pull_request', 'mcp__github__create_pull_request', 'mcp__github__update_issue', 'mcp__github__add_issue_comment', 'mcp__github__create_release',
    'mcp__github__push_files', 'mcp__github__delete_file', 'mcp__github__create_pull_request_review', 'mcp__github__close_issue', 'mcp__github__create_or_update_file',
    'mcp__gitlab__create_merge_request', 'mcp__gitlab__merge_merge_request', 'mcp__plugin_engineering_github__merge_pull_request', 'mcp__gh__write_file', 'mcp__ccd_pr__merge'], 'ask');
});

test('read tools and other servers pass', () => {
  all(['mcp__github__get_pull_request', 'mcp__github__list_issues', 'mcp__github__search_code', 'mcp__github__get_file_contents', 'mcp__gitlab__read_file', 'mcp__github__view_repo',
    'mcp__ccd_pr__get_status', 'mcp__ccd_pr__bind_pr', 'mcp__ccd_pr__set_monitor', 'mcp__scheduled-tasks__update_scheduled_task', 'mcp__Claude_Browser__navigate', 'mcp__ccd_session__set_session_title', 'Bash', 'Read'], 'allow');
});

test('off with the guard', () => {
  const off = { ...config, checks: { ...config.checks, guard: false } };
  expect(kind('mcp__github__merge_pull_request', off)).toBe('allow');
});

test('registered for PreToolUse, fail-closed, and the settings fragment routes mcp__ tools to the dispatcher', () => {
  expect(registry).toContain(mcpWrites);
  expect(mcpWrites.events).toEqual(['PreToolUse']);
  expect(mcpWrites.failClosed).toBe(true);
  const s = JSON.parse(readFileSync('templates/settings.fragment.json', 'utf8'));
  // The main PreToolUse group (fail-closed) matches mcp__ tools: Claude Code reads a matcher as a regex.
  const main = s.hooks.PreToolUse[0];
  expect(new RegExp(`^(?:${main.matcher})$`).test('mcp__ccd_pr__set_auto_merge')).toBe(true);
  expect(main.hooks[0].onFailure).toBe('block');
});
