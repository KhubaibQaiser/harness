import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { run } from '../../src/cli/index.js';
import { vet } from '../../src/cli/vet.js';
import type { Exec, ExecBytes } from '../../src/core/exec.js';
import { CAVEAT } from '../../src/vet/report.js';
import { UNREADABLE } from '../../src/vet/target.js';
import { repos } from '../fixtures/vet/repos.js';
import { tarGz, type TarSpec } from '../fixtures/vet/tar.js';
import { makeRepo } from '../install/helpers.js';

// Every unpacked folder of this file goes to a private temp dir, so --clean and the "folder is gone" checks never meet another file's folders.
const ENV = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
const TMP = mkdtempSync(join(tmpdir(), 'h-vet-cli-'));
process.env.TMPDIR = process.env.TMP = process.env.TEMP = TMP;
afterAll(() => {
  for (const [k, v] of Object.entries(ENV)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(TMP, { recursive: true, force: true });
});
const vetDirs = () => readdirSync(TMP).filter((n) => n.startsWith('harness-vet-'));
afterEach(() => { for (const n of vetDirs()) rmSync(join(TMP, n), { recursive: true, force: true }); });

const SHA = 'abc1234' + 'e'.repeat(33);
const M = 'f'.repeat(40);
type R = ReturnType<Exec>;
const ok = (stdout: string): R => ({ status: 0, stdout });
const NF: R = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
const files = (fs: Record<string, string>): TarSpec[] => Object.entries(fs).map(([name, body]) => ({ name, body }));
const serve = (entries: TarSpec[] | Record<string, string>): ExecBytes => () => ({ status: 0, stdout: tarGz(Array.isArray(entries) ? entries : files(entries)) });

/** A fake gh and claude: o/r at SHA on main, HEAD `ahead` commits past it; `over` answers first. */
function fake(o: { list?: unknown; ahead?: string; over?: (c: string, a: string[]) => R | undefined } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (c, a) => {
    calls.push([c, ...a]);
    const hit = o.over?.(c, a);
    if (hit) return hit;
    if (c === 'claude') return o.list === undefined ? { status: 127, stdout: '', missing: true } : ok(JSON.stringify(o.list));
    const ep = a[1] ?? '';
    if (ep === 'repos/o/r') return ok('main\n');
    if (ep === 'repos/o/r/commits/main') return ok(`${SHA}\n`);
    if (ep === `repos/o/r/compare/${SHA}...main`) return ok(`${o.ahead ?? '0'}\n`);
    return NF;
  };
  return { exec, calls };
}

const cli = (root: string, env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  return { lines, env: { root, env, out: (l: string) => lines.push(...l.split('\n')) } };
};
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? [`${relative(d, p)}/`, ...walk(p).map((x) => `${n}/${x}`)] : [n];
}).map((x) => x.split(sep).join('/'));
const snap = (root: string) => Object.fromEntries(walk(root).map((p) => [p, p.endsWith('/') ? '' : readFileSync(join(root, p), 'utf8')]));
const REPORT = `.harness/vet/o-r-${SHA}.md`;

function go(args: string[], deps: { exec?: Exec; bytes?: ExecBytes } = {}, root = makeRepo({}, { git: false })) {
  const c = cli(root);
  const code = vet(args, c.env, { exec: fake().exec, bytes: serve(repos.hooks), ...deps });
  return { code, out: c.lines, root, read: (p = REPORT) => readFileSync(join(root, p), 'utf8') };
}

describe('harness vet <target>', () => {
  test('writes the report, prints a short summary, leaves only .harness/vet changed and no folder', () => {
    const root = makeRepo({ 'a.txt': 'keep' }, { git: false });
    const before = snap(root);
    const r = go(['o/r'], {}, root);
    expect(r.code).toBe(0);
    expect(r.read().endsWith(`${CAVEAT}\n`)).toBe(true);
    expect(r.read()).toContain('Not reviewed.');
    expect(r.out.length).toBeLessThanOrEqual(12);
    expect(r.out.at(-1)).toBe(`Full report: ${REPORT}`);
    expect(vetDirs()).toEqual([]);
    const after = snap(root);
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((k) => k.startsWith('.harness/vet/') || k === '.harness/'), changed.join(',')).toBe(true);
  });
  test('a corrupt archive exits 1 and never creates a folder', () => {
    expect(go(['o/r'], { bytes: () => ({ status: 0, stdout: Buffer.from('not a tarball') }) }).code).toBe(1);
    expect(vetDirs()).toEqual([]);
  });
  test('the folder is gone after a throw once it exists: in the scan, and in the install text', async () => {
    vi.resetModules();
    vi.doMock('../../src/vet/scan.js', async (orig) => ({
      ...(await orig<typeof import('../../src/vet/scan.js')>()),
      scan: (f: { dir: string }) => { expect(existsSync(f.dir)).toBe(true); throw new Error('scan boom'); },
    }));
    try {
      const { vet: mocked } = await import('../../src/cli/vet.js');
      expect(() => mocked(['o/r'], cli(makeRepo({}, { git: false })).env, { exec: fake().exec, bytes: serve(repos.hooks) })).toThrow('scan boom');
      expect(vetDirs()).toEqual([]);
    } finally {
      vi.doUnmock('../../src/vet/scan.js');
      vi.resetModules();
    }
    const boom = fake({ over: (_c, a) => { if (a[1]?.includes('/compare/')) throw new Error('boom'); return undefined; } });
    expect(() => go(['o/r'], { exec: boom.exec })).toThrow('boom');
    expect(vetDirs()).toEqual([]);
  });
  test('errors from resolve and fetch print one line and exit 1; usage errors exit 2', () => {
    const big = go(['o/r'], { bytes: () => ({ status: 1, stdout: Buffer.alloc(0), tooBig: true }) });
    expect([big.code, big.out]).toEqual([1, [`o/r@abc1234: the archive is over 25 MB; vet stops.`]]);
    const bad = go(['not a target']);
    expect(bad.code).toBe(1);
    expect(bad.out).toHaveLength(1);
    for (const a of [[], ['o/r', '--keep'], ['o/r', '--bogus'], ['o/r', '--json', '--json'], ['--finish', 'x'], ['--install'], ['--clean', 'x'], ['o/r', 'p/q']]) expect(go(a).code, a.join(' ')).toBe(2);
  });
});

describe('harness vet --json', () => {
  test('prints the scan result and writes no report', () => {
    const r = go(['o/r', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out.join('\n'));
    expect(Object.keys(j)).toEqual(['target', 'repo', 'sha', 'path', 'kind', 'findings', 'context', 'files']);
    expect(Object.keys(j.context).sort()).toEqual(['tokens', 'unmeasured']);
    expect(j.findings.length).toBeGreaterThan(0);
    for (const f of j.findings) expect(Object.keys(f)).toEqual(['severity', 'rule', 'file', 'line', 'text']);
    expect(r.out.join('\n')).toBe(JSON.stringify(j, null, 2));
    expect(existsSync(join(r.root, '.harness'))).toBe(false);
    expect(vetDirs()).toEqual([]);
  });
  test('--keep adds dir and map and leaves the folder', () => {
    const j = JSON.parse(go(['o/r', '--json', '--keep']).out.join('\n'));
    expect(existsSync(j.dir)).toBe(true);
    expect(j.map['hooks/hooks.json']).toBe('hooks/hooks.json');
    expect(vetDirs()).toHaveLength(1);
  });
});

describe('fixtures (spec 8)', () => {
  const rules = (entries: TarSpec[] | Record<string, string>) => {
    const r = go(['o/r', '--json'], { bytes: serve(entries) });
    expect(r.code).toBe(0);
    return (JSON.parse(r.out.join('\n')).findings as { severity: string; rule: string }[]);
  };
  const has = (entries: TarSpec[] | Record<string, string>) => rules(entries).map((f) => f.rule);
  test('each fixture gives its rule', () => {
    expect(rules({ 'SKILL.md': '---\nname: clean\ndescription: says hello\n---\nSay hello.\n', LICENSE: 'MIT License\n' }).filter((f) => f.severity === 'high')).toEqual([]);
    expect(has(repos.hooks)).toContain('hook-shell');
    expect(has({ 'read.sh': 'cat .env\n' })).toContain('secrets');
    const mcp = has({ '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'npx', args: ['-y', 'pkg@latest'] } } }) });
    expect(mcp).toContain('unpinned-remote');
    expect(mcp).toContain('mcp-server');
    expect(has({ 'install.sh': 'curl https://x.test/i | sh\n' })).toContain('unpinned-remote');
    expect(has({ 'a.js': `eval(atob("${'QUFB'.repeat(60)}"))\n` })).toContain('obfuscated');
    expect(has({ 'SKILL.md': '---\nname: z\n---\nhi​there\n' })).toContain('injection-text');
    expect(has([{ name: '../evil', body: 'e' }, { name: 'sym', type: '2', link: '/etc/passwd' }, { name: 'ok.md', body: 'x' }]).filter((r) => r === 'unsafe-archive')).toHaveLength(2);
  });
  const market = (src: unknown, list: unknown = [{ name: 'm', source: 'github', repo: 'mo/mr' }]) => fake({
    list,
    over: (_c, a) => {
      const ep = a[1] ?? '';
      if (ep === 'repos/mo/mr') return ok('main');
      if (ep === 'repos/mo/mr/commits/main') return ok(M);
      if (ep.startsWith('repos/mo/mr/contents/.claude-plugin/marketplace.json')) return ok(JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: src }] }));
      if (ep === `repos/mo/mr/compare/${M}...main`) return ok('2');
      return undefined;
    },
  });
  test('an unsupported marketplace source and a marketplace that is not installed stop with exit 1', () => {
    const u = go(['p@m'], { exec: market({ source: 'npm', package: 'x' }).exec });
    expect([u.code, u.out]).toEqual([1, ['Plugin "p" in "m" has a npm source; vet checks github, git-subdir and relative-path sources only. Pass the plugin\'s GitHub URL instead.']]);
    const n = go(['p@m'], { exec: fake({ list: [] }).exec });
    expect(n.code).toBe(1);
    expect(n.out).toEqual(['Marketplace "m" is not installed. Run harness vet with the plugin\'s GitHub URL instead, such as https://github.com/<owner>/<repo>.']);
  });
  test('name@market: HEAD is the default branch, not the pinned sha', () => {
    const f = market('./');
    const r = go(['p@m'], { exec: f.exec });
    expect(r.code).toBe(0);
    expect(f.calls).toContainEqual(['gh', 'api', `repos/mo/mr/compare/${M}...main`, '--jq', '.ahead_by']);
    const md = r.read(`.harness/vet/p-${M}.md`);
    expect(md).toContain(`HEAD is 2 commits past the vetted ${M.slice(0, 7)}`);
    expect(md).toContain('claude plugin marketplace add mo/mr');
    expect(md).not.toContain('Check that no other installed marketplace');
    const once = market('./');
    let seen = 0;
    const fail: Exec = (c, a) => (a[1] === 'repos/mo/mr' && ++seen > 1 ? NF : once.exec(c, a));
    expect(go(['p@m'], { exec: fail }).read(`.harness/vet/p-${M}.md`)).toContain(`Could not check how far HEAD is past the vetted ${M.slice(0, 7)}.`);
  });
});

describe('name@market: pins and --finish', () => {
  const LIST = [{ name: 'm', source: 'github', repo: 'mo/mr' }];
  /** p@m whose entry is a github source o/r with `pin`; o/r main is 3 past SHA, stable 5 past. */
  const gm = (pin: Record<string, string>, list: unknown = LIST) => fake({
    list, ahead: '3',
    over: (_c, a) => {
      const ep = a[1] ?? '';
      if (ep === 'repos/mo/mr') return ok('main');
      if (ep === 'repos/mo/mr/commits/main') return ok(M);
      if (ep.startsWith('repos/mo/mr/contents/.claude-plugin/marketplace.json')) return ok(JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: { source: 'github', repo: 'o/r', ...pin } }] }));
      if (ep === `repos/o/r/commits/${SHA}` || ep === 'repos/o/r/commits/stable') return ok(SHA);
      if (ep === `repos/o/r/compare/${SHA}...stable`) return ok('5');
      return undefined;
    },
  });
  const P_REPORT = `.harness/vet/p-${SHA}.md`;
  test('an entry pinning a sha gets no HEAD line; a ref is compared against that ref; none against the default branch', () => {
    const sha = gm({ sha: SHA });
    const md = go(['p@m'], { exec: sha.exec }).read(P_REPORT);
    expect(md).not.toMatch(/HEAD is|Could not check/);
    expect(sha.calls.some((c) => c[2]?.includes('/compare/'))).toBe(false);
    expect(go(['p@m'], { exec: gm({ ref: 'stable' }).exec }).read(P_REPORT)).toContain(`HEAD is 5 commits past the vetted abc1234`);
    expect(go(['p@m'], { exec: gm({}).exec }).read(P_REPORT)).toContain(`HEAD is 3 commits past the vetted abc1234`);
  });
  const keptP = (root: string) => {
    const r = go(['p@m', '--json', '--keep'], { exec: gm({ ref: 'stable' }).exec }, root);
    const d = mkdtempSync(join(TMP, 'side-'));
    writeFileSync(join(d, 'scan.json'), r.out.join('\n'));
    writeFileSync(join(d, 'review.json'), JSON.stringify({ relevance: 'low', why: 'w', overlaps: [], injection: [], recommendation: 'skip', summary: 's' }));
    return { args: ['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], dir: JSON.parse(r.out.join('\n')).dir as string };
  };
  test('--finish reads the marketplace repo and the pin again', () => {
    const root = makeRepo({}, { git: false });
    const { args, dir } = keptP(root);
    const f = go(args, { exec: gm({ ref: 'stable' }).exec }, root);
    expect(f.code, f.out.join('\n')).toBe(0);
    expect(f.read(P_REPORT)).toContain('claude plugin marketplace add mo/mr');
    expect(f.read(P_REPORT)).toContain('HEAD is 5 commits past');
    expect(existsSync(dir)).toBe(false);
  });
  test('--finish stops when the marketplace can no longer be read, or the entry moved: exit 1, no report, folder kept', () => {
    const root = makeRepo({}, { git: false });
    const { args, dir } = keptP(root);
    const noClaude: Exec = (c, a) => (c === 'claude' ? { status: 127, stdout: '', missing: true } : gm({ ref: 'stable' }).exec(c, a));
    for (const exec of [gm({ ref: 'stable' }, 'garbage').exec, gm({ ref: 'stable' }, []).exec, noClaude]) {
      const f = go(args, { exec }, root);
      expect([f.code, f.out]).toEqual([1, [UNREADABLE]]);
    }
    const moved = fake({ list: LIST, over: (c, a) => (a[1]?.startsWith('repos/mo/mr/contents/') ? ok(JSON.stringify({ name: 'm', plugins: [{ name: 'p', source: { source: 'github', repo: 'o/other' } }] })) : a[1] === 'repos/o/other' ? ok('main') : a[1] === 'repos/o/other/commits/main' ? ok(SHA) : gm({ ref: 'stable' }).exec(c, a)) });
    expect(go(args, { exec: moved.exec }, root).out).toEqual(['scan: the marketplace entry for p@m changed since the scan; run harness vet --json --keep again']);
    expect(existsSync(join(root, '.harness'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('marketplace name collision', () => {
  const own = { '.claude-plugin/marketplace.json': JSON.stringify({ name: 'mk', plugins: [{ name: 'p', source: './' }] }), ...repos.hooks };
  const report = (list?: unknown) => go(['o/r'], { exec: fake({ list }).exec, bytes: serve(own) }).read();
  test('an installed marketplace with that name and another repo is named', () => {
    const md = report([{ name: 'mk', source: 'github', repo: 'evil/x' }]);
    expect(md).toContain('An installed marketplace is already named mk (evil/x); claude plugin install p@mk would use it, not the vetted repo.');
    expect(md).not.toContain('Check that no other');
  });
  test('the same repo, or no such name, adds no line; no claude keeps the generic line', () => {
    for (const list of [[{ name: 'mk', repo: 'o/r' }], [{ name: 'other', repo: 'evil/x' }]]) {
      const md = report(list);
      expect(md).not.toContain('already named');
      expect(md).not.toContain('Check that no other');
    }
    expect(report(undefined)).toContain('Check that no other installed marketplace is already named mk.');
    expect(report('not a list')).toContain('Check that no other installed marketplace is already named mk.');
  });
});

describe('harness vet --finish, --install, --clean', () => {
  const review = { relevance: 'low', why: 'little use here', overlaps: [], injection: [], recommendation: 'skip', summary: 'Reviewer summary text.' };
  const side = () => mkdtempSync(join(TMP, 'side-'));
  const kept = (root: string) => {
    const r = go(['o/r', '--json', '--keep'], {}, root);
    const d = side();
    writeFileSync(join(d, 'scan.json'), r.out.join('\n'));
    writeFileSync(join(d, 'review.json'), JSON.stringify(review));
    return { d, scan: JSON.parse(r.out.join('\n')) as Record<string, unknown> };
  };
  test('--finish writes the review into the report and deletes the folder; --install prints the install lines', () => {
    const root = makeRepo({}, { git: false });
    const noReport = go(['--install', join(kept(root).d, 'scan.json')], {}, root);
    expect([noReport.code, noReport.out]).toEqual([1, ['No report for o-r-abc1234. Run harness vet first.']]);
    const { d, scan } = kept(root);
    const before = snap(root);
    const f = go(['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], {}, root);
    expect(f.code, f.out.join('\n')).toBe(0);
    expect(f.read()).toContain('## Review');
    expect(f.read()).toContain('Summary: Reviewer summary text.');
    expect(f.out).toContain('Recommendation: skip');
    expect(existsSync(scan.dir as string)).toBe(false);
    const after = snap(root);
    expect(Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k] && !k.endsWith('/'))).toEqual([REPORT]);
    const i = go(['--install', join(d, 'scan.json')], {}, root);
    expect(i.code).toBe(0);
    expect(i.out).toContain('Pinned marketplace entry:');
    expect(JSON.parse(i.out.at(-1)!)).toEqual({ name: 'r', source: { source: 'github', repo: 'o/r', sha: SHA } });
  });
  test('an invalid review exits 2 with its errors and writes nothing', () => {
    const root = makeRepo({}, { git: false });
    const { d, scan } = kept(root);
    writeFileSync(join(d, 'review.json'), JSON.stringify({ ...review, overlaps: [{ id: 'invented', how: 'x' }] }));
    const f = go(['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], {}, root);
    expect([f.code, f.out]).toEqual([2, ['overlaps[0].id: "invented" is not an installed item']]);
    expect(existsSync(join(root, '.harness'))).toBe(false);
    expect(existsSync(scan.dir as string)).toBe(true);
  });
  test('a tampered scan.json is not a vet scan: exit 2, nothing written', () => {
    const root = makeRepo({}, { git: false });
    const { d, scan } = kept(root);
    const link = join(TMP, 'harness-vet-link');
    symlinkSync(root, link, 'junction');
    const bad = [{ sha: '../../x' }, { repo: 'a/../b' }, { path: '../up' }, { path: '/abs' }, { dir: root }, { dir: link }, { dir: join(TMP, 'other') }, { findings: 'x' }, { target: 'not a target' }, { findings: [{ severity: 'high', rule: '\u001b[2J', file: 'a', line: 1, text: 't' }] }, { context: null },
      { context: { tokens: '\u001b[2J', unmeasured: [] } }, { context: { tokens: 1, unmeasured: [1] } }, { findings: [{ severity: 'high', rule: 'secrets', file: 'a', line: '1\u001b', text: 't' }] },
      { findings: [{ severity: 'critical', rule: 'secrets', file: 'a', line: 1, text: 't' }] }, { dir: join(root, basename(scan.dir as string)) }, { dir: TMP }, { dir: join(TMP, 'harness-vet-other-abc1234-x') }];
    mkdirSync(join(TMP, 'harness-vet-other-abc1234-x'));
    for (const over of bad) {
      writeFileSync(join(d, 'scan.json'), JSON.stringify({ ...scan, ...over }));
      for (const args of [['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], ['--install', join(d, 'scan.json')]]) {
        const f = go(args, {}, root);
        expect([f.code, f.out], JSON.stringify(over)).toEqual([2, ['scan: not a vet scan; run harness vet --json first']]);
      }
    }
    writeFileSync(join(d, 'scan.json'), '{not json');
    expect(go(['--install', join(d, 'scan.json')], {}, root).code).toBe(2);
    expect(existsSync(join(root, '.harness'))).toBe(false);
    expect(existsSync(scan.dir as string)).toBe(true);
  });
  test('--finish after the folder is gone stops with exit 1 and writes nothing', () => {
    const root = makeRepo({}, { git: false });
    const { d, scan } = kept(root);
    rmSync(scan.dir as string, { recursive: true });
    const f = go(['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], {}, root);
    expect([f.code, f.out]).toEqual([1, ['scan: unpacked folder is gone; run harness vet --json --keep again']]);
    expect(existsSync(join(root, '.harness'))).toBe(false);
  });
  test('a __proto__ key in scan.json is an own key: no pollution', () => {
    const root = makeRepo({}, { git: false });
    const { d } = kept(root);
    const text = readFileSync(join(d, 'scan.json'), 'utf8');
    writeFileSync(join(d, 'scan.json'), `{"__proto__":{"polluted":1,"tokens":1},${text.slice(1)}`);
    expect(go(['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], {}, root).code).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  test('--install prints a report line with a control character escaped', () => {
    const root = makeRepo({}, { git: false });
    const { d } = kept(root);
    expect(go(['--finish', join(d, 'scan.json'), '--review', join(d, 'review.json')], {}, root).code).toBe(0);
    const p = join(root, REPORT);
    writeFileSync(p, readFileSync(p, 'utf8').replace('Pinned marketplace entry:', 'evil\u001b[2J\nPinned marketplace entry:'));
    const i = go(['--install', join(d, 'scan.json')], {}, root);
    expect(i.out).toContain('evil\\u001b[2J');
    expect(i.out.join('\n')).not.toContain('\u001b');
  });
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('--clean skips a folder it cannot remove and says so', () => {
    const blocked = join(TMP, 'harness-vet-blocked-1');
    mkdirSync(join(blocked, 'sub'), { recursive: true });
    writeFileSync(join(blocked, 'sub', 'f'), 'x');
    chmodSync(join(blocked, 'sub'), 0o000);
    try {
      mkdirSync(join(TMP, 'harness-vet-ok-1'));
      const r = go(['--clean']);
      expect([r.code, r.out]).toEqual([0, ['Removed 1 unpacked vet folder(s); could not remove 1.']]);
      expect(vetDirs()).toEqual(['harness-vet-blocked-1']);
      const only = go(['--clean']);
      expect([only.code, only.out]).toEqual([1, ['Removed 0 unpacked vet folder(s); could not remove 1.']]);
    } finally {
      chmodSync(join(blocked, 'sub'), 0o755);
    }
  });
  test('--clean removes the unpacked folders', () => {
    mkdirSync(join(TMP, 'harness-vet-x-abc1234-1'));
    go(['o/r', '--json', '--keep']);
    expect(vetDirs()).toHaveLength(2);
    const r = go(['--clean']);
    expect(r.code).toBe(0);
    expect(vetDirs()).toEqual([]);
  });
});

test('vet is not an AI command: it runs in a plain terminal and inside Claude Code', () => {
  for (const env of [{}, { CLAUDECODE: '1' }]) {
    const c = cli(makeRepo({}, { git: false }), env);
    expect(run(['vet', '--clean'], c.env)).toBe(0);
    expect(c.lines.join('\n')).not.toMatch(/Claude Code|plain terminal/);
    const b = cli(makeRepo({}, { git: false }), env);
    expect(run(['vet', 'not a target'], b.env)).toBe(1);
    expect(b.lines[0]).toMatch(/^Not a GitHub repo/);
  }
});
