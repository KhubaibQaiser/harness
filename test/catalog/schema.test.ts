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
  expect(mut((r) => ((r.kind = 'mcp'), (r.source = plugin), (r.mcp = { name: 'x', config: {} })))).toEqual([]);
  expect(mut((r) => ((r.kind = 'mcp'), (r.source = { type: 'remote', url: 'https://x.dev/mcp', unpinned: 'hosted service' }), (r.mcp = { name: 'x', config: {} })))).toEqual([]);
});
