import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { review } from '../../src/cli/review.js';
import { defaultExec, type Exec } from '../../src/core/exec.js';
import { packageDir } from '../../src/core/package-dir.js';
import { commit, git, repoWith, type Files } from './repo.js';

// Synthetic repos: the remote's URL is github.com/o/r, which `url.<bare>.insteadOf` sends to a local bare repo (no network), and a fake gh.
export const GH = 'https://github.com/o/r.git';
export const TOKEN = 'ghp_' + 'x'.repeat(36);
export const AGENT = readFileSync(join(packageDir('templates'), 'agents/staff-reviewer.md'), 'utf8'); // the plugin's copy, as an up-to-date install has it
export const BASE: Files = {
  '.harness/config.yaml': 'version: 1\n', '.harness/manifest.json': '{}\n', '.claude/agents/staff-reviewer.md': AGENT, '.claude/agents/review-judge.md': 'judge\n', '.claude/skills/review-rubric/SKILL.md': 'RUBRIC TEXT\n', 'AGENTS.md': 'AGENTS TEXT\n',
  '.harness/hooks/dispatch.mjs': 'd\n', 'src/a.ts': 'a\n', 'docs/spec.md': 'old spec\n',
};
export const HEAD: Files = { 'src/a.ts': `a\nconst t = '${TOKEN}';\n`, 'docs/spec.md': 'SPEC TEXT\n', 'pnpm-lock.yaml': 'lock\n' };
/** `tip`: main moves past the PR's base commit with these files. `fork`: the clone's `origin` is the person's fork and o/r is `upstream`. */
export function setup(o: { base?: Files; head?: Files; tip?: Files; fork?: boolean } = {}) {
  const w = repoWith({ ...BASE, ...o.base }, { ...HEAD, ...o.head });
  let tip = w.base;
  if (o.tip) {
    git(w.root, 'checkout', '-q', '-b', 'tip', w.base);
    tip = commit(w.root, o.tip, 'main moves on');
  }
  const bare = mkdtempSync(join(tmpdir(), 'h-origin-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(w.root, 'push', '-q', bare, `${tip}:refs/heads/main`, `${w.head}:refs/pull/7/head`);
  const root = mkdtempSync(join(tmpdir(), 'h-clone-'));
  execFileSync('git', ['clone', '-q', bare, root], { stdio: 'ignore' });
  git(root, 'config', `url.${bare}.insteadOf`, GH);
  if (o.fork) {
    git(root, 'remote', 'rename', 'origin', 'upstream');
    git(root, 'remote', 'set-url', 'upstream', GH);
    git(root, 'remote', 'add', 'origin', 'https://github.com/me/r.git');
    git(root, 'config', `url.${join(root, 'no-such-repo')}.insteadOf`, 'https://github.com/me/r.git'); // a fetch from the fork fails locally
  } else git(root, 'remote', 'set-url', 'origin', GH);
  mkdirSync(join(root, '.harness/tmp/w-1'), { recursive: true });
  return { root, bare, base: w.base, head: w.head, tip, dir: '.harness/tmp/w-1' };
}
export type R = ReturnType<Exec>;
export const ok = (stdout: string): R => ({ status: 0, stdout });
export function fakeGh(s: { base: string; head: string }, view: Record<string, unknown> = {}, over: (a: string) => R | undefined = () => undefined) {
  const calls: string[] = [];
  const pr = {
    number: 7, state: 'OPEN', isDraft: false, isCrossRepository: false, headRepository: { name: 'r' }, headRepositoryOwner: { login: 'o' }, baseRefName: 'main',
    baseRefOid: s.base, headRefOid: s.head, author: { login: 'dev' }, title: 'Add a thing', body: 'See docs/spec.md for the plan.', url: 'https://github.com/o/r/pull/7',
    labels: [], closingIssuesReferences: [{ number: 3, repository: { name: 'r', owner: { login: 'o' } } }], comments: [{ body: 'a comment' }], reviews: [], ...view,
  };
  const exec: Exec = (c, a, o) => {
    if (c !== 'gh') return defaultExec(c, a, o);
    const j = a.join(' ');
    calls.push(j);
    return over(j) ?? (j.startsWith('auth status') ? ok('') : j.startsWith('repo view') ? ok('o/r\n') : j.startsWith('pr view') ? ok(JSON.stringify(pr))
      : j.startsWith('api --paginate repos/o/r/pulls/7/comments') ? ok(`${JSON.stringify('inline note')}\n`) : j.startsWith('issue view 3 --repo o/r') ? ok('{"title":"Issue","body":"issue body"}')
      : { status: 1, stdout: '', stderr: `unexpected gh ${j}` });
  };
  return { exec, calls };
}
export function run(s: ReturnType<typeof setup>, exec: Exec, env: NodeJS.ProcessEnv = {}, nonce?: () => string, version?: string) {
  const lines: string[] = [];
  const code = review(['7', '--out', s.dir], { root: s.root, env, out: (l) => lines.push(l) }, { exec, ...(nonce && { nonce }), ...(version && { version }) });
  return { code, lines, read: (f: string) => readFileSync(join(s.root, s.dir, f), 'utf8') };
}
