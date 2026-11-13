import { describe, expect, test } from 'vitest';
import type { Exec } from '../../src/core/exec.js';
import { ghError, ghLogin, issueView, parsePr, pendingReview, preflight, prView, reviewComments } from '../../src/review/gh.js';

type R = ReturnType<Exec>;
const ok = (stdout: string): R => ({ status: 0, stdout });
/** A recording fake gh: `answer` maps the joined args to a reply; anything else fails as gh would. */
function fake(answer: (args: string) => R | undefined) {
  const calls: string[] = [];
  const exec: Exec = (c, a) => {
    calls.push([c, ...a].join(' '));
    return answer(a.join(' ')) ?? { status: 1, stdout: '', stderr: 'unexpected call' };
  };
  return { exec, calls };
}
const line = (o: unknown) => JSON.stringify(JSON.stringify(o)); // `--jq '.[] | tojson'` prints one JSON string per line

describe('parsePr', () => {
  test('a number or a URL of a PR in this repo', () => {
    expect(parsePr('12', 'o/r')).toBe(12);
    expect(parsePr('https://github.com/O/R/pull/12', 'o/r')).toBe(12);
  });
  test('another repo, zero and non-integers are errors', () => {
    for (const a of ['https://github.com/x/y/pull/1', '0', '1e3', '-1', '12abc', 'http://github.com/o/r/pull/1', 'https://github.com/o/r/pull/1/files', '99999999999999999999']) {
      expect(parsePr(a, 'o/r'), a).toHaveProperty('error');
    }
  });
});

describe('preflight', () => {
  test('gh missing', () => {
    const exec: Exec = () => ({ status: 127, stdout: '', missing: true });
    expect(preflight(exec)).toEqual({ error: 'review: needs the GitHub CLI (gh). Install it, run gh auth login, then run the review again.' });
  });
  test('not logged in', () => {
    const { exec } = fake((a) => (a.startsWith('auth status') ? { status: 1, stdout: '', stderr: 'You are not logged in' } : undefined));
    expect(preflight(exec)).toEqual({ error: 'review: gh is not logged in for github.com (gh auth status failed). Run gh auth login.' });
  });
  test('not a GitHub repo', () => {
    const { exec } = fake((a) => (a.startsWith('auth status') ? ok('') : undefined));
    expect(preflight(exec)).toEqual({ error: 'review: origin is not a GitHub repo' });
  });
  test('the repo', () => {
    const { exec } = fake((a) => (a.startsWith('auth status') ? ok('') : a.startsWith('repo view') ? ok('o/r\n') : undefined));
    expect(preflight(exec)).toEqual({ repo: 'o/r' });
  });
});

describe('ghError', () => {
  test('a rate limit names the reset time', () => {
    const { exec } = fake((a) => (a === 'api rate_limit --jq .resources.core.reset' ? ok('1763000000\n') : undefined));
    const msg = ghError(exec, { status: 1, stdout: '', stderr: 'gh: API rate limit exceeded for user (HTTP 403)' }, 'PR view');
    expect(msg).toContain('review: GitHub rate limit hit; resets at ');
    expect(msg).toContain(new Date(1763000000 * 1000).toLocaleString());
  });
  test('a GraphQL rate limit names the GraphQL reset time', () => {
    const { exec } = fake((a) => (a === 'api rate_limit --jq .resources.graphql.reset' ? ok('1763000000\n') : undefined));
    expect(ghError(exec, { status: 1, stdout: '', stderr: 'GraphQL: API rate limit exceeded for user ID 1.' }, 'PR view')).toBe(`review: GitHub rate limit hit; resets at ${new Date(1763000000 * 1000).toLocaleString()}`);
  });
  test('a rate limit whose reset time is unavailable says so', () => {
    const { exec } = fake(() => undefined);
    expect(ghError(exec, { status: 1, stdout: '', stderr: 'API rate limit exceeded (HTTP 429)' }, 'x')).toBe('review: GitHub rate limit hit; resets at an unknown time (gh api rate_limit failed)');
  });
  test('any other error names what, the status and the first stderr line, escaped', () => {
    const { exec } = fake(() => undefined);
    expect(ghError(exec, { status: 1, stdout: '', stderr: 'gh: Server Error \u001b[31m(HTTP 502)\nmore' }, 'PR view')).toBe('review: PR view failed (HTTP 502): gh: Server Error \\u001b[31m(HTTP 502)');
  });
});

const VIEW = {
  number: 7, state: 'OPEN', isDraft: false, isCrossRepository: true, headRepository: { name: 'r' }, headRepositoryOwner: { login: 'fork' },
  baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40), author: { login: 'dev' }, title: 'T', body: 'B', url: 'https://github.com/o/r/pull/7',
  labels: [{ name: 'needs-human' }], closingIssuesReferences: [{ number: 3, repository: { name: 'r', owner: { login: 'o' } } }, { number: 4, url: 'https://github.com/x/y/issues/4' }, { number: 5 }], comments: [{ body: 'c1' }], reviews: [{ body: 'r1' }, { body: '' }],
};

describe('prView', () => {
  test('maps the fields', () => {
    const { exec, calls } = fake((a) => (a.startsWith('pr view 7') ? ok(JSON.stringify(VIEW)) : undefined));
    expect(prView(exec, 'o/r', 7)).toEqual({
      number: 7, state: 'OPEN', isDraft: false, isCrossRepository: true, headRepository: 'fork/r', baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefOid: 'b'.repeat(40),
      author: 'dev', title: 'T', body: 'B', url: 'https://github.com/o/r/pull/7', labels: ['needs-human'], closingIssues: [{ number: 3, repo: 'o/r' }, { number: 4, repo: 'x/y' }, { number: 5, repo: '' }], comments: ['c1'], reviews: ['r1', ''],
    });
    expect(calls[0]).toBe('gh pr view 7 --repo o/r --json number,state,isDraft,isCrossRepository,headRepository,headRepositoryOwner,baseRefName,baseRefOid,headRefOid,author,title,body,url,labels,closingIssuesReferences,comments,reviews');
  });
  test('not found', () => {
    const { exec } = fake((a) => (a.startsWith('pr view') ? { status: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 9.' } : undefined));
    expect(prView(exec, 'o/r', 9)).toEqual({ error: 'review: PR #9 not found in o/r: GraphQL: Could not resolve to a PullRequest with the number of 9.' });
  });
  test('a bad shape is an error, not a guess', () => {
    const { exec } = fake((a) => (a.startsWith('pr view') ? ok(JSON.stringify({ ...VIEW, baseRefOid: 'nope' })) : undefined));
    expect(prView(exec, 'o/r', 7)).toEqual({ error: 'review: gh pr view returned an unexpected shape' });
    const { exec: e2 } = fake((a) => (a.startsWith('pr view') ? ok('not json') : undefined));
    expect(prView(e2, 'o/r', 7)).toEqual({ error: 'review: gh pr view returned an unexpected shape' });
  });
});

describe('the other reads', () => {
  test('review comments keep multi-line bodies whole', () => {
    const { exec, calls } = fake((a) => (a.startsWith('api --paginate repos/o/r/pulls/7/comments') ? ok(`${JSON.stringify('a\nb')}\n${JSON.stringify('c')}\n`) : undefined));
    expect(reviewComments(exec, 'o/r', 7)).toEqual(['a\nb', 'c']);
    expect(calls[0]).toBe("gh api --paginate repos/o/r/pulls/7/comments --jq .[].body | tojson");
  });
  test('issue and login', () => {
    const { exec, calls } = fake((a) => (a.startsWith('issue view 3') ? ok('{"title":"I","body":"IB"}') : a === 'api user --jq .login' ? ok('me\n') : undefined));
    expect(issueView(exec, 'o/r', 3)).toEqual({ title: 'I', body: 'IB' });
    expect(calls[0]).toBe('gh issue view 3 --repo o/r --json title,body');
    expect(ghLogin(exec)).toBe('me');
  });
  test('pendingReview is the PENDING review of this login only', () => {
    const reviews = [
      { id: 1, node_id: 'N1', state: 'PENDING', user: { login: 'other' } },
      { id: 2, node_id: 'N2', state: 'COMMENTED', user: { login: 'me' } },
      { id: 3, node_id: 'N3', state: 'PENDING', user: { login: 'me' } },
    ];
    const { exec } = fake((a) =>
      a.startsWith('api --paginate repos/o/r/pulls/7/reviews/3/comments') ? ok('11\n12\n') : a.startsWith('api --paginate repos/o/r/pulls/7/reviews') ? ok(reviews.map(line).join('\n')) : undefined);
    expect(pendingReview(exec, 'o/r', 7, 'me')).toEqual({ id: 3, node_id: 'N3', comments: 2 });
    expect(pendingReview(exec, 'o/r', 7, 'nobody')).toBeNull();
  });
});
