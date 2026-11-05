import { expect, test } from 'vitest';
import { DIR_JQ } from '../../src/catalog/resolve.js';
import type { Exec } from '../../src/core/exec.js';
import { parseTarget, resolveTarget, vetId, type Target } from '../../src/vet/target.js';

const S = 'b'.repeat(40);
const M = 'c'.repeat(40);
const VER = ' Check your network or run gh auth status, then try again.';
const URL = " Pass the plugin's GitHub URL instead.";
const BAD = 'Not a GitHub repo, tree URL or plugin@marketplace:';
const fake = (answer: (cmd: string, args: string[]) => ReturnType<Exec>) => {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => (calls.push([cmd, ...args]), answer(cmd, args));
  return { exec, calls };
};
const ok = (stdout: string) => ({ status: 0, stdout });

test('parse accepted forms', () => {
  expect(parseTarget('https://github.com/o/r')).toEqual({ kind: 'repo', repo: 'o/r', path: '' });
  expect(parseTarget('https://github.com/o/r/tree/v1/plugins/x')).toEqual({ kind: 'repo', repo: 'o/r', ref: 'v1', path: 'plugins/x' });
  expect(parseTarget('o/r#dev')).toEqual({ kind: 'repo', repo: 'o/r', ref: 'dev', path: '' });
  expect(parseTarget('o/r')).toEqual({ kind: 'repo', repo: 'o/r', path: '' });
  expect(parseTarget('p@m')).toEqual({ kind: 'plugin', name: 'p', market: 'm' });
});

test.each(['o/r#../x', 'o/r#a?b', 'o/r#', 'https://github.com/o/r/tree/v1/../../etc', '../r', 'https://gitlab.com/o/r', 'a b'])('parse rejects %s', (s) => {
  const r = parseTarget(s) as { error: string };
  expect(r.error.startsWith(BAD)).toBe(true);
});

test('pin default branch', () => {
  const { exec, calls } = fake((_c, a) => ok(a[1] === 'repos/o/r' ? 'main\n' : `${S}\n`));
  expect(resolveTarget({ kind: 'repo', repo: 'o/r', path: '' }, exec)).toEqual({ repo: 'o/r', ref: 'main', sha: S, path: '' });
  expect(calls).toEqual([['gh', 'api', 'repos/o/r', '--jq', '.default_branch'], ['gh', 'api', 'repos/o/r/commits/main', '--jq', '.sha']]);
});

test('pin named ref makes one call', () => {
  const { exec, calls } = fake(() => ok(S));
  expect(resolveTarget({ kind: 'repo', repo: 'o/r', ref: 'v1', path: 'x' }, exec)).toEqual({ repo: 'o/r', ref: 'v1', sha: S, path: 'x' });
  expect(calls).toHaveLength(1);
});

const T: Target = { kind: 'repo', repo: 'o/r', ref: 'main', path: '' };
test('pin errors', () => {
  expect(resolveTarget(T, fake(() => ok('nope')).exec)).toEqual({ error: 'o/r: could not verify main (gh returned no commit sha).' + VER });
  expect(resolveTarget(T, fake(() => ({ status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' })).exec)).toEqual({ error: 'o/r: main not found on GitHub. Check the URL or ref.' });
  expect(resolveTarget(T, fake(() => ({ status: 1, stdout: '', stderr: 'HTTP 403 rate limit\nmore' })).exec)).toEqual({ error: 'o/r: could not verify main (gh exited 1): HTTP 403 rate limit.' + VER });
  expect(resolveTarget(T, fake(() => ({ status: 127, stdout: '', missing: true })).exec)).toEqual({ error: 'harness vet needs the GitHub CLI (gh). Install the GitHub CLI (gh), then run harness vet again.' });
});

const P: Target = { kind: 'plugin', name: 'p', market: 'm' };
const list = JSON.stringify([{ name: 'm', source: 'github', repo: 'mo/mr' }]);
const market = (source: unknown, extra: unknown[] = []) => (cmd: string, a: string[]) => {
  if (cmd === 'claude') return ok(list);
  if (a[1] === 'repos/mo/mr/commits/' + 'main') return ok(M);
  if (a[1] === `repos/o/r/commits/${S}` && !extra.includes('404')) return ok(S);
  if (a[1] === 'repos/mo/mr') return ok('main');
  if (a[1].includes('marketplace.json')) return ok(JSON.stringify({ plugins: [...extra, { name: 'p', source }] }));
  return { status: 1, stdout: '', stderr: 'HTTP 404' };
};

test('marketplace git-subdir with sha', () => {
  const { exec, calls } = fake(market({ source: 'git-subdir', url: 'https://github.com/o/r.git', path: 'x', sha: S }));
  expect(resolveTarget(P, exec)).toEqual({ repo: 'o/r', path: 'x', ref: S, sha: S, name: 'p', market: 'm', marketRepo: 'mo/mr', follows: null });
  expect(calls[0]).toEqual(['claude', 'plugin', 'marketplace', 'list', '--json']);
  expect(calls).toContainEqual(['gh', 'api', `repos/mo/mr/contents/.claude-plugin/marketplace.json?ref=${M}`, '-H', 'Accept: application/vnd.github.raw']);
});

test('marketplace github source uses sha ?? ref', () => {
  const r = resolveTarget(P, fake(market({ source: 'github', repo: 'o/r', sha: S })).exec);
  expect(r).toEqual({ repo: 'o/r', path: '', ref: S, sha: S, name: 'p', market: 'm', marketRepo: 'mo/mr', follows: null });
  const { exec } = fake((c, a) => (c === 'gh' && a[1] === 'repos/o/r/commits/v2' ? ok(S) : market({ source: 'github', repo: 'o/r', ref: 'v2' })(c, a)));
  expect(resolveTarget(P, exec)).toMatchObject({ repo: 'o/r', ref: 'v2', sha: S, follows: 'v2' });
});

test('relative-path source', () => {
  const { exec, calls } = fake((c, a) => (a?.[1]?.includes('/contents/plugins/x') ? ok('dir') : market('./plugins/x')(c, a)));
  expect(resolveTarget(P, exec)).toEqual({ repo: 'mo/mr', path: 'plugins/x', ref: M, sha: M, name: 'p', market: 'm', marketRepo: 'mo/mr' });
  expect(calls).toContainEqual(['gh', 'api', `repos/mo/mr/contents/plugins/x?ref=${M}`, '--jq', DIR_JQ]);
  for (const s of ['./', '.']) {
    const f = fake(market(s));
    expect(resolveTarget(P, f.exec)).toMatchObject({ path: '', sha: M });
    expect(f.calls.some((c) => c[2]?.includes('/contents/') && !c[2].includes('marketplace.json'))).toBe(false);
  }
});

test('relative-path errors', () => {
  const f = fake(market('./plugins/../x'));
  expect(resolveTarget(P, f.exec)).toEqual({ error: 'Plugin "p" in "m" has a path outside the marketplace: "./plugins/../x".' + URL });
  expect(f.calls.some((c) => c[2]?.includes('/contents/plugins'))).toBe(false);
  expect(resolveTarget(P, fake(market('./plugins/x')).exec)).toEqual({ error: `Plugin "p" in "m": plugins/x not found in mo/mr at ${M.slice(0, 7)}.` + URL });
  const g = fake((c, a) => (a?.[1]?.includes('/contents/plugins/x') ? ok('file') : market('./plugins/x')(c, a)));
  expect(resolveTarget(P, g.exec)).toEqual({ error: `Plugin "p" in "m": plugins/x is not a folder in mo/mr at ${M.slice(0, 7)}.` + URL });
});

test('marketplace errors', () => {
  expect(resolveTarget(P, fake(market({ source: 'npm', package: 'z' })).exec)).toEqual({ error: 'Plugin "p" in "m" has a npm source; vet checks github, git-subdir and relative-path sources only.' + URL });
  const dir = fake((c) => (c === 'claude' ? ok(JSON.stringify([{ name: 'm', source: 'directory', path: '/x' }])) : ok('')));
  expect(resolveTarget(P, dir.exec)).toEqual({ error: 'Marketplace "m" has a directory source; vet reads GitHub marketplaces only.' + URL });
  const none = fake((c, a) => (c === 'gh' && a[1].includes('marketplace.json') ? ok('{"plugins":[]}') : market(null)(c, a)));
  expect(resolveTarget(P, none.exec)).toEqual({ error: 'Plugin "p" is not in marketplace "m". Check the plugin name, or pass the plugin\'s GitHub URL instead.' });
});

test('marketplace not installed', () => {
  const msg = 'Marketplace "m" is not installed. Run harness vet with the plugin\'s GitHub URL instead, such as https://github.com/<owner>/<repo>.';
  const a = fake(() => ok('[]'));
  expect(resolveTarget(P, a.exec)).toEqual({ error: msg });
  const b = fake(() => ({ status: 127, stdout: '', missing: true }));
  expect(resolveTarget(P, b.exec)).toEqual({ error: msg });
  expect(a.calls.concat(b.calls).every((c) => c[0] === 'claude')).toBe(true);
});

test('messages escape user text', () => {
  const r = resolveTarget({ kind: 'plugin', name: 'p', market: 'm‮' }, fake(() => ok('[]')).exec) as { error: string };
  expect(r.error).toContain('m\\u202e');
  expect((parseTarget('x​') as { error: string }).error).toContain('\\u200b');
});

test('vetId', () => {
  const r = { repo: 'O/R', ref: 'main', sha: S, path: 'Plugins/x y' };
  expect(vetId(r)).toBe('o-r-plugins-x-y');
  expect(vetId({ ...r, path: '' })).toBe('o-r');
  expect(vetId({ ...r, name: 'My:Plug' })).toBe('my-plug');
});

test.each(['../x', '..', './..', './a/./b', './a//b'])('relative source %s is outside the marketplace, no gh call past marketplace.json', (src) => {
  const f = fake(market(src));
  expect(resolveTarget(P, f.exec)).toEqual({ error: `Plugin "p" in "m" has a path outside the marketplace: "${src}".` + URL });
  expect(f.calls.some((c) => c[2]?.includes('/contents/') && !c[2].includes('marketplace.json'))).toBe(false);
});

test('dot-prefixed relative folder stays intact', () => {
  const f = fake((c, a) => (a?.[1]?.includes('/contents/.claude/p') ? ok('dir') : market('./.claude/p')(c, a)));
  expect(resolveTarget(P, f.exec)).toMatchObject({ path: '.claude/p', sha: M });
  expect(resolveTarget(P, fake((c, a) => (a?.[1]?.includes('/contents/.claude/p') ? ok('dir') : market('.claude/p')(c, a))).exec)).toMatchObject({ path: '.claude/p' });
});

test('marketplace sha is confirmed through the commits API', () => {
  const f = fake(market({ source: 'github', repo: 'o/r', sha: S.toUpperCase() }, ['404']));
  expect(resolveTarget(P, f.exec)).toEqual({ error: 'o/r: ' + S + ' not found on GitHub. Check the URL or ref.' });
  expect(f.calls).toContainEqual(['gh', 'api', `repos/o/r/commits/${S}`, '--jq', '.sha']);
  const ok2 = fake((c, a) => (a?.[1] === `repos/o/r/commits/${S}` ? ok(S) : market({ source: 'github', repo: 'o/r', sha: S })(c, a)));
  expect(resolveTarget(P, ok2.exec)).toMatchObject({ ref: S, sha: S });
  const other = fake((c, a) => (a?.[1] === `repos/o/r/commits/${S}` ? ok('d'.repeat(40)) : market({ source: 'github', repo: 'o/r', sha: S })(c, a)));
  expect((resolveTarget(P, other.exec) as { error: string }).error).toContain('could not verify');
});

test.each(['abc123', 'z'.repeat(40), 'a'.repeat(64), 7])('malformed sha %s stops, no fallback', (sha) => {
  const f = fake(market({ source: 'github', repo: 'o/r', ref: 'v2', sha }));
  expect(resolveTarget(P, f.exec)).toEqual({ error: `Plugin "p" in "m" has a malformed sha: ${sha}.` + URL });
  expect(f.calls.some((c) => c[2]?.startsWith('repos/o/r'))).toBe(false);
});

test('unreadable claude marketplace list', () => {
  for (const out of ['not json', '{"m":1}', '[1]', '[{"name":"m"}', '']) {
    const r = resolveTarget(P, fake(() => ok(out)).exec) as { error: string };
    expect(r.error, out).toMatch(/^Could not read the installed marketplaces from claude\..*GitHub URL/);
  }
  expect(resolveTarget(P, fake(() => ({ status: 1, stdout: '' })).exec)).toHaveProperty('error');
});

test('marketplace list accepts {name, repo} and a missing source type', () => {
  const f = fake((c, a) => (c === 'claude' ? ok(JSON.stringify([{ name: 'm', repo: 'mo/mr' }])) : market('.')(c, a)));
  expect(resolveTarget(P, f.exec)).toMatchObject({ marketRepo: 'mo/mr' });
  const g = fake((c) => (c === 'claude' ? ok(JSON.stringify([{ name: 'm' }])) : ok('')));
  expect((resolveTarget(P, g.exec) as { error: string }).error).toContain('has a unknown source');
});

test('repo name . / .. / .git and empty ref segments are rejected', () => {
  for (const s of ['o/..', 'o/.', 'o/.git', 'https://github.com/o/..', 'o/r#a//b', 'o/r#./x']) expect((parseTarget(s) as { error: string }).error?.startsWith(BAD), s).toBe(true);
});

test('gh failure pinning the marketplace', () => {
  const base = market('./');
  const rate = fake((c, a) => (c === 'gh' && a[1] === 'repos/mo/mr/commits/main' ? { status: 1, stdout: '', stderr: 'HTTP 403 rate limit' } : base(c, a)));
  expect(resolveTarget(P, rate.exec)).toEqual({ error: 'mo/mr: could not verify main (gh exited 1): HTTP 403 rate limit.' + VER });
  const gone = fake((c, a) => (c === 'gh' && a[1] === 'repos/mo/mr/commits/main' ? { status: 1, stdout: '', stderr: 'HTTP 404' } : base(c, a)));
  expect(resolveTarget(P, gone.exec)).toEqual({ error: 'mo/mr: main not found on GitHub. Check the URL or ref.' });
});

test('failed fetch of the raw marketplace.json', () => {
  const base = market('./');
  const raw = (stderr: string) => fake((c, a) => (c === 'gh' && a[1].includes('marketplace.json') ? { status: 1, stdout: '', stderr } : base(c, a)));
  expect(resolveTarget(P, raw('HTTP 404').exec)).toEqual({ error: 'mo/mr: marketplace.json not found on GitHub. Check the URL or ref.' });
  expect(resolveTarget(P, raw('HTTP 502 bad gateway').exec)).toEqual({ error: 'mo/mr: could not verify marketplace.json (gh exited 1): HTTP 502 bad gateway.' + VER });
  const junk = fake((c, a) => (c === 'gh' && a[1].includes('marketplace.json') ? ok('not json') : base(c, a)));
  expect(resolveTarget(P, junk.exec)).toEqual({ error: 'Plugin "p" is not in marketplace "m". Check the plugin name, or pass the plugin\'s GitHub URL instead.' });
});

test('no doubled period when gh stderr already ends with one', () => {
  const r = resolveTarget(T, fake(() => ({ status: 1, stdout: '', stderr: 'Rate limited.' })).exec) as { error: string };
  expect(r.error).toBe('o/r: could not verify main (gh exited 1): Rate limited. Check your network or run gh auth status, then try again.');
  expect(r.error).not.toContain('..');
});

test('source .. reads cleanly', () => {
  expect(resolveTarget(P, fake(market('..')).exec)).toEqual({ error: 'Plugin "p" in "m" has a path outside the marketplace: "..". Pass the plugin\'s GitHub URL instead.' });
});
