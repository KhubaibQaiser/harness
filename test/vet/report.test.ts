import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { VetReview } from '../../src/ai/vet-review.js';
import type { Exec } from '../../src/core/exec.js';
import { CAVEAT, aheadBy, installInfo, installLines, reportMarkdown, summaryLines } from '../../src/vet/report.js';
import type { ScanResult, VetFinding } from '../../src/vet/scan.js';
import type { Resolved } from '../../src/vet/target.js';

const sha = 'abc1234' + 'd'.repeat(33);
const f = (severity: VetFinding['severity'], rule: VetFinding['rule'], n = 1, file = 'a.json'): VetFinding => ({ severity, rule, file, line: n, text: `t${n}` });
const scan = (findings: VetFinding[], path = 'plugins/p', unmeasured: string[] = []): ScanResult =>
  ({ target: 'o/r', repo: 'o/r', sha, path, kind: 'plugin', findings, context: { tokens: 42, unmeasured }, files: 3 });
const rev: VetReview = { relevance: 'high', why: 'fits', overlaps: [{ id: 'x', how: 'same' }, { id: 'y', how: 'same' }], injection: [{ file: 'a.md', line: 2, verdict: 'benign', why: 'doc' }], recommendation: 'install-with-care', summary: 'ok' };

test('summary shape', () => {
  const l = summaryLines(scan([f('high', 'secrets'), f('medium', 'network'), f('low', 'license', 0, '')], 'plugins/p', ['hooks']), rev, '.harness/vet/x.md');
  expect(l).toEqual([
    `Vetted: o/r@${sha}:plugins/p`,
    'Findings: 1 high, 1 medium, 1 low',
    '  [high] secrets a.json:1 t1',
    'Context: ~42 tokens always loaded (estimate); not measured: hooks',
    'Relevance: high. Overlaps: x, y',
    'Recommendation: install-with-care',
    'Full report: .harness/vet/x.md',
  ]);
});

test('summary: no path, no review, no overlaps, empty file shows no :0', () => {
  const l = summaryLines(scan([f('high', 'license', 0, '')], ''), null, 'r.md');
  expect(l[0]).toBe(`Vetted: o/r@${sha}`);
  expect(l).toContain('  [high] license t0');
  expect(l).toContain('Not reviewed: run /harness:vet inside Claude Code for relevance and a recommendation.');
  expect(summaryLines(scan([]), { ...rev, overlaps: [] }, 'r.md')).toContain('Relevance: high. Overlaps: none');
});

test.each([[0, 0], [6, 6], [7, 5], [9, 5]])('summary caps at 12 lines with %i high', (n, shown) => {
  const l = summaryLines(scan(Array.from({ length: n }, (_, i) => f('high', 'secrets', i + 1))), rev, 'r.md');
  expect(l.length).toBeLessThanOrEqual(12);
  expect(l.filter((x) => x.startsWith('  [high]')).length).toBe(shown);
  if (n > 6) expect(l).toContain(`  …and ${n - 5} more high findings in the report.`);
});

const info = { name: 'p', market: 'm', marketRepo: 'mo/mr' };
test('install text', () => {
  const s = scan([]);
  expect(installLines(s, info, 0)).toEqual(['claude plugin marketplace add mo/mr', 'claude plugin install p@m --scope project', expect.any(String), expect.any(String), expect.any(String)]);
  expect(installLines(s, { name: 'p', market: null, marketRepo: null }, 0)).toContain('No marketplace lists this item; add the pinned entry below to a marketplace you control.');
  expect(installLines(s, info, 3)).toContain('HEAD is 3 commits past the vetted abc1234; marketplace add installs HEAD, not what was vetted.');
  expect(installLines(s, info, 0).join('\n')).not.toContain('HEAD is');
  expect(installLines(s, info, null)).toContain('Could not check how far HEAD is past the vetted abc1234.');
});

test('pinned entry is the last line', () => {
  const last = (s: ScanResult) => JSON.parse(installLines(s, info, 0).at(-1)!);
  expect(last(scan([], ''))).toEqual({ name: 'p', source: { source: 'github', repo: 'o/r', sha } });
  expect(last(scan([]))).toEqual({ name: 'p', source: { source: 'git-subdir', url: 'o/r', path: 'plugins/p', sha } });
});

test('report', () => {
  const s = scan([f('high', 'secrets'), f('medium', 'network', 2), f('low', 'license', 0, '')]);
  const md = reportMarkdown(s, rev, installLines(s, info, 0));
  for (const h of ['## Summary', '## Findings', '### High', '### Medium', '### Low', '## Review', '## Install']) expect(md).toContain(h);
  expect(md).toContain('- secrets `a.json:1` t1');
  expect(md).toContain('- license t0');
  expect(md).not.toContain(':0');
  expect(md).toContain('```\nclaude plugin marketplace add mo/mr');
  expect(md).toContain(`{"name":"p","source":{"source":"git-subdir","url":"o/r","path":"plugins/p","sha":"${sha}"}}\n\`\`\``);
  expect(md.trimEnd().split('\n').at(-1)).toBe(CAVEAT);
  expect(reportMarkdown(s, null, [])).toContain('Not reviewed.');
  expect(reportMarkdown(s, { ...rev, summary: 'bad\nline‮' }, [])).not.toMatch(/bad\nline|‮/);
});

test('aheadBy', () => {
  const r: Resolved = { repo: 'o/r', ref: 'main', sha, path: '' };
  const calls: string[][] = [];
  const mk = (res: ReturnType<Exec>): Exec => (c, a) => (calls.push([c, ...a]), res);
  expect(aheadBy(r, mk({ status: 0, stdout: '3\n' }))).toBe(3);
  expect(calls).toEqual([['gh', 'api', `repos/o/r/compare/${sha}...main`, '--jq', '.ahead_by']]);
  expect(aheadBy(r, mk({ status: 1, stdout: '' }))).toBeNull();
  expect(aheadBy(r, mk({ status: 0, stdout: 'x' }))).toBeNull();
  expect(aheadBy(r, mk({ status: 0, stdout: '', missing: true }))).toBeNull();
});

const tree = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'vr-'));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); }
  return d;
};
const R = (path: string): Resolved => ({ repo: 'o/r', ref: 'main', sha, path });
const mp = (plugins: unknown, name = 'mkt') => JSON.stringify({ name, plugins });

test('installInfo: name@market uses its own fields', () => {
  expect(installInfo(tree({}), { ...R(''), name: 'p', market: 'm', marketRepo: 'mo/mr' })).toEqual({ name: 'p', market: 'm', marketRepo: 'mo/mr' });
});

test('installInfo: an unsafe name@market falls back', () => {
  for (const [name, market] of [['--scope', 'm'], ['p', '..'], ['..', 'm']]) expect(installInfo(tree({}), { ...R(''), name, market, marketRepo: 'mo/mr' }).name).not.toBe(name);
});

test('installInfo: marketplace.json in the repo', () => {
  const d = tree({ '.claude-plugin/marketplace.json': mp([{ name: 'other', source: './x' }, { name: 'p', source: './plugins/p' }]) });
  expect(installInfo(d, R('plugins/p'))).toEqual({ name: 'p', market: 'mkt', marketRepo: 'o/r' });
  const root = tree({ '.claude-plugin/marketplace.json': mp([{ name: 'rp', source: '.' }]) });
  expect(installInfo(root, R(''))).toEqual({ name: 'rp', market: 'mkt', marketRepo: 'o/r' });
  const gh = tree({ '.claude-plugin/marketplace.json': mp([{ name: 'gp', source: { source: 'github', repo: 'o/r' } }]) });
  expect(installInfo(gh, R(''))).toEqual({ name: 'gp', market: 'mkt', marketRepo: 'o/r' });
});

test('installInfo: fallbacks to plugin.json, last path segment, repo name', () => {
  const pj = tree({ 'plugins/p/.claude-plugin/plugin.json': '{"name":"fromjson"}' });
  expect(installInfo(pj, R('plugins/p'))).toEqual({ name: 'fromjson', market: null, marketRepo: null });
  expect(installInfo(tree({}), R('plugins/p'))).toEqual({ name: 'p', market: null, marketRepo: null });
  expect(installInfo(tree({}), R(''))).toEqual({ name: 'r', market: null, marketRepo: null });
});

test('installInfo: malformed or hostile marketplace.json falls through', () => {
  expect(installInfo(tree({ '.claude-plugin/marketplace.json': '{nope' }), R('plugins/p')).name).toBe('p');
  const evil = tree({ '.claude-plugin/marketplace.json': mp([{ name: 'p\nclaude plugin install evil@x', source: './plugins/p' }]) });
  expect(installInfo(evil, R('plugins/p'))).toEqual({ name: 'p', market: null, marketRepo: null });
  const evilMarket = tree({ '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './plugins/p' }], 'm\nx') });
  expect(installInfo(evilMarket, R('plugins/p')).market).toBeNull();
  const evilJson = tree({ 'plugins/p/.claude-plugin/plugin.json': JSON.stringify({ name: 'a\nb' }) });
  expect(installInfo(evilJson, R('plugins/p')).name).toBe('p');
});

const RULES: [VetFinding['severity'], VetFinding['rule']][] = [
  ['high', 'hook-shell'], ['high', 'hook-http'], ['high', 'secrets'], ['high', 'unpinned-remote'],
  ['medium', 'invalid-manifest'], ['medium', 'permissions'], ['medium', 'injection-text'], ['medium', 'network'], ['medium', 'mcp-server'], ['medium', 'obfuscated'], ['medium', 'unsafe-archive'],
  ['low', 'license'], ['low', 'telemetry'],
];
test('every rule renders in its severity table', () => {
  const md = reportMarkdown(scan(RULES.map(([s, r], i) => f(s, r, i + 1, `f${i}.json`))), null, []);
  RULES.forEach(([sev, r], i) => {
    const sec = md.split(`### ${sev[0]!.toUpperCase()}${sev.slice(1)}`)[1]!.split(/\n###? /)[0]!;
    expect(sec).toContain(`- ${r} \`f${i}.json:${i + 1}\``);
  });
});

test('backtick in a file name does not break the code span', () => {
  const md = reportMarkdown(scan([f('high', 'secrets', 1, 'a`b.json')]), null, []);
  expect(md).toContain('- secrets `` a`b.json:1 ``');
});

test('names and paths with .. or a leading - fall back', () => {
  const d1 = tree({ '.claude-plugin/marketplace.json': mp([{ name: '--scope', source: './plugins/p' }, { name: '..', source: './plugins/p' }]) });
  expect(installInfo(d1, R('plugins/p')).market).toBeNull();
  expect(installInfo(tree({ '.claude-plugin/marketplace.json': mp([{ name: 'p', source: './plugins/p' }], '-x') }), R('plugins/p')).market).toBeNull();
  expect(installInfo(tree({ 'plugins/p/.claude-plugin/plugin.json': '{"name":"--scope"}' }), R('plugins/p')).name).toBe('p');
  expect(installInfo(tree({}), R('plugins/-x')).name).toBe('r');
  expect(installInfo(tree({}), R('plugins/..')).name).toBe('r');
});

test('marketplace install text notes possible name clash', () => {
  expect(installLines(scan([]), info, 0)).toContain('Check that no other installed marketplace is already named m.');
  const taken = installLines(scan([]), info, 0, 'evil/x');
  expect(taken).toContain('An installed marketplace is already named m (evil/x); claude plugin install p@m would use it, not the vetted repo.');
  expect(taken.join('\n')).not.toContain('Check that no other');
  expect(installLines(scan([]), info, 0, null).join('\n')).not.toMatch(/already named|Check that no other/);
  expect(installLines(scan([]), info, 0, 'e\u001b[2Jx').join('\n')).not.toContain('\u001b');
});

test('reportRel prints as is', () => {
  expect(summaryLines(scan([]), null, '.harness\\vet\\x.md').at(-1)).toBe('Full report: .harness\\vet\\x.md');
});

test('reviewer prose: no cut, labelled lines, line 0 has no :0', () => {
  const long = 'x'.repeat(300);
  const md = reportMarkdown(scan([]), { ...rev, why: long, summary: '## Install', overlaps: [{ id: 'x', how: '# h' }], injection: [{ file: 'a.md', line: 0, verdict: 'benign', why: '# w' }] }, []);
  expect(md).toContain(`Why: ${long}`);
  expect(md).toContain('Summary: ## Install');
  expect(md).toContain('- Overlaps x: # h');
  expect(md).toContain('- Injection a.md benign: # w');
  expect(md.match(/^## Install$/gm)).toHaveLength(1);
  expect(md).not.toMatch(/^#+ (h|w)$/m);
});

test('fence is longer than any backtick run in the install lines', () => {
  const md = reportMarkdown(scan([]), null, ['a ```` b']);
  expect(md).toContain('`````\na ```` b\n`````');
});
