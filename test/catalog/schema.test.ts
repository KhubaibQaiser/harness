import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { validateItem } from '../../src/catalog/schema.js';

const raw = (): any => parse(readFileSync('test/fixtures/catalog/items/gsap-skills.yaml', 'utf8'));
const errs = (r: any, file = 'gsap-skills.yaml'): string[] => {
  const res = validateItem(r, file);
  return res.ok ? [] : res.errors;
};
const mut = (f: (r: any) => void): string[] => {
  const r = raw();
  f(r);
  return errs(r);
};

test('validateItem accepts the §7.1 example plus plugin', () => {
  const res = validateItem(raw(), 'gsap-skills.yaml'); // `plugin` was added to the spec example's source
  expect(res.ok).toBe(true);
  if (res.ok) expect(res.item).toMatchObject({ id: 'gsap-skills', kind: 'plugin', stance: 'optional', cost: { context: 'low', setup: 'none' } });
});

test('cost.context_tokens: integer 0 to 200000 or null', () => {
  for (const ok of [0, 120, 200000, null]) expect(mut((r) => (r.cost.context_tokens = ok))).toEqual([]);
  for (const bad of [-1, 1.5, 'x', 200001]) expect(mut((r) => (r.cost.context_tokens = bad))).toEqual(['gsap-skills.yaml: cost.context_tokens: must be an integer from 0 to 200000 or null']);
});

test('validateItem names the bad field', () => {
  expect(mut((r) => (r.source.sha = 'abc'))).toEqual(['gsap-skills.yaml: source.sha: must be a 40-character lowercase hex commit']);
  expect(mut((r) => ((r.stance = 'discouraged'), (r.stance_reason = '')))).toEqual(['gsap-skills.yaml: stance_reason: required when stance is discouraged']);
  expect(mut((r) => (r.foo = 1))).toEqual(['gsap-skills.yaml: unknown key "foo"']);
  expect(mut((r) => (r.source.unpinned = 'why'))).toEqual(['gsap-skills.yaml: source.unpinned: only remote MCP sources may be unpinned']);
  expect(mut((r) => (r.source.repo = 'https://gitlab.com/a/b'))).toEqual(['gsap-skills.yaml: source.repo: must be owner/name on GitHub']);
  expect(mut((r) => delete r.license)).toEqual(['gsap-skills.yaml: license: must be a non-empty string']);
  expect(mut((r) => (r.min_claude_code = '2.1'))).toEqual(['gsap-skills.yaml: min_claude_code: must be a semver such as 2.1.0']);
});

test('own source: merge only allows agents-md', () => {
  const own = (r: any) => ((r.kind = 'rule'), (r.source = { type: 'own', merge: ['permissions'] }));
  expect(mut(own)).toEqual(['gsap-skills.yaml: source.merge[0]: must be agents-md']);
  expect(mut((r) => (own(r), (r.source = { type: 'own', merge: ['agents-md'], checks: ['guard'], files: [{ from: 'a', to: 'b' }] })))).toEqual([]);
  expect(mut((r) => (own(r), (r.source = { type: 'own', checks: ['nope'] })))).toEqual(['gsap-skills.yaml: source.checks[0]: must be a harness check name']);
});

test('kind and source must fit', () => {
  const plugin = { type: 'npm', package: 'x', version: '1.0.0' };
  expect(mut((r) => (r.source = plugin))).toEqual(['gsap-skills.yaml: source.type: kind plugin takes source type github or git-subdir']);
  expect(mut((r) => (r.kind = 'mcp'))).toEqual(['gsap-skills.yaml: source.type: kind mcp takes source type npm or remote', 'gsap-skills.yaml: mcp: required for kind mcp']);
  expect(mut((r) => (r.kind = 'own-skill'))).toEqual(['gsap-skills.yaml: source.type: kind own-skill takes source type own']);
  expect(mut((r) => ((r.kind = 'mcp'), (r.source = plugin), (r.mcp = { name: 'x', config: { command: 'npx' } })))).toEqual([]);
  expect(mut((r) => ((r.kind = 'mcp'), (r.source = { type: 'remote', url: 'https://x.dev/mcp', unpinned: 'hosted service' }), (r.mcp = { name: 'x', config: { type: 'http', url: 'https://x.dev/mcp' } })))).toEqual([]);
});

test('own files paths are repo-relative with forward slashes', () => {
  for (const bad of ['../x', 'a/../b', '/etc/x', 'a\\b']) {
    const e = mut((r) => ((r.kind = 'rule'), (r.source = { type: 'own', files: [{ from: bad, to: 'ok' }, { from: 'ok', to: bad }] })));
    expect(e, bad).toEqual(['gsap-skills.yaml: source.files[0].from: must be a relative path with / separators and no ..', 'gsap-skills.yaml: source.files[1].to: must be a relative path with / separators and no ..']);
  }
});

test('mcp key only on kind mcp; an invalid source type is reported once', () => {
  expect(mut((r) => (r.mcp = { name: 'x', config: {} }))).toEqual(['gsap-skills.yaml: mcp: only allowed for kind mcp']);
  expect(mut((r) => (r.source = { type: 'zip' }))).toEqual(['gsap-skills.yaml: source.type: must be one of own, github, git-subdir, npm, remote']);
});

test('mcp.config is a stdio command or a typed remote server', () => {
  const src = { type: 'npm', package: 'x', version: '1.0.0' };
  const cfg = (config: unknown) => mut((r) => ((r.kind = 'mcp'), (r.source = src), (r.mcp = { name: 'x', config })));
  expect(cfg({ command: 'npx', args: ['-y', 'x@1.0.0'], env: { A: '${A}' } })).toEqual([]);
  expect(cfg({ type: 'sse', url: 'https://x.dev/sse', headers: { H: 'v' } })).toEqual([]);
  expect(cfg({ url: 'https://x.dev/mcp' })).toEqual(['gsap-skills.yaml: mcp.config: a url server needs type http or sse']);
  expect(cfg({})).toEqual(['gsap-skills.yaml: mcp.config: must have command (stdio) or type and url (remote)']);
  expect(cfg({ command: 'npx', args: 'x' })).toEqual(['gsap-skills.yaml: mcp.config.args: must be a list of strings']);
  expect(cfg({ command: 'npx', env: { A: 1 } })).toEqual(['gsap-skills.yaml: mcp.config.env: must be a mapping of strings']);
  expect(cfg({ type: 'http', url: 'x.dev' })).toEqual(['gsap-skills.yaml: mcp.config.url: must be an https URL']);
  expect(cfg({ type: 'http', url: 'https://x.dev', headers: [] })).toEqual(['gsap-skills.yaml: mcp.config.headers: must be a mapping of strings']);
  expect(cfg({ command: 'npx', foo: 1 })).toEqual(['gsap-skills.yaml: mcp.config: unknown key "foo"']);
});

test('lsp_servers is a non-empty mapping, only on kind plugin', () => {
  const lsp = { sourcekit: { command: 'sourcekit-lsp', extensionToLanguage: { '.swift': 'swift' } } };
  expect(mut((r) => (r.lsp_servers = lsp))).toEqual([]);
  expect(mut((r) => (r.lsp_servers = {}))).toEqual(['gsap-skills.yaml: lsp_servers: must be a non-empty mapping of server name to config']);
  expect(mut((r) => (r.lsp_servers = ['x']))).toEqual(['gsap-skills.yaml: lsp_servers: must be a non-empty mapping of server name to config']);
  expect(mut((r) => ((r.kind = 'external-skill'), (r.lsp_servers = lsp)))).toEqual(['gsap-skills.yaml: lsp_servers: only allowed for kind plugin']);
});

test('unpinned_runtime is a non-empty string', () => {
  expect(mut((r) => (r.unpinned_runtime = 'runs npx pkg@latest'))).toEqual([]);
  expect(mut((r) => (r.unpinned_runtime = ' '))).toEqual(['gsap-skills.yaml: unpinned_runtime: must be a non-empty string']);
  expect(mut((r) => (r.unpinned_runtime = 3))).toEqual(['gsap-skills.yaml: unpinned_runtime: must be a non-empty string']);
});
