import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { WIN_STEPS_WARNING, type SrtProbe } from '../../src/checks/stop/srt.js';
import type { StopSandboxRecord } from '../../src/checks/stop/record.js';
import { stopSandboxChecks } from '../../src/cli/doctor-stop.js';
import { defaults, type HarnessConfig } from '../../src/core/config.js';

// An existing .mjs file stands in for the srt script: it is real, and outside every writable root.
const SRT = fileURLToPath(new URL('../../build.mjs', import.meta.url));
const mk = (): { root: string; home: string } => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ds-')));
  const o = { root: join(base, 'repo'), home: join(base, 'home') };
  mkdirSync(o.root);
  mkdirSync(o.home);
  return o;
};
const cfg = (stop: Partial<HarnessConfig['stop']> = {}, sandbox: HarnessConfig['sandbox'] = 'unattended'): HarnessConfig => ({ ...defaults(), sandbox, stop: { ...defaults().stop, ...stop } });
const rec = (r: Partial<StopSandboxRecord> = {}): StopSandboxRecord => ({ ts: 't', srt: '0.0.83', outcome: 'ran', checks: {}, ...r });
type Over = { platform?: NodeJS.Platform; which?: Record<string, string | null>; version?: string; read?: (p: string) => string | null; bwrap?: string | null; record?: StopSandboxRecord | null; env?: NodeJS.ProcessEnv; home?: string; tok?: string | null; bwrapSpawn?: (bin: string) => void };
const run = (config: HarnessConfig, o: Over = {}) => {
  const lines: string[] = [];
  const { root, home } = mk();
  const which: Record<string, string | null> = { srt: SRT, rg: '/usr/bin/rg', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', ...o.which };
  const srt: SrtProbe = { which: (c) => which[c] ?? null, version: () => o.version ?? '0.0.83\n' };
  let spawned = 0;
  stopSandboxChecks(root, config, { ok: (s) => lines.push(`ok ${s}`), fix: (w, n) => lines.push(`fix ${w}: ${n}`), note: (w, n) => lines.push(`note ${w}${n === undefined ? '' : `: ${n}`}`) }, {
    platform: o.platform ?? 'linux', env: o.env ?? { PATH: '/usr/bin' }, home: o.home ?? home, srt, read: o.read ?? (() => null),
    bwrapVersion: (bin) => { spawned++; o.bwrapSpawn?.(bin as string); return o.bwrap === undefined ? 'bubblewrap 0.9.0\n' : o.bwrap; }, tokenBase: () => o.tok ?? null, record: () => (o.record === undefined ? rec() : o.record),
  });
  return { lines, spawned: () => spawned, home };
};

// These cases fake linux or darwin over real temp paths; on a win32 host those are D:\ paths that the POSIX
// within() can't place (production returns before them on win32), so they run on POSIX hosts only.
const posixHost = test.skipIf(process.platform === 'win32');

describe('stopSandboxChecks', () => {
  test('sandbox off: only the off note, no srt lookup', () => {
    const r = run(cfg({}, 'off'), { which: { srt: null } });
    expect(r.lines).toEqual(['note Stop steps run without srt (sandbox: off; each session logs stop-unwrapped)']);
  });
  test('win32: only the warning, nothing spawned or looked up', () => {
    const r = run(cfg(), { platform: 'win32', which: { srt: null } });
    expect(r.lines).toEqual([`note ${WIN_STEPS_WARNING}`]);
    expect(r.spawned()).toBe(0);
    expect(run(cfg({}, 'off'), { platform: 'win32' }).lines).toEqual([`note ${WIN_STEPS_WARNING}`, 'note Stop steps run without srt (sandbox: off; each session logs stop-unwrapped)']);
  });
  test('win32: a never-ran record is the fix line after the warning; srt still never looked up', () => {
    const r = run(cfg(), { platform: 'win32', which: { srt: null }, record: rec({ outcome: 'never-ran', reason: 'native Windows unattended' }) });
    expect(r.lines).toEqual([`note ${WIN_STEPS_WARNING}`, 'fix last Stop: checks never ran (native Windows unattended): fix what it names, then stop again']);
    expect(r.spawned()).toBe(0);
    expect(run(cfg(), { platform: 'win32', record: rec({ outcome: 'unavailable', reason: 'x' }) }).lines).toEqual([`note ${WIN_STEPS_WARNING}`]);
    expect(run(cfg(), { platform: 'win32', record: null }).lines).toEqual([`note ${WIN_STEPS_WARNING}`]);
  });
  posixHost('srt found: ok with version and real path', () => {
    expect(run(cfg()).lines).toContain(`ok Stop sandbox: srt 0.0.83 (${realpathSync(SRT)})`);
  });
  test('srt missing: fix with the install line', () => {
    expect(run(cfg(), { which: { srt: null } }).lines).toContain('fix Stop sandbox: srt is not installed: install @anthropic-ai/sandbox-runtime@0.0.83 globally, outside the repo');
  });
  test('srt too old: fix names both versions', () => {
    expect(run(cfg(), { version: '0.0.80' }).lines.join('\n')).toMatch(/^fix Stop sandbox: srt is 0\.0\.80, older than 0\.0\.83: install /m);
  });
  test('linux: sandboxBlocker problems are fixes', () => {
    const r = run(cfg(), { which: { socat: null } });
    expect(r.lines.some((l) => l.startsWith('fix') && l.includes('socat'))).toBe(true);
    const aa = run(cfg(), { read: (p) => (p.endsWith('apparmor_restrict_unprivileged_userns') ? '1\n' : null) });
    expect(aa.lines.some((l) => l.startsWith('fix') && l.includes('AppArmor'))).toBe(true);
  });
  test('linux: rg missing and bwrap older than 0.8 are fixes; 0.8 and 0.10 pass', () => {
    expect(run(cfg(), { which: { rg: null } }).lines.some((l) => l.startsWith('fix') && l.includes('rg'))).toBe(true);
    expect(run(cfg(), { bwrap: 'bubblewrap 0.7.9' }).lines.some((l) => l.startsWith('fix') && l.includes('bwrap 0.7.9'))).toBe(true);
    for (const v of ['bubblewrap 0.8.0', 'bubblewrap 0.10.1']) expect(run(cfg(), { bwrap: v }).lines.filter((l) => l.startsWith('fix'))).toEqual([]);
  });
  test('bwrap version unparseable or failing is a fix, never ok', () => {
    for (const bwrap of ['bwrap 0.9.0', 'bubblewrap 0.9', 'bubblewrap 0.9.0 extra', '', null]) {
      const l = run(cfg(), { bwrap }).lines;
      expect(l.some((x) => x.startsWith('fix') && x.includes('bwrap --version'))).toBe(true);
      expect(l.some((x) => x.startsWith('ok') && x.includes('bwrap'))).toBe(false);
    }
  });
  test('darwin: rg on PATH, no bwrap checks', () => {
    const miss = run(cfg(), { platform: 'darwin', which: { rg: null, bwrap: null, socat: null } });
    expect(miss.lines.filter((l) => l.startsWith('fix')).length).toBe(1);
    expect(miss.lines.find((l) => l.startsWith('fix'))).toContain('rg');
    expect(miss.spawned()).toBe(0);
    expect(run(cfg(), { platform: 'darwin', which: { bwrap: null } }).lines.filter((l) => l.startsWith('fix'))).toEqual([]);
  });
  posixHost('allow_write refusals are fixes with allowWriteMessage; a relative entry is a fix, not a throw', () => {
    const { home } = mk();
    const r = run(cfg({ allow_write: [home, 'rel/dir'] }), { home });
    expect(r.lines).toContain(`fix stop.allow_write can't list ${home}: it is your home folder. Choose a folder only your tests write, such as a cache folder: remove it from stop.allow_write in .harness/config.yaml`);
    expect(r.lines.some((l) => l.startsWith('fix') && l.includes('rel/dir'))).toBe(true);
  });
  test('allow_local note, only when on', () => {
    const msg = "note stop.allow_local is on: on macOS Stop steps reach every service on this machine's loopback, Claude Code's sandbox proxy included; on Linux it has no effect";
    expect(run(cfg({ allow_local: true })).lines).toContain(msg);
    expect(run(cfg()).lines).not.toContain(msg);
  });
  test('credential paths with glob characters are notes', () => {
    expect(run(cfg(), { home: '/h/*x' }).lines).toContain("note credential path /h/*x/.ssh has glob characters, so srt can't deny it");
  });
  test('record ran: ok per check, fix per failure, escaped and capped', () => {
    const r = run(cfg(), { record: rec({ checks: { 'write canary': 'ok', network: `bad\u001b[31m${'x'.repeat(300)}` } }) });
    expect(r.lines).toContain('ok last Stop preflight: write canary ok');
    const f = r.lines.find((l) => l.startsWith('fix last Stop preflight: network failed'))!;
    expect(f).not.toContain('\u001b');
    expect(f.length).toBeLessThan(300);
  });
  test('record unavailable: check lines plus the reason; never-ran: the fix; missing: the note', () => {
    const u = run(cfg(), { record: rec({ outcome: 'unavailable', reason: 'launcher', checks: { 'write canary': 'ok' } }) }).lines;
    expect(u).toContain('ok last Stop preflight: write canary ok');
    expect(u).toContain('fix last Stop: srt unavailable (launcher): fix what it names, then stop again');
    expect(run(cfg(), { record: rec({ outcome: 'never-ran', reason: 'srt unavailable' }) }).lines).toContain('fix last Stop: checks never ran (srt unavailable): fix what it names, then stop again');
    expect(run(cfg(), { record: null }).lines).toContain('note no Stop has run inside srt yet');
    const long = run(cfg(), { record: rec({ outcome: 'unavailable', reason: `a\u001b[0m${'y'.repeat(500)}` }) }).lines.find((l) => l.includes('srt unavailable'))!;
    expect(long).not.toContain('\u001b');
    expect(long.length).toBeLessThan(300);
  });
  describe('AppArmor bwrap profile (Ubuntu 25.04 and newer)', () => {
    const PROFILES = '/sys/kernel/security/apparmor/profiles';
    const FILE = '/etc/apparmor.d/bwrap-userns-restrict';
    const fixLine = (what: string) => `fix Stop sandbox: ${what}: run \`sudo apparmor_parser -R ${FILE}\` (it turns off Ubuntu's AppArmor user-namespace restriction for bwrap on this machine: fine on a throwaway CI runner, a real tradeoff on a shared or personal machine; harness never runs it)`;
    const loaded = (profiles: string | null, file: boolean) => (p: string) => (p === PROFILES ? profiles : p === FILE && file ? '# profile' : null);
    test('loaded profile (bwrap or unpriv_bwrap line) prints the fix', () => {
      for (const l of ['bwrap (enforce)', 'unpriv_bwrap (enforce)']) {
        expect(run(cfg(), { read: loaded(`foo (enforce)\n${l}\n`, true) }).lines).toContain(fixLine("AppArmor's bwrap-userns-restrict profile is loaded, so srt's seccomp helper is refused inside bwrap (apply-seccomp: write /proc/self/setgroups)"));
      }
    });
    test('profiles list readable without a bwrap line: nothing', () => {
      expect(run(cfg(), { read: loaded('bwrapper (enforce)\nfoo (enforce)\n', true) }).lines.some((l) => l.includes('apparmor_parser'))).toBe(false);
    });
    test('profiles list unreadable, file present: may be loaded', () => {
      expect(run(cfg(), { read: loaded(null, true) }).lines).toContain(fixLine("AppArmor's bwrap-userns-restrict profile may be loaded, so srt's seccomp helper may be refused inside bwrap (apply-seccomp: write /proc/self/setgroups)"));
    });
    test('neither readable: nothing; darwin: nothing; a throwing reader is a fix line, not a throw', () => {
      expect(run(cfg(), { read: loaded(null, false) }).lines.some((l) => l.includes('apparmor'))).toBe(false);
      expect(run(cfg(), { platform: 'darwin', read: loaded('bwrap (enforce)', true) }).lines.some((l) => l.includes('apparmor'))).toBe(false);
      const r = run(cfg(), { read: (p) => { if (p === PROFILES) throw new Error('eacces'); return null; } });
      expect(r.lines.some((l) => l.startsWith('fix Stop sandbox: AppArmor') && l.includes('could not be checked') && l.includes('eacces'))).toBe(true);
    });
  });
  test('an unexpected error becomes a fix naming the check, never a throw', () => {
    const lines: string[] = [];
    const srt: SrtProbe = { which: () => { throw new Error('boom'); }, version: () => '' };
    expect(() => stopSandboxChecks('/r', cfg(), { ok: (s) => lines.push(s), fix: (w, n) => lines.push(`fix ${w}: ${n}`), note: (w) => lines.push(w) }, { platform: 'linux', env: {}, home: '/h', srt, record: () => { throw new Error('rec'); }, bwrapVersion: () => null, tokenBase: () => null })).not.toThrow();
    expect(lines.some((l) => l.startsWith('fix') && l.includes('boom'))).toBe(true);
    expect(lines.some((l) => l.startsWith('fix') && l.includes('last Stop') && l.includes('rec'))).toBe(true);
  });
  const refused = (entry: string, why: string, o: Over = {}) => {
    const r = run(cfg({ allow_write: [entry] }), o);
    expect(r.lines).toContain(`fix stop.allow_write can't list ${entry}: ${why}. Choose a folder only your tests write, such as a cache folder: remove it from stop.allow_write in .harness/config.yaml`);
  };
  describe.skipIf(process.platform === 'win32')('allow_write refusal classes match the gate', () => {
    test('protected path', () => {
      const root = mk().root;
      const lines: string[] = [];
      const e = join(root, '.harness/state');
      const srt: SrtProbe = { which: (c) => (c === 'srt' ? SRT : '/usr/bin/x'), version: () => '0.0.83' };
      stopSandboxChecks(root, cfg({ allow_write: [e] }), { ok: () => {}, fix: (w) => lines.push(w), note: () => {} }, { platform: 'linux', env: { PATH: '/usr/bin' }, home: '/nohome/x', srt, read: () => null, bwrapVersion: () => 'bubblewrap 0.9.0', tokenBase: () => null, record: () => null });
      expect(lines.some((l) => l.includes(`can't list ${e}: it is a protected path`))).toBe(true);
    });
    test('home folder', () => {
      const { home } = mk();
      refused(home, 'it is your home folder', { home });
    });
    test('login-start folder', () => {
      const { home } = mk();
      refused(join(home, '.claude/x'), 'programs there run at login', { home });
    });
    test('PATH folder', () => {
      const d = join(mk().home, 'binp');
      mkdirSync(d);
      refused(d, 'it is on PATH', { env: { PATH: `${d}:/usr/bin` } });
    });
    test('srt install folder', () => {
      const { home } = mk();
      const pkg = join(home, 'lib/@anthropic-ai/sandbox-runtime');
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), '{"name":"@anthropic-ai/sandbox-runtime"}');
      writeFileSync(join(pkg, 'dist/cli.js'), '');
      refused(join(pkg, 'dist'), 'srt is installed there', { which: { srt: join(pkg, 'dist/cli.js') } });
    });
    test('token folder', () => {
      const t = join(mk().home, 'tok/harness/gh');
      mkdirSync(t, { recursive: true });
      refused(t, 'it holds the GitHub token folder', { tok: t });
    });
  });
  posixHost('allow_write entry text is escaped', () => {
    const { home } = mk();
    const l = run(cfg({ allow_write: [`${home}/.claude/\u001b[31mred\nline`] }), { home }).lines.filter((x) => x.includes('allow_write'));
    expect(l.length).toBeGreaterThan(0);
    for (const x of l) expect(x).not.toMatch(/[\u001b\n]/);
  });
  test('srt real path is escaped', () => {
    const lines = run(cfg(), { which: { srt: SRT } }).lines;
    expect(lines.every((x) => !x.includes('\u001b'))).toBe(true);
  });
  test('bwrap runs by the absolute path found; a relative path is a fix and never spawned', () => {
    let bin = '';
    run(cfg(), { which: { bwrap: '/opt/bin/bwrap' }, bwrapSpawn: (b) => (bin = b) });
    expect(bin).toBe('/opt/bin/bwrap');
    const r = run(cfg(), { which: { bwrap: './bwrap' } });
    expect(r.lines.some((l) => l.startsWith('fix Stop sandbox: bwrap is not on PATH as an absolute path'))).toBe(true);
    expect(r.spawned()).toBe(0);
  });
});
