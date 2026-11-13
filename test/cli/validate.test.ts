import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { writeGather, type GatherJson } from '../../src/review/gather.js';
import { defaults } from '../../src/core/config.js';
import { serializeConfig } from '../../src/core/config-io.js';
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

test('--merge-config lays a partial answers file over the stored answers (update)', () => {
  const repo = makeRepo({ 'package.json': '{}' }, { git: false });
  mkdirSync(join(repo, '.harness'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), serializeConfig(defaults()));
  const partial = file('answers.json', JSON.stringify({ project: { deploy_target: 'vercel' } }));
  expect(go(['validate', 'answers', partial], repo).code).toBe(2);
  expect(go(['validate', 'answers', partial, '--merge-config'], repo)).toEqual({ code: 0, lines: ['ok'] });
  const picks = file('picks.json', readFileSync('test/fixtures/ai/picks.json', 'utf8'));
  expect(go(['validate', 'picks', picks, '--answers', partial], repo).lines.join('\n')).toContain('answers file is not valid');
  expect(go(['validate', 'picks', picks, '--answers', partial, '--merge-config'], repo).lines.join('\n')).not.toContain('answers file is not valid');
  expect(go(['validate', 'answers', partial, '--merge-config'], makeRepo({ 'package.json': '{}' }, { git: false })).code).toBe(1); // no install
});

test('--merge-config reads an old default results_dir as update does, without writing it', () => {
  const repo = makeRepo({ 'package.json': '{}' }, { git: false });
  mkdirSync(join(repo, '.harness'), { recursive: true });
  const old = serializeConfig(defaults()).replace(/results_dir: .*/, 'results_dir: .harness/state/test-results');
  expect(old).toContain('results_dir: .harness/state/test-results');
  writeFileSync(join(repo, '.harness/config.yaml'), old);
  const partial = file('answers.json', JSON.stringify({ project: { deploy_target: 'vercel' } }));
  expect(go(['validate', 'answers', partial, '--merge-config'], repo)).toEqual({ code: 0, lines: ['ok'] });
  expect(readFileSync(join(repo, '.harness/config.yaml'), 'utf8')).toBe(old);
});

const vscan = JSON.stringify({ sha: 'a'.repeat(40), findings: [] });
const vgood = JSON.stringify({ relevance: 'low', why: 'w', overlaps: [], injection: [], recommendation: 'skip', summary: 's' });

test('validate vet-review: ok, bad JSON, usage', () => {
  const s = file('scan.json', vscan);
  expect(go(['validate', 'vet-review', file('r.json', vgood), '--scan', s], root)).toEqual({ code: 0, lines: ['ok'] });
  expect(go(['validate', 'vet-review', file('r.json', '{nope'), '--scan', s], root)).toEqual({ code: 2, lines: ['vet-review: not valid JSON'] });
  expect(go(['validate', 'vet-review', file('r.json', vgood), '--scan', file('s.json', '{}')], root).lines).toEqual(['scan: not a vet scan; run harness vet --json first']);
  expect(go(['validate', 'vet-review', 'x'], root).code).toBe(2);
  expect(go(['validate', 'vet-review', 'x', '--scan', 'y', '--attempt', '3'], root).lines[0]).toMatch(/^Usage:/);
  expect(go(['validate', 'vet-review', '/nonexistent', '--scan', s], root).code).toBe(2);
});

test('validate vet-review: attempt 2 saves the raw review and stops', () => {
  const r2 = makeRepo({ 'package.json': '{}' }, { git: false });
  mkdirSync(join(r2, '.harness'));
  writeFileSync(join(r2, '.harness/manifest.json'), '{}');
  const bad = '{"relevance":"x"}';
  const s = file('scan.json', vscan);
  expect(go(['validate', 'vet-review', file('r.json', bad), '--scan', s], r2).code).toBe(2);
  const r = go(['validate', 'vet-review', file('r.json', bad), '--scan', s, '--attempt', '2'], r2);
  expect(r.code).toBe(1);
  const [name] = readdirSync(join(r2, '.harness/debug'));
  expect(name).toMatch(/^vet-review-.*\.txt$/);
  expect(readFileSync(join(r2, '.harness/debug', name), 'utf8')).toBe(bad);
  expect(r.lines.at(-1)).toBe(`Vet review failed validation twice. Raw output is in \`.harness/debug/${name}\`. Stopping.`);
});

test('validate vet-review: installed set matches explain (legacy config, broken config, no install)', () => {
  const rev = (id: string) => JSON.stringify({ relevance: 'low', why: 'w', overlaps: [{ id, how: 'h' }], injection: [], recommendation: 'skip', summary: 's' });
  const s = file('scan.json', vscan);
  const mk = (config?: string) => {
    const r = makeRepo({ 'package.json': '{}' }, { git: false });
    mkdirSync(join(r, '.harness'));
    writeFileSync(join(r, '.harness/manifest.json'), '{}');
    if (config !== undefined) writeFileSync(join(r, '.harness/config.yaml'), config);
    return r;
  };
  const legacy = mk(serializeConfig(defaults())); // items empty: the legacy own items
  expect(go(['validate', 'vet-review', file('r.json', rev('stop-gate')), '--scan', s], legacy).code).toBe(0);
  const broken = mk('items: [');
  expect(go(['validate', 'vet-review', file('r.json', rev('stop-gate')), '--scan', s], broken).lines).toEqual(["config: .harness/config.yaml could not be read; overlaps can't be checked"]);
  expect(go(['validate', 'vet-review', file('r.json', rev('stop-gate')), '--scan', s], root).lines).toEqual(['overlaps[0].id: "stop-gate" is not an installed item']);
});

test('validate vet-review: unsaved failure says Vet review output', () => {
  const r = go(['validate', 'vet-review', file('r.json', '{}'), '--scan', file('s.json', vscan), '--attempt', '2'], root);
  expect(r.code).toBe(1);
  expect(r.lines.join('\n')).toContain('Vet review output failed validation twice. Raw output follows. Stopping.');
});

test('validate preset-answers: ok, one error per line, bad JSON, usage', () => {
  const ok = { id: 'my-x', title: 'X', description: 'Mine.', target: 'global', rules: ['TDD.'], preselect: [], git: { branch_prefixes: ['feature/'], no_ai_trailer: true, pr_size_warning: true }, stacks: {} };
  expect(go(['validate', 'preset-answers', file('a.json', JSON.stringify(ok))], root)).toEqual({ code: 0, lines: ['ok'] });
  expect(go(['validate', 'preset-answers', file('a.json', JSON.stringify({ ...ok, target: 'x', extra: 1 }))], root)).toEqual({ code: 2, lines: ['extra: unknown key', 'target: must be repo or global'] });
  expect(go(['validate', 'preset-answers', file('a.json', '{nope')], root)).toEqual({ code: 2, lines: ['preset-answers: not valid JSON'] });
  expect(go(['validate', 'preset-answers'], root).lines[0]).toMatch(/^Usage:/);
});

describe('validate pr-review', () => {
  // Synthetic gather written the way gather writes it, so its hash is in state.
  const dir = '.harness/tmp/w-1';
  const repo = () => { const t = makeRepo({ 'package.json': '{}' }, { git: false }); mkdirSync(join(t, dir, 'head/src'), { recursive: true }); return t; };
  const g = {
    repo: 'o/r', pr: 7, base: 'main', base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), merge_base: 'a'.repeat(40), nonce: 'f'.repeat(32), fork: null, labels: [], body_template: false, body_problems: [], max_findings: 15,
    files: [{ path: 'src/a.ts', status: 'modified', binary: false }], lines: { 'src/a.ts': { RIGHT: [1], LEFT: [] } }, map: { 'src/a.ts': 'src/a.ts.pr-snapshot', 'src/b.ts': 'src/b.ts.pr-snapshot' }, omitted: [],
  };
  const f1 = { id: 'f1', severity: 'nit', category: 'design', file: 'src/a.ts', line: 1, side: 'RIGHT', title: 't', evidence: { kind: 'quote', text: 'a' }, fix: 'x' };
  const good = JSON.stringify({ findings: [f1, { ...f1, id: 'f2', file: 'src/b.ts' }], steering: [], summary: 's', limits: 'l' });
  test('ok, an unchanged-file finding in the snapshot, invalid replies, usage', () => {
    const r = repo();
    writeGather(r, dir, g as GatherJson);
    writeFileSync(join(r, dir, 'head/src/b.ts.pr-snapshot'), 'b\n');
    const gj = join(r, dir, 'gather.json');
    expect(go(['validate', 'pr-review', file('f.json', good), '--gather', gj], r)).toEqual({ code: 0, lines: ['ok'] });
    expect(go(['validate', 'pr-review', file('f.json', '{nope'), '--gather', gj], r)).toEqual({ code: 2, lines: ['pr-review: not valid JSON'] });
    expect(go(['validate', 'pr-review', file('f.json', JSON.stringify({ findings: [{ ...f1, file: 'src/c.ts' }], steering: [], summary: 's', limits: 'l' })), '--gather', gj], r))
      .toEqual({ code: 2, lines: ['findings[0].file: "src/c.ts" is not in this PR or its snapshot'] });
    expect(go(['validate', 'pr-review', 'x'], r).code).toBe(2);
  });
  test('--gather must name the gather.json gather wrote; a forged file beside it is refused', () => {
    const t = repo();
    writeGather(t, dir, g as GatherJson);
    const fake = join(t, dir, 'fake.json');
    writeFileSync(fake, JSON.stringify({ ...g, files: [{ path: 'src/c.ts', status: 'added', binary: false }] }));
    const f = file('f.json', JSON.stringify({ findings: [{ ...f1, file: 'src/c.ts' }], steering: [], summary: 's', limits: 'l' }));
    expect(go(['validate', 'pr-review', f, '--gather', fake], t)).toEqual({ code: 2, lines: ['pr-review: --gather must name <dir>/gather.json'] });
  });
  test('Review Focus 1: a changed gather.json is refused', () => {
    const t = repo();
    writeGather(t, dir, g as GatherJson);
    const p = join(t, dir, 'gather.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"pr": 7', '"pr": 8'));
    expect(go(['validate', 'pr-review', file('f.json', good), '--gather', p], t)).toEqual({ code: 2, lines: [`review: ${join(t, dir)}/gather.json changed since gather; run the review again`] });
  });
});
