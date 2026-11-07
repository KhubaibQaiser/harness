import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, test } from 'vitest';
import { defaults } from '../../src/core/config.js';
import { apiCountTokens, COUNT_URL, countKey } from '../../src/budget/count-api.js';
import { measureSelection } from '../../src/budget/measure.js';

const SENTINEL = 'sk-ant-TEST-SENTINEL-0000';
const resp = (status: number, body: unknown = {}): Response => new Response(JSON.stringify(body), { status });
const rec = (answer: (text: string, n: number) => Response | Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  let open = 0;
  let overlap = false;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    overlap ||= ++open > 1;
    await new Promise((r) => setTimeout(r, 1));
    open--;
    const text = (JSON.parse(init.body as string) as { messages: { content: string }[] }).messages[0].content;
    return answer(text, calls.length - 1);
  }) as unknown as typeof fetch;
  return { calls, fetchFn, overlapped: () => overlap };
};
const tokens = (text: string) => resp(200, { input_tokens: text === '.' ? 7 : text.length });

test('sends one sequential POST per text after a baseline call, with exact headers and body', async () => {
  const r = rec(tokens);
  await apiCountTokens(SENTINEL, 'claude-x', { fetch: r.fetchFn })([{ id: 'a', text: 'aaa' }, { id: 'b', text: 'bb' }]);
  expect(r.calls).toHaveLength(3);
  expect(r.overlapped()).toBe(false);
  expect(JSON.parse(r.calls[0].init.body as string).messages[0].content).toBe('.');
  for (const [i, text] of ['.', 'aaa', 'bb'].entries()) {
    expect(r.calls[i].url).toBe(COUNT_URL);
    expect(r.calls[i].init.method).toBe('POST');
    expect(r.calls[i].init.headers).toEqual({ 'x-api-key': SENTINEL, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(r.calls[i].init.body as string)).toEqual({ model: 'claude-x', messages: [{ role: 'user', content: text }] });
  }
});

test('count is input_tokens minus the baseline, floored at 0', async () => {
  const r = rec((t) => resp(200, { input_tokens: t === '.' ? 7 : t === 'big' ? 19 : 3 }));
  const out = await apiCountTokens(SENTINEL, 'm', { fetch: r.fetchFn })([{ id: 'big', text: 'big' }, { id: 'small', text: 'small' }]);
  expect(out).toEqual({ big: 12, small: 0 });
});

test.each([[401, '401'], [429, '429']])('status %i resolves null and reports the status', async (status, reason) => {
  const fails: string[] = [];
  const r = rec(() => resp(status, { error: SENTINEL }));
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: r.fetchFn, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }])).toBeNull();
  expect(fails).toEqual([reason]);
});

test('missing input_tokens resolves null', async () => {
  const fails: string[] = [];
  const r = rec(() => resp(200, {}));
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: r.fetchFn, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }])).toBeNull();
  expect(fails).toEqual(['bad response']);
});

test('past the total deadline resolves null with timeout, without calling fetch', async () => {
  const fails: string[] = [];
  const r = rec(tokens);
  let t = 0;
  const now = () => (t += 30000);
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: r.fetchFn, now, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }])).toBeNull();
  expect(fails).toEqual(['timeout']);
  expect(r.calls).toHaveLength(0);
});

test('a deadline passing mid-run resolves null with timeout and stops calling fetch', async () => {
  const fails: string[] = [];
  const r = rec(tokens);
  let t = 0;
  const now = () => (t < 3 ? 0 : 30000) + 0 * t++; // third now() onward is past the deadline
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: r.fetchFn, now, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }])).toBeNull();
  expect(fails).toEqual(['timeout']);
  expect(r.calls.length).toBeGreaterThan(0);
  expect(r.calls.length).toBeLessThan(3);
});

test('an abort from fetch reports timeout', async () => {
  const fails: string[] = [];
  const f = (async () => { throw new DOMException('t', 'TimeoutError'); }) as unknown as typeof fetch;
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: f, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }])).toBeNull();
  expect(fails).toEqual(['timeout']);
});

test('a throwing fetch reports network error and never leaks the key', async () => {
  const fails: string[] = [];
  const f = (async () => { throw new Error(`x-api-key: ${SENTINEL}`); }) as unknown as typeof fetch;
  expect(await apiCountTokens(SENTINEL, 'm', { fetch: f, onFail: (x) => fails.push(x) })([{ id: 'a', text: 'a' }])).toBeNull();
  expect(fails).toEqual(['network error']);
  expect(JSON.stringify(fails)).not.toContain(SENTINEL);
});

test('countKey is null offline or with no variable, else the variable', () => {
  const off = { ...defaults(), context: { ...defaults().context, count: 'offline' as const } };
  expect(countKey({ ANTHROPIC_API_KEY: SENTINEL }, off)).toBeNull();
  expect(countKey({}, defaults())).toBeNull();
  expect(countKey({ ANTHROPIC_API_KEY: '' }, defaults())).toBeNull();
  expect(countKey({ ANTHROPIC_API_KEY: SENTINEL }, defaults())).toBe(SENTINEL);
});

test('measureSelection: a count record makes it exact, null keeps the estimate', async () => {
  const { loadCatalog } = await import('../../src/catalog/load.js');
  const dirs = { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') };
  const c = loadCatalog().catalog;
  const ids = c.items.filter((i) => i.kind === 'own-skill').map((i) => i.id).slice(0, 1);
  let seen: { id: string; text: string }[] = [];
  const exact = await measureSelection(ids, c, dirs, { count: async (t) => { seen = t; return Object.fromEntries(t.map((x) => [x.id, 5])); } });
  expect(exact.method).toBe('exact');
  expect(seen.length).toBeGreaterThan(0);
  expect(exact.entries.every((e) => !('text' in e))).toBe(true);
  const est = await measureSelection(ids, c, dirs, { count: async () => null });
  expect(est.method).toBe('estimate');
});

test('an entry without text keeps the estimate and the result is not labelled exact', async () => {
  const { loadCatalog } = await import('../../src/catalog/load.js');
  const dirs = { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') };
  const r = await measureSelection([], loadCatalog().catalog, dirs, { extra: [{ id: 'core', tokens: 10 }], count: async (t) => Object.fromEntries(t.map((x) => [x.id, 5])) });
  expect(r.method).toBe('estimate');
  expect(r.entries.find((e) => e.id === 'core')!.tokens).toBe(10);
});

test('prototype keys in the count record are not counts', async () => {
  const { loadCatalog } = await import('../../src/catalog/load.js');
  const dirs = { templates: join(__dirname, '../../templates'), plugin: join(__dirname, '../..') };
  const e = { id: 'constructor', tokens: 10, text: 'abc' };
  const r = await measureSelection([], loadCatalog().catalog, dirs, { extra: [e], count: async () => ({}) });
  expect(r.entries.find((x) => x.id === 'constructor')!.tokens).toBe(10);
  expect(r.method).toBe('estimate');
});

test('ANTHROPIC_API_KEY is read only in count-api.ts', () => {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (readFileSync(p, 'utf8').includes('ANTHROPIC_API_KEY')) hits.push(p);
    }
  };
  walk(join(__dirname, '../../src'));
  expect(hits.map((h) => basename(h))).toEqual(['count-api.ts']);
});
