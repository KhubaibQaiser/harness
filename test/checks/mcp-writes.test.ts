// Owner ruling 2026-11-13 (allow-list): on a git-host server only read tools pass; an opaque (uuid) server asks on any
// write verb; auto-merge with a write verb is denied anywhere. Names are split at `_`, `-`, `.` and camelCase.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { mcpWrites } from '../../src/checks/mcp-writes.js';
import { loadConfig } from '../../src/core/config.js';
import { type Ctx, registry } from '../../src/hooks/dispatch.js';

const config = loadConfig('/nonexistent-harness-root').config;
const kind = (tool_name: string, cfg = config) =>
  (mcpWrites.run({ input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name, tool_input: {} }, root: '/p', config: cfg, env: {}, unattended: false } as unknown as Ctx) as { kind: string }).kind;
const all = (names: string[], want: string) => { for (const n of names) expect(kind(n), n).toBe(want); };
const UUID = 'mcp__3d57cafd-7a19-4c22-839e-5d410b830996';

test('auto-merge with a write verb is denied, whatever the server and spelling', () => {
  all(['mcp__ccd_pr__set_auto_merge', 'mcp__github__enable_auto_merge', 'mcp__gitlab__set_automerge', 'mcp__x__enable-auto-merge', 'mcp__x__enableAutoMerge',
    'mcp__plugin_engineering_github__enable_pull_request_auto_merge', 'mcp__github__enable_pr_auto_merge'], 'deny');
  all(['mcp__renovate__get_automerge_config', 'mcp__docs__search_automerge_docs'], 'allow'); // a read verb first
  all(['mcp__x__autoMerge', 'mcp__x__auto_merge', 'mcp__x__AutoMerge', 'mcp__x__automerge_pr'], 'deny'); // only auto-merge, no read verb first (round 2)
});

test('on a git-host server everything but a read tool asks', () => {
  all(['mcp__github__merge_pull_request', 'mcp__github__run_workflow', 'mcp__github__star_repository', 'mcp__github__mark_all_notifications_read', 'mcp__github__issue_write',
    'mcp__github__set_issue_fields', 'mcp__github__rebase_pull_request', 'mcp__github__put_file', 'mcp__github__graphql', 'mcp__github__execute', 'mcp__github__squash', 'mcp__github__mergepr',
    'mcp__GitHub__MergePullRequest', 'mcp__github__mergePullRequest', 'mcp__github__merge-pull-request', 'mcp__github__pulls.merge', 'mcp__claude_ai_GitHub__merge_pull_request',
    'mcp__gitea__create_issue', 'mcp__bitbucket__merge', 'mcp__forgejo__merge_pull_request', 'mcp__codeberg__add_comment', 'mcp__gitlab__accept_mr', 'mcp__gh__write_file',
    'mcp__ccd_pr__merge', 'mcp__ccd_pr__bind_pr', 'mcp__octo__create_pull_request'], 'ask');
  all(['mcp__github__get_pull_request', 'mcp__github__list_issues', 'mcp__github__search_code', 'mcp__github__pull_request_read', 'mcp__github__issue_read', 'mcp__github__get_file_contents',
    'mcp__github__download_workflow_run_artifact', 'mcp__github__getPullRequest', 'mcp__gitlab__describe_project', 'mcp__ccd_pr__get_status', 'mcp__gh_docs__search'], 'allow');
});

test('an opaque (uuid) server asks on any write verb; other named servers pass', () => {
  all([`${UUID}__issue_write`, `${UUID}__push_files`, `${UUID}__add_issue_comment`, `${UUID}__runQuery`], 'ask');
  all([`${UUID}__get_issue`, 'mcp__notion__create_page', 'mcp__asana__update_task', 'mcp__linear__create_issue', 'mcp__jira__add_comment', 'mcp__slack__post_message', 'mcp__vercel__deploy_repo',
    'mcp__repomix__pack_repository', 'mcp__pr_review_bot__create_note', 'mcp__scheduled-tasks__update_scheduled_task', 'mcp__Claude_Browser__navigate', 'Bash', 'Read'], 'allow');
});

test('off with the guard', () => {
  const off = { ...config, checks: { ...config.checks, guard: false } };
  expect(kind('mcp__ccd_pr__set_auto_merge', off)).toBe('allow');
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
