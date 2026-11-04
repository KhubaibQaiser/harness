import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { makeRepo } from '../install/helpers.js';

const root = makeRepo({ 'package.json': '{}' }, { git: false });
const picksFile = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'picks.json');
writeFileSync(picksFile, JSON.stringify({ catalog_version: 1, findings: [], items: [{ id: 'deep', include: 'recommended', reason: 'r', addresses: [] }, { id: 'base', include: 'optional', reason: 'r', addresses: [] }] }));
const go = (args: string[]) => {
  process.env.HARNESS_CATALOG_DIR = 'test/fixtures/catalog';
  process.env.HARNESS_PLAIN_INIT = '1';
  const lines: string[] = [];
  try {
    return { code: run(args, { root, env: {}, out: (l) => lines.push(l) }), lines };
  } finally {
    delete process.env.HARNESS_CATALOG_DIR;
    delete process.env.HARNESS_PLAIN_INIT;
  }
};

test('select round trip: checklist, then choose', () => {
  const a = go(['select', '--picks', picksFile]);
  expect(a.code).toBe(0);
  expect(JSON.parse(a.lines.join('\n')).map((r: { id: string }) => r.id)).toEqual(['deep', 'base']);
  const b = go(['select', '--picks', picksFile, '--choose', 'deep']);
  expect(b.code).toBe(0);
  const out = JSON.parse(b.lines.join('\n'));
  expect(out.ids).toEqual(['deep', 'extra', 'base']);
  expect(out.notices).toHaveLength(2);
  expect(out.selected.map((s: { id: string; selected: boolean }) => [s.id, s.selected])).toEqual([['deep', true], ['base', true], ['extra', true]]);
});

test('select prints errors with exit 2; bad usage and bad files exit 2', () => {
  expect(go(['select', '--picks', picksFile, '--choose', 'lead-a,lead-b'])).toEqual({ code: 2, lines: ['lead-a and lead-b conflict; pick one.'] });
  expect(go(['select']).code).toBe(2);
  expect(go(['select', '--picks', '/nonexistent']).code).toBe(2);
});

test('select: --choose empty is a usage error; malformed picks exit 2; C1 in a path is escaped', () => {
  expect(go(['select', '--picks', picksFile, '--choose', '']).code).toBe(2);
  const bad = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'bad.json');
  writeFileSync(bad, '{"items":[null]}');
  const r = go(['select', '--picks', bad]);
  expect(r.code).toBe(2);
  const c1 = go(['select', '--picks', '/nonexistent/a\u009b.json']);
  expect(c1.lines.join()).not.toContain('\u009b');
  expect(c1.lines.join()).toContain('\\u009b');
});

test('select: chosen id outside the picks is Chosen by you', () => {
  const out = JSON.parse(go(['select', '--picks', picksFile, '--choose', 'lead-a']).lines.join('\n'));
  expect(out.selected.at(-1)).toMatchObject({ id: 'lead-a', reason: 'Chosen by you.' });
});

test('a real own-item row has a non-empty context line', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'h-select-')), 'p.json');
  writeFileSync(f, JSON.stringify({ catalog_version: 1, findings: [], items: [{ id: 'review-rubric', include: 'recommended', reason: 'r', addresses: [] }] }));
  const lines: string[] = [];
  expect(run(['select', '--picks', f], { root, env: {}, out: (l) => lines.push(l) })).toBe(0);
  expect(JSON.parse(lines.join('\n'))[0].context).toMatch(/^~[1-9]\d* tokens \(estimate\)$/);
});
