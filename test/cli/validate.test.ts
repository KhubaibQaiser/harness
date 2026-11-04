import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { makeRepo } from '../install/helpers.js';

const go = (args: string[], root: string, env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  return { code: run(args, { root, env, out: (l) => lines.push(l) }), lines };
};
const file = (name: string, text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'h-validate-')), name);
  writeFileSync(p, text);
  return p;
};
const root = makeRepo({ 'package.json': '{}' }, { git: false });

test('validate answers prints every error and exits 2', () => {
  const f = file('answers.json', JSON.stringify({ scope: { paths: ['../x', '/etc/passwd'] }, project: { type: 'nope' } }));
  const r = go(['validate', 'answers', f], root);
  expect(r.code).toBe(2);
  expect(r.lines.length).toBeGreaterThan(2);
  expect(r.lines.some((l) => l.includes('../x'))).toBe(true);
  expect(r.lines.some((l) => l.includes('/etc/passwd'))).toBe(true);
});

test('validate works without CLAUDECODE and with it', () => {
  const sections = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx`).join('\n');
  const f = file('product.md', sections);
  for (const env of [{}, { CLAUDECODE: '1' }]) expect(go(['validate', 'product', f], root, env)).toEqual({ code: 0, lines: ['ok'] });
});

test('validate product reports errors; bad usage and unreadable or non-JSON files exit 2', () => {
  expect(go(['validate', 'product', file('p.md', 'x')], root).code).toBe(2);
  expect(go(['validate'], root).code).toBe(2);
  expect(go(['validate', 'answers'], root).code).toBe(2);
  expect(go(['validate', 'answers', '/nonexistent/a.json'], root).code).toBe(2);
  expect(go(['validate', 'answers', file('a.json', '{nope')], root).code).toBe(2);
});

test('an unreadable file name is escaped in the error', () => {
  const r = go(['validate', 'answers', '/nonexistent/a\u001b[31m.json'], root);
  expect(r.lines.join()).not.toContain('\u001b');
});

const answersOk = {
  scope: { paths: [] },
  project: { type: 'web', domain: 'shop', compliance: [], data_handling: '', team_size: 2, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 5, named_items: [] },
  apps: [],
  unattended: { multi_file_gate: 'block', require_reason: false },
  tdd: { paths: [], diff_coverage: 80 },
};
const rec = (args: string[], r = root) => {
  process.env.HARNESS_CATALOG_DIR = 'test/fixtures/catalog';
  process.env.HARNESS_PLAIN_INIT = '1';
  try {
    return go(args, r);
  } finally {
    delete process.env.HARNESS_CATALOG_DIR;
    delete process.env.HARNESS_PLAIN_INIT;
  }
};
const good = JSON.stringify({ catalog_version: 1, findings: [{ id: 'f1', severity: 'nit', title: 't' }], items: [{ id: 'base', include: 'optional', reason: 'Helps.', addresses: ['f1'] }] });

test('validate picks: ok, then retry then stop with the raw output saved', () => {
  const a = file('answers.json', JSON.stringify(answersOk));
  expect(rec(['validate', 'picks', file('picks.json', good), '--answers', a])).toEqual({ code: 0, lines: ['ok'] });
  const r2 = makeRepo({ 'package.json': '{}' }, { git: false });
  const bad = '{"catalog_version":1,"findings":[],"items":[{"id":"foo"}]}';
  expect(rec(['validate', 'picks', file('picks.json', bad), '--answers', a], r2).code).toBe(2);
  expect(existsSync(join(r2, '.harness/debug'))).toBe(false);
  const none = rec(['validate', 'picks', file('picks.json', bad), '--answers', a, '--attempt', '2'], r2);
  expect(none.code).toBe(1);
  expect(none.lines.join('\n')).toContain('Raw output follows');
  expect(none.lines.join('\n')).toContain('catalog_version');
  expect(existsSync(join(r2, '.harness'))).toBe(false); // no install here: nothing is written
  mkdirSync(join(r2, '.harness'));
  writeFileSync(join(r2, '.harness/manifest.json'), '{}');
  const r = rec(['validate', 'picks', file('picks.json', bad), '--answers', a, '--attempt', '2'], r2);
  expect(r.code).toBe(1);
  const [name] = readdirSync(join(r2, '.harness/debug'));
  expect(name).toMatch(/^picks-.*\.txt$/);
  expect(readFileSync(join(r2, '.harness/debug', name), 'utf8')).toBe(bad);
  expect(r.lines.at(-1)).toBe(`Recommend output failed validation twice. Raw output is in \`.harness/debug/${name}\`. Stopping.`);
});

test('validate report: read-only on ok; second failure saves the report', () => {
  const picks = file('picks.json', good);
  const md = '## Findings\nf1\n## Roadmap\n30 60 90\n## Deliberate exclusions\nx\n## Limits\ny\n';
  const rf = file('report.md', md);
  expect(rec(['validate', 'report', rf, '--picks', picks]).code).toBe(0);
  expect(readFileSync(rf, 'utf8')).toBe(md);
  const r2 = makeRepo({ 'package.json': '{}' }, { git: false });
  mkdirSync(join(r2, '.harness'));
  writeFileSync(join(r2, '.harness/manifest.json'), '{}');
  const r = rec(['validate', 'report', file('r.md', 'nope'), '--picks', picks, '--attempt', '2'], r2);
  expect(r.code).toBe(1);
  const [name] = readdirSync(join(r2, '.harness/debug'));
  expect(readFileSync(join(r2, '.harness/debug', name), 'utf8')).toBe('nope');
});

test('validate picks/report: bad usage exits 2', () => {
  expect(go(['validate', 'picks', 'x'], root).code).toBe(2);
  expect(go(['validate', 'report', 'x', '--picks', 'y', '--attempt', '3'], root).code).toBe(2);
  expect(go(['validate', 'picks', '/nonexistent', '--answers', '/nonexistent'], root).code).toBe(2);
});

test('attempt 2 with an invalid answers file saves the picks and stops', () => {
  const r2 = makeRepo({ 'package.json': '{}' }, { git: false });
  mkdirSync(join(r2, '.harness'));
  writeFileSync(join(r2, '.harness/manifest.json'), '{}');
  const r = rec(['validate', 'picks', file('picks.json', good), '--answers', file('a.json', '{}'), '--attempt', '2'], r2);
  expect(r.code).toBe(1);
  expect(r.lines.at(-1)).toMatch(/^Recommend output failed validation twice\. Raw output is in `\.harness\/debug\/picks-.*\.txt`\. Stopping\.$/);
  const [name] = readdirSync(join(r2, '.harness/debug'));
  expect(readFileSync(join(r2, '.harness/debug', name), 'utf8')).toBe(good);
});
