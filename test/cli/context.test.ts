import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { realIO } from '../../src/budget/imports.js';
import { context } from '../../src/cli/context.js';
import { makeRepo } from '../install/helpers.js';

const SENTINEL = 'sk-ant-TEST-SENTINEL-0000';
const MODEL = 'claude-opus-5-5';
const repo = (config = '') => makeRepo({
  'CLAUDE.md': 'repo memory text that is long enough to count\n',
  '.claude/rules/api.md': '---\npaths:\n  - src/api/**\n---\napi rule body\n',
  '.mcp.json': JSON.stringify({ mcpServers: { github: {} } }),
  ...(config ? { '.harness/config.yaml': config } : {}),
});
const fakeFetch = (answer: (text: string) => Response | Promise<Response>) => {
  const calls: RequestInit[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return answer((JSON.parse(init.body as string) as { messages: { content: string }[] }).messages[0].content);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
};
const ok = (text: string) => new Response(JSON.stringify({ input_tokens: text === '.' ? 5 : 5 + text.length }), { status: 200 });
const go = async (args: string[], opts: { root?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) => {
  const root = opts.root ?? repo();
  const lines: string[] = [];
  const code = await context(args, { root, env: opts.env ?? {}, out: (l) => lines.push(l), fetch: opts.fetch });
  return { code, out: lines.join('\n'), root };
};

test('with a key the API counts real text, names the configured model, and drops ~', async () => {
  const f = fakeFetch(ok);
  const r = await go([], { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`Counted by Anthropic's token-counting API (${MODEL}).`);
  expect(r.out).toMatch(/^ {2}repo {5}CLAUDE\.md +46$/m);
  expect(f.calls.length).toBeGreaterThan(2);
  for (const c of f.calls) {
    expect((c.headers as Record<string, string>)['x-api-key']).toBe(SENTINEL);
    expect(JSON.parse(c.body as string).model).toBe(MODEL);
  }
  // The plugin row is measured from harness's own skill and agent text, so it is counted too, never a mislabelled estimate.
  expect(r.out).toMatch(/^ {2}harness {2}skills harness:.* +\d[\d,]*$/m);
});

test('the configured count_model is the one sent', async () => {
  const f = fakeFetch(ok);
  const r = await go([], { root: repo('context:\n  count_model: claude-test-model\n'), env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(r.out).toContain("Counted by Anthropic's token-counting API (claude-test-model).");
  expect(new Set(f.calls.map((c) => JSON.parse(c.body as string).model))).toEqual(new Set(['claude-test-model']));
});

test('a 429 falls back to estimates for every row, never mixed', async () => {
  const f = fakeFetch(() => new Response('{}', { status: 429 }));
  const r = await go([], { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  const lines = r.out.split('\n');
  expect(lines[lines.findIndex((l) => l.startsWith('Context budget:')) + 1]).toBe("Couldn't use the token-counting API (429); counts are best estimates.");
  expect(r.out).not.toContain('Counted by');
  expect(r.out).toMatch(/^ {2}repo {5}CLAUDE\.md +~12$/m);
  expect(JSON.parse((await go(['--json'], { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn })).out).fallback).toBe('429');
});

test('--json prints one object of the §5 shape', async () => {
  const r = await go(['--json']);
  const j = JSON.parse(r.out);
  expect(Object.keys(j)).toEqual(['method', 'model', 'budget', 'always', 'on_demand', 'sources', 'unmeasured', 'not_measured', 'recommendations', 'fallback']);
  expect(j).toMatchObject({ method: 'estimate', model: null, fallback: null, budget: 2000, unmeasured: ['mcp: github'], recommendations: [] });
  expect(j.sources.find((s: { id: string }) => s.id === 'harness-plugin')).not.toHaveProperty('path');
  expect(j.sources.find((s: { id: string }) => s.id === 'harness-plugin')).not.toHaveProperty('chars');
});

test('exit codes: 0 within, 1 over, 2 on a usage error', async () => {
  expect((await go([])).code).toBe(0);
  expect((await go([], { root: repo('context:\n  budget_tokens: 1\n') })).code).toBe(1);
  const bad = await go(['--bogus']);
  expect(bad.code).toBe(2);
  expect(bad.out).toBe('Usage: harness context [--json] [--offline]');
  expect((await go(['--json', '--json'])).code).toBe(2);
});

test('no network: --offline with a key, and count: offline, never call fetch', async () => {
  const f = fakeFetch(ok);
  const a = await go(['--offline'], { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  const b = await go([], { root: repo('context:\n  count: offline\n'), env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(f.calls).toHaveLength(0);
  for (const r of [a, b]) expect(r.out).toContain('Best estimate (characters ÷ 4).');
  // The key hint is advice for the no-key case only.
  for (const r of [a, b, await go(['--offline'])]) expect(r.out).not.toContain('set ANTHROPIC_API_KEY');
  expect((await go([])).out).toContain('; set ANTHROPIC_API_KEY to count');
});

test('the sentinel key appears in no output, no events.jsonl, and no error text', async () => {
  const thrower = (async () => { throw new Error(`fetch failed: x-api-key: ${SENTINEL}`); }) as unknown as typeof fetch;
  const echo = fakeFetch(() => new Response(JSON.stringify({ error: SENTINEL }), { status: 401 }));
  for (const fetchFn of [thrower, echo.fetchFn]) {
    for (const args of [[], ['--json']]) {
      const r = await go(args, { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: fetchFn });
      expect(r.out).not.toContain(SENTINEL);
      if (args.length) expect(['network error', '401']).toContain(JSON.parse(r.out).fallback);
      const events = join(r.root, '.harness', 'events.jsonl');
      if (existsSync(events)) expect(readFileSync(events, 'utf8')).not.toContain(SENTINEL);
    }
  }
  const t = await go([], { env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: thrower });
  expect(t.out).toContain("Couldn't use the token-counting API (network error); counts are best estimates.");
});

test('nothing is written: git status is unchanged afterwards', async () => {
  const root = repo('context:\n  budget_tokens: 2000\n'); // makeRepo commits every file
  const before = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' });
  await go([], { root, env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: fakeFetch(ok).fetchFn });
  await go(['--json'], { root });
  expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' })).toBe(before);
});

test('a repo that is not a git repo still reports, with a note', async () => {
  const root = makeRepo({ 'CLAUDE.md': 'x\n' }, { git: false });
  const r = await go([], { root });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Note: not a git repository or git not found: nested CLAUDE.md files not listed');
});

// I4, through the CLI with the production skip: the fake value is not a row, not in --json, and never sent.
test('a dotenv file a CLAUDE.md imports is never read, shown or sent', async () => {
  const name = '.' + 'env';
  const FAKE = 'API_TOKEN=fake-value-not-a-secret';
  const root = makeRepo({ 'CLAUDE.md': `memory\n@${name}\n@${name}.local\n`, [name]: FAKE, [`${name}.local`]: FAKE, [`.claude/rules/${name}.md`]: FAKE });
  const f = fakeFetch(ok);
  const text = await go([], { root, env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  const json = await go(['--json'], { root, env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(f.calls.length).toBeGreaterThan(0);
  for (const c of f.calls) expect(c.body as string).not.toContain(FAKE);
  for (const r of [text, json]) expect(r.out).not.toContain(FAKE);
  expect(text.out).not.toMatch(new RegExp(`^ {2}repo +[^ ]*\\${name}`, 'm'));
  const j = JSON.parse(json.out);
  expect(j.sources.filter((s: { path?: string }) => s.path?.includes(name))).toEqual([]);
});

// M2: a config that doesn't parse can't say `count: offline`, so it fails closed: no API, and the warning comes first.
test('an invalid config never uses the API and warns before the report', async () => {
  const f = fakeFetch(ok);
  const r = await go([], { root: repo('context:\n  count: offline\n  bad: [\n'), env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(f.calls).toHaveLength(0);
  expect(r.out.split('\n')[0]).toMatch(/^warn config\.yaml is invalid YAML/);
  expect(r.out).toContain('Best estimate (characters ÷ 4).');
  expect(r.out).not.toContain('set ANTHROPIC_API_KEY');
});

// M4: exit codes stay 0/1/2 (spec §5), so a corrupt manifest is a note and the exit follows the budget.
test('a corrupt manifest is a note, not exit 1; the exit follows the budget', async () => {
  const root = makeRepo({ 'CLAUDE.md': 'x\n', '.harness/manifest.json': '{nope' });
  const r = await go([], { root });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Note: `.harness/manifest.json` is unreadable.');
  expect((await go([], { root: makeRepo({ 'CLAUDE.md': 'x\n', '.harness/manifest.json': '{nope', '.harness/config.yaml': 'context:\n  budget_tokens: 1\n' }) })).code).toBe(1);
  expect(JSON.parse((await go(['--json'], { root })).out).always.total).toBeGreaterThan(0);
});

// M7: one run measures the repo once (one git ls-files).
test('one context run lists the repo once', async () => {
  const spy = vi.spyOn(realIO, 'lsFiles');
  await go([]);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});

// Re-review I4: links with innocent names pointing at a dotenv file are skipped by their target.
test.skipIf(process.platform === 'win32')('a link to a dotenv file is never read, shown or sent', async () => {
  const name = '.' + 'env';
  const FAKE = 'API_TOKEN=fake-value-not-a-secret';
  const root = makeRepo({ 'CLAUDE.md': 'memory\n@docs/notes.md\n', [name]: FAKE, 'docs/keep.md': 'K' }, { git: false });
  symlinkSync(`../${name}`, join(root, 'docs/notes.md'));
  mkdirSync(join(root, '.claude/rules'), { recursive: true });
  symlinkSync(`../../${name}`, join(root, '.claude/rules/secrets.md'));
  const f = fakeFetch(ok);
  const text = await go([], { root, env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  const json = await go(['--json'], { root, env: { ANTHROPIC_API_KEY: SENTINEL }, fetch: f.fetchFn });
  expect(f.calls.length).toBeGreaterThan(0);
  for (const c of f.calls) expect(c.body as string).not.toContain(FAKE);
  for (const r of [text, json]) expect(r.out).not.toContain(FAKE);
  expect(text.out).not.toMatch(/^ {2}repo +(docs\/notes\.md|\.claude\/rules\/secrets\.md)/m);
  expect(JSON.parse(json.out).sources.filter((s: { path?: string }) => s.path === 'docs/notes.md' || s.path === '.claude/rules/secrets.md')).toEqual([]);
});
