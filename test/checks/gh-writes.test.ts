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

describe('round 1 (owner ruling): an allow-list, so only known reads run freely', () => {
  test('aliases, uncovered and unknown subcommands, extensions and user aliases ask', () => {
    all(['gh release new v1', 'gh gist new f', 'gh pr update-branch 1', 'gh pr revert 1', 'gh discussion create -t x', 'gh discussion comment 1 -b x', 'gh project item-add 1 --owner o --url u',
      'gh project delete 1', 'gh repo autolink create x y', 'gh repo fork o/r', 'gh repo create x --public', 'gh repo new x', 'gh issue create -t x', 'gh issue new -t x', 'gh issue develop 1',
      'gh ssh-key add k.pub', 'gh gpg-key add k', 'gh codespace delete -c x', 'gh cs delete -c x', 'gh agent-task create "do x"', 'gh skill publish', 'gh extension install o/gh-x', 'gh ext install o/x',
      'gh extension exec x', 'gh x-merge 1', 'gh co 1', 'gh secret remove X', 'gh auth logout', 'gh config set editor vim'], 'ask');
  });
  test('ls aliases, group aliases, help and version forms read', () => {
    all(['gh secret ls', 'gh variable ls', 'gh label ls', 'gh rs ls', 'gh ruleset view 1', 'gh cs ls', 'gh ext ls', 'gh pr', 'gh', 'gh --help pr merge 1', 'gh pr merge --help',
      'gh pr merge -h', 'gh help pr merge', 'gh --version', 'gh repo deploy-key ls', 'gh repo gitignore view Go', 'gh repo clone o/r', 'gh pr checkout 1', 'gh run download 9', 'gh browse'], 'allow');
    expect(guard('gh pr comment 1 -b --help').kind).toBe('ask'); // --help as another option's value is not help
  });
  test('quoted, escaped and ANSI-C spellings, and gh right after an unknown head', () => {
    all(["gh $'pr' merge 1", "gh pr $'\\x6derge' 1", "$'\\x67h' pr merge 1", 'g\\h pr merge 1', "gh pr 'merge' 1", 'zzwrap gh pr merge 1', 'zzwrap /opt/homebrew/bin/gh pr merge 1'], 'ask');
    all(['echo gh pr merge 1', 'man gh', 'which gh', 'grep -r "gh pr merge" docs'], 'allow');
  });
  test('gh api GraphQL with fields is a read only for one literal query word with no mutation', () => {
    all(['Q=\'mutation{x}\'; gh api graphql -f query="$Q"', 'gh api graphql -f query="$(cat m.gql)"', "gh api graphql -f query=$'mut\\x61tion{x}'", "gh api graphql -f query='mut''ation{x}'",
      "gh api graphql -f query='#c\nmutation{x}'", 'gh api https://api.github.com/graphql -f query=\'mutation{x}\'',
      'gh api -H "X-HTTP-Method-Override: POST" repos/o/r', 'gh api x -X GET -X POST'], 'ask');
    all(["gh api graphql -f query='query{viewer{login}}'", "gh api /graphql -f query='{x}'", 'gh api x -X POST -X GET', "gh api graphql -f query='query($n:Int){x}' -F n=5"], 'allow'); // $ in single quotes is literal (round 2)
  });
});

describe('round 2', () => {
  test('gh anywhere after a runner head the guard does not know is read', () => {
    all(['op run -- gh pr merge 1', 'doppler run -- gh pr merge 1', 'direnv exec . gh pr merge 1', 'aws-vault exec p -- gh pr merge 1', 'dotenv -- gh pr merge 1', 'zzwrap -q gh pr merge 1',
      'op run -- hub pull-request -m x'], 'ask');
    all(['op run -- gh pr view 1', 'mkdir gh', 'cd gh && ls', 'echo gh pr merge 1', 'grep gh pr merge', 'cat gh pr merge', 'brew install gh'], 'allow');
  });
  test('a GraphQL query counts as built at run time only for a $ or backtick outside single quotes', () => {
    all(["gh api graphql -f query='query($o:String!){user(login:$o){id}}' -F o=x", "gh api graphql -F owner=o -f query='query($owner:String!){user(login:$owner){id}}'"], 'allow');
    all(['gh api graphql -f query="query($o:String!){x}" -F o=x', 'gh api graphql -f query="query{x}" -F o=$O', "gh api graphql -f query=$'query{x}'", "gh api graphql -f query='query($o:String!){x}' -F o=`cat f`"], 'ask');
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
  test('git push -o merge_request.*, also set by git -c or git config', () => {
    all(['git push -o merge_request.create', 'git push -o merge_request.merge_when_pipeline_succeeds origin feat', 'git push --push-option=merge_request.create', 'git push -omerge_request.target=main',
      'git -c push.pushOption=merge_request.create push', 'git -c push.pushoption=merge_request.create push origin x', 'git config push.pushOption merge_request.create'], 'ask');
    all(['git push -o ci.skip origin feat', 'git push origin feat', 'git -c push.pushOption=ci.skip push', 'git config push.pushOption ci.skip'], 'allow');
  });
  test('hub: own commands are an allow-list; its git passthrough follows the git rules', () => {
    all(['hub delete o/r', 'hub create', 'hub fork', 'hub gist create f', 'hub sync', 'hub issue create -m x', 'hub issue update 1 -s closed', 'hub pr merge 1'], 'ask');
    all(['hub push -f', 'hub push origin main', 'hub push --force origin feat'], 'deny');
    all(['hub pr checkout 1', 'hub pr list', 'hub issue', 'hub issue show 1', 'hub push origin feat', 'hub status', 'hub clone o/r'], 'allow');
  });
});

// Task 4 residual: origin's remote-tracking refs vouch for a task contract (loadContract), so repointing them asks.
describe('commands that can repoint refs/remotes/* ask', () => {
  test('update-ref and symbolic-ref on refs/remotes, remote add/set-url/rename/set-head, fetch of a URL or refspec, remote config', () => {
    all(['git update-ref refs/remotes/origin/main HEAD', 'git update-ref -d refs/remotes/origin/main', 'git update-ref -m x refs/remotes/origin/main abc', 'git update-ref --no-deref Refs//Remotes/origin/main HEAD',
      'git update-ref --stdin', 'git update-ref -z --stdin', 'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/feat', 'git symbolic-ref -m x refs/remotes/origin/HEAD refs/remotes/origin/feat',
      'git remote add evil /tmp/x', 'git remote set-url origin /tmp/x', 'git remote -v rename origin old', 'git remote set-head origin feat', 'git remote set-head origin --auto',
      'git fetch /tmp/forged', 'git fetch ../forged', 'git fetch https://example.com/r.git', 'git fetch git@example.com:o/r.git', 'git fetch origin +refs/heads/x:refs/remotes/origin/main', 'git fetch origin x:y',
      'git fetch --refmap=+refs/heads/*:refs/remotes/origin/* origin', 'git fetch --multiple origin /tmp/x', 'git pull /tmp/forged main', 'git pull origin x:refs/remotes/origin/main',
      'git -c remote.origin.url=/tmp/x fetch', 'git -c remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main fetch origin', 'git -c url./tmp/x.insteadOf=https://github.com/ fetch',
      'git config remote.origin.url /tmp/x', 'git config set remote.origin.fetch +refs/heads/x:refs/remotes/origin/main', 'git config --add remote.origin.fetch +refs/heads/x:refs/remotes/origin/main',
      'git config -f .git/config url./tmp/x.insteadOf https://github.com/'], 'ask');
  });
  test('wrapper, path and nested forms decide the same', () => {
    all(['env git update-ref refs/remotes/origin/main HEAD', 'nice git remote set-url origin /tmp/x', '/usr/bin/git fetch /tmp/x', '"git" remote add e /tmp/x', 'g\\it remote add e /tmp/x',
      'git -C sub fetch ../x main:refs/remotes/origin/main', 'hub remote add e /tmp/x', 'sh -c "git remote add e /tmp/x"', 'true && git update-ref refs/remotes/origin/main HEAD', 'timeout 5 git fetch /tmp/x'], 'ask');
  });
  test('ordinary fetch, pull and remote reads stay allowed', () => {
    all(['git fetch', 'git fetch origin', 'git fetch --all --prune', 'git fetch origin main', 'git fetch -q origin', 'git fetch --depth 1 origin', 'git fetch -j 4 origin', 'git pull', 'git pull origin main',
      'git pull --rebase origin main', 'git remote', 'git remote -v', 'git remote show origin', 'git remote prune origin', 'git remote get-url origin', 'git update-ref refs/heads/x HEAD',
      'git symbolic-ref refs/remotes/origin/HEAD', 'git symbolic-ref --short HEAD', 'git config remote.origin.url', 'git config --get remote.origin.url', 'git config get remote.origin.fetch',
      'echo git remote add e /tmp/x'], 'allow');
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
    expect(await run('git remote set-url origin /tmp/x')).toBe('ask');
  });
  test('a refs/remotes ask is denied unattended, with its own reason', async () => {
    writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\nsandbox: off\n');
    const input = { hook_event_name: 'PreToolUse', session_id: 's2', cwd: root, tool_name: 'Bash', tool_input: { command: 'git update-ref refs/remotes/origin/main HEAD' } };
    const out = JSON.parse(await dispatch(JSON.stringify(input), registry, { HARNESS_UNATTENDED: '1' }, { home: root })).hookSpecificOutput;
    expect(out).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/^Unattended run: .*git update-ref refs\/remotes\/origin\/main can repoint a remote-tracking ref/) });
    expect(await run('git fetch origin', { HARNESS_UNATTENDED: '1' })).toBe('allow');
  });
});
