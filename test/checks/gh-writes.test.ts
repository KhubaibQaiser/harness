// Owner ruling 2026-11-13: the guard asks before gh/hub commands that change shared state, gh api writes and GitLab push
// options; reads stay allowed; the pr-body denies stay and a deny beats the ask.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { loadConfig } from '../../src/core/config.js';
import { dispatch, registry } from '../../src/hooks/dispatch.js';

const config = loadConfig('/nonexistent-harness-root').config;
const guard = (c: string) => decideCommand(c, { config, env: {}, root: '/p' });
const all = (cs: string[], want: string) => { for (const c of cs) expect(guard(c).kind, c).toBe(want); };

const WRITES = [
  'gh pr merge 12', 'gh pr close 12', 'gh pr reopen 12', 'gh pr review 12 --approve', 'gh pr comment 12 -b hi', 'gh pr edit 12 --add-label x', 'gh pr ready 12', 'gh pr lock 12', 'gh pr unlock 12',
  'gh issue close 3', 'gh issue delete 3', 'gh issue edit 3 --title t', 'gh issue comment 3 -b hi', 'gh issue transfer 3 o/r', 'gh issue lock 3', 'gh issue pin 3',
  'gh release create v1', 'gh release edit v1 --draft=false', 'gh release delete v1', 'gh release upload v1 a.zip',
  'gh repo delete o/r --yes', 'gh repo edit --visibility public', 'gh repo archive o/r', 'gh repo rename new', 'gh repo sync', 'gh repo deploy-key add k.pub', 'gh repo deploy-key delete 1',
  'gh secret set TOKEN', 'gh secret delete TOKEN', 'gh variable set X', 'gh variable delete X', 'gh label create bug', 'gh label edit bug', 'gh label delete bug', 'gh label clone o/r',
  'gh workflow run ci.yml', 'gh workflow enable ci.yml', 'gh workflow disable ci.yml', 'gh run rerun 9', 'gh run cancel 9', 'gh run delete 9',
  'gh cache delete key', 'gh gist create a.txt', 'gh gist edit 1', 'gh gist delete 1', 'gh alias set co "pr checkout"', 'gh alias delete co', 'gh alias import a.yml',
];
const READS = [
  'gh pr view 12', 'gh pr list', 'gh pr diff 12', 'gh pr checks 12', 'gh pr status', 'gh issue view 3', 'gh issue list', 'gh release list', 'gh release view v1', 'gh repo view',
  'gh repo deploy-key list', 'gh secret list', 'gh variable list', 'gh variable get X', 'gh label list', 'gh workflow list', 'gh workflow view ci.yml', 'gh run list', 'gh run view 9',
  'gh run watch 9', 'gh cache list', 'gh gist list', 'gh gist view 1', 'gh alias list', 'gh ruleset list', 'gh ruleset view 1', 'gh ruleset check', 'gh auth status', 'gh search prs x',
];

describe('gh writes ask, reads stay allowed', () => {
  test('each listed write asks', () => all(WRITES, 'ask'));
  test('every read form stays allowed', () => all(READS, 'allow'));
  test('pr create/new stay allowed by the guard (the pr-body check gates them)', () => all(['gh pr create --body-file b.md', 'gh pr new -F b.md'], 'allow'));
  test('repo-level flags before the subcommand are read the getopt way', () => all(['gh pr -R o/r merge 1', 'gh --repo o/r issue close 3', 'gh pr --repo=o/r close 1'], 'ask'));
  test('wrapper and path forms decide the same', () => {
    all(['env gh pr merge 1', 'env GH_TOKEN=x /usr/bin/gh pr merge 1', 'nice gh issue close 3', '"gh" pr close 2', '/opt/homebrew/bin/gh release delete v1', 'command gh api -X DELETE repos/o/r'], 'ask');
    all(['env gh pr view 1', '/usr/bin/gh api repos/o/r'], 'allow');
  });
});

describe('gh api asks unless clearly a read', () => {
  test('an explicit non-GET method, in every spelling', () => all(['gh api -X POST repos/o/r/issues', 'gh api --method DELETE repos/o/r', 'gh api --method=PUT repos/o/r/topics', 'gh api -XPATCH repos/o/r', 'gh api -X post x'], 'ask'));
  test('fields or an input body (gh then defaults to POST)', () => all(['gh api repos/o/r/issues -f title=x', 'gh api repos/o/r/labels -F name=bug', 'gh api x --field a=b', 'gh api x --raw-field a=b', 'gh api x --input body.json'], 'ask'));
  test('a GraphQL mutation asks; a GraphQL query, even with -f, is a read', () => {
    all(["gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'", 'gh api graphql -f query=@m.graphql', 'gh api graphql --input q.json'], 'ask');
    all(["gh api graphql -f query='query { viewer { login } }'", "gh api graphql -f query='{ viewer { login } }' -F n=5", 'gh api repos/o/r', 'gh api -X GET search/issues -f q=bug', 'gh api --paginate repos/o/r/pulls'], 'allow');
  });
});

describe('hub writes and GitLab push options ask', () => {
  test('hub', () => {
    all(['hub pull-request -m t', 'hub merge https://github.com/o/r/pull/1', 'hub release create v1', 'hub release edit v1', 'hub release delete v1', 'hub api -X DELETE repos/o/r', 'hub api repos/o/r/issues -f title=x'], 'ask');
    all(['hub release', 'hub release show v1', 'hub api repos/o/r', 'hub browse', 'hub ci-status'], 'allow');
  });
  test('git push -o merge_request.*', () => {
    all(['git push -o merge_request.create', 'git push -o merge_request.merge_when_pipeline_succeeds origin feat', 'git push --push-option=merge_request.create', 'git push -omerge_request.target=main'], 'ask');
    all(['git push -o ci.skip origin feat', 'git push origin feat'], 'allow');
  });
});

describe('a deny beats the ask; unattended follows the ask rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-ghw-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n  prBody: true\n');
  const run = async (command: string, env: NodeJS.ProcessEnv = {}) => {
    const input = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command } };
    const out = await dispatch(JSON.stringify(input), registry, env, { home: root });
    return out ? (JSON.parse(out).hookSpecificOutput?.permissionDecision ?? '') : 'allow';
  };
  test('pr merge --auto / --admin and --remove-label needs-human still deny', async () => {
    for (const c of ['gh pr merge --auto 1', 'gh pr merge 1 --admin', 'gh pr edit 1 --remove-label needs-human']) expect(await run(c), c).toBe('deny');
  });
  test('an attended ask asks; unattended it is denied', async () => {
    expect(await run('gh pr close 1')).toBe('ask');
    expect(await run('gh pr close 1', { HARNESS_UNATTENDED: '1' })).toBe('deny');
  });
});
