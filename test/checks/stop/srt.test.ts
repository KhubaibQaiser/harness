import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { locateSrt, realSrtProbe, srtMessage, SRT_MIN, STOP_WIN_UNATTENDED, WIN_STEPS_WARNING, type SrtProbe, type SrtWhy } from '../../../src/checks/stop/srt.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'srt-')));
const repo = join(base, 'repo');
const out = join(base, 'out');
const node = join(base, 'nodebin/node');
for (const d of [repo, out, join(base, 'nodebin'), join(out, 'dist')]) mkdirSync(d, { recursive: true });
writeFileSync(node, '');
const file = (p: string, s: string) => (writeFileSync(p, s), p);
const envNode = file(join(out, 'srt-env'), '#!/usr/bin/env node\nx');
const js = file(join(out, 'cli.js'), 'x');
const bin = file(join(out, 'srt'), '\x7fELF');
const link = join(out, 'srt-link');
symlinkSync(join(out, 'dist'), join(out, 'd2'));
file(join(out, 'dist/cli.js'), 'x');
symlinkSync(join(out, 'dist/cli.js'), link);
const probe = (path: string | null, ver: string | (() => string) = '0.0.83'): SrtProbe => ({ which: () => path, version: () => (typeof ver === 'function' ? ver() : ver) });
const loc = (p: SrtProbe, w = [repo], ex = node) => locateSrt(p, w, 'linux', ex);

describe('locateSrt', () => {
  test('missing', () => expect(loc(probe(null))).toEqual({ why: { kind: 'missing' } }));
  test('launch: env node shebang, .js and symlink to js run through execPath; other files run alone', () => {
    expect(loc(probe(envNode))).toMatchObject({ launch: [node, envNode] });
    expect(loc(probe(js))).toMatchObject({ launch: [node, js] });
    expect(loc(probe(bin))).toMatchObject({ launch: [bin] });
    expect(loc(probe(link))).toMatchObject({ path: link, real: join(out, 'dist/cli.js'), launch: [node, join(out, 'dist/cli.js')] });
  });
  test('the version probe gets the launch prefix', () => {
    const version = vi.fn(() => '0.0.83');
    loc({ which: () => envNode, version });
    expect(version).toHaveBeenCalledWith([node, envNode]);
  });
  test('found path or its realpath inside a writable root is refused, naming the offending link or file', () => {
    expect(loc(probe(js), [out])).toEqual({ why: { kind: 'writable', path: js } });
    const inRepo = join(repo, 'srt');
    symlinkSync(js, inRepo);
    expect(loc(probe(inRepo))).toEqual({ why: { kind: 'writable', path: inRepo } });
    expect(loc(probe(link), [join(out, 'dist')])).toEqual({ why: { kind: 'writable', path: join(out, 'dist/cli.js') } });
  });
  test('an interpreter inside a writable root is refused', () => {
    expect(loc(probe(js), [join(base, 'nodebin')])).toEqual({ why: { kind: 'writable', path: node } });
  });
  test('0.0.82 is old, 0.0.83 and 0.1.0 pass', () => {
    expect(loc(probe(js, '0.0.82'))).toEqual({ why: { kind: 'old', version: '0.0.82' } });
    expect(loc(probe(js, 'v0.0.83\n'))).toMatchObject({ version: '0.0.83' });
    expect(loc(probe(js, '0.1.0'))).toMatchObject({ version: '0.1.0' });
  });
  test('version probe that throws or prints no x.y.z is a failed check: version', () => {
    expect(loc(probe(js, () => { throw new Error('boom\nmore'); }))).toEqual({ why: { kind: 'check', check: 'version', first: 'boom' } });
    expect(loc(probe(js, 'hello\x1b[31m'))).toEqual({ why: { kind: 'check', check: 'version', first: 'hello\\u001b[31m' } });
  });
});

describe('messages', () => {
  const tail = ` Install @anthropic-ai/sandbox-runtime@${SRT_MIN} globally, outside the repo (Linux also needs bubblewrap 0.8 or newer, socat and ripgrep; macOS needs ripgrep), then stop again. To run the checks unsandboxed instead, set sandbox: off in .harness/config.yaml (logged).`;
  const cases: [SrtWhy, string][] = [
    [{ kind: 'missing' }, 'is not installed'],
    [{ kind: 'writable', path: '/x/y' }, 'is inside the repo or a writable folder (/x/y)'],
    [{ kind: 'old', version: '0.0.82' }, `is 0.0.82, older than ${SRT_MIN}`],
    [{ kind: 'check', check: 'version', first: 'boom' }, 'failed its check: version (boom)'],
  ];
  test('launcher failure adds the install hint', () => expect(srtMessage({ kind: 'check', check: 'launcher', first: 'x' })).toContain(`Install it with npm i -g @anthropic-ai/sandbox-runtime@${SRT_MIN} so srt is a node script, not a shim.`));
  test.each(cases)('srtMessage %j', (why, frag) => expect(srtMessage(why)).toBe(`Stop gate: the checks run inside sandbox-runtime (srt), and srt ${frag}.${tail}`));
  test('fixed strings', () => {
    expect(STOP_WIN_UNATTENDED).toBe("Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).");
    expect(WIN_STEPS_WARNING).toBe("Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.");
  });
});

describe('launcher classification and link walk', () => {
  const launcher = (first: string) => ({ why: { kind: 'check', check: 'launcher', first } });
  test('shell shim, nodejs shebang and foreign binaries are refused; version never called', () => {
    const version = vi.fn(() => '0.0.83');
    const run = (p: string) => locateSrt({ which: () => p, version }, [repo], 'linux', node);
    expect(run(file(join(out, 'shim'), '#!/bin/sh\nexec node x "$@"\n'))).toEqual(launcher('#!/bin/sh'));
    expect(run(file(join(out, 'njs'), '#!/usr/bin/env nodejs\n'))).toEqual(launcher('#!/usr/bin/env nodejs'));
    const vs = file(join(out, 'volta-shim'), '\x7fELF');
    const asSrt = join(out, 'dir2'); mkdirSync(asSrt); symlinkSync(vs, join(asSrt, 'srt'));
    expect(run(join(asSrt, 'srt'))).toEqual(launcher('volta-shim'));
    expect(version).not.toHaveBeenCalled();
  });
  test('a symlinked PATH dir into the repo holding a link that points out is refused', () => {
    mkdirSync(join(repo, 'bin'));
    symlinkSync(js, join(repo, 'bin/srt'));
    const alias = join(base, 'tools'); symlinkSync(join(repo, 'bin'), alias);
    expect(loc(probe(join(alias, 'srt')))).toEqual({ why: { kind: 'writable', path: join(repo, 'bin/srt') } });
  });
  test('a writable root given as a symlink alias of the repo is honoured', () => {
    const alias = join(base, 'repo-alias'); symlinkSync(repo, alias);
    expect(loc(probe(join(repo, 'bin/srt')), [alias])).toMatchObject({ why: { kind: 'writable' } });
  });
  test('a link loop is a launcher failure', () => {
    const a = join(out, 'la'), b = join(out, 'lb'); symlinkSync(b, a); symlinkSync(a, b);
    expect(loc(probe(a))).toMatchObject({ why: { kind: 'check', check: 'launcher' } });
  });
  test.skipIf(process.platform === 'win32')('an unreadable target is a failed check: version, not a throw', () => {
    const f = file(join(out, 'noread'), 'x'); chmodSync(f, 0o111);
    expect(loc(probe(f))).toMatchObject({ why: { kind: 'check', check: 'version' } });
  });
  test('the writable path is cleaned with esc', () => {
    const w = file(join(out, 'we\u202eird.js'), 'x');
    expect(loc(probe(w), [out])).toEqual({ why: { kind: 'writable', path: w.replace('\u202e', '\\u202e') } });
  });
});

describe('version parse', () => {
  test.each(['bwrap 0.9.0\nsrt 0.0.80', '0.0.83-beta', 'srt 0.0.83'])('%j fails version', (o) => expect(loc(probe(js, o))).toMatchObject({ why: { kind: 'check', check: 'version' } }));
  test('ANSI is stripped', () => expect(loc(probe(js, '\x1b[32m0.0.83\x1b[0m\n'))).toMatchObject({ version: '0.0.83' }));
  test('failure detail is stderr first line, else stdout', () => {
    const t = (e: object) => loc(probe(js, () => { throw Object.assign(new Error('Command failed'), e); }));
    expect(t({ stderr: 'bwrap: missing\nx', stdout: 'o' })).toMatchObject({ why: { first: 'bwrap: missing' } });
    expect(t({ stderr: '', stdout: 'out line\n' })).toMatchObject({ why: { first: 'out line' } });
  });
});

describe('realSrtProbe', () => {
  test('relative PATH entries are skipped', () => {
    const prev = process.cwd(); process.chdir(out); chmodSync(bin, 0o755);
    try { expect(realSrtProbe({ PATH: `.:${out}` }, 'linux').which('srt')).toBe(join(out, 'srt')); } finally { process.chdir(prev); }
  });
  test.skipIf(process.platform === 'win32')('SIGKILL ends a probe that ignores SIGTERM', () => {
    const f = file(join(out, 'deaf.js'), "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
    const t = Date.now();
    expect(() => realSrtProbe({}, 'linux', undefined, 300).version([process.execPath, f])).toThrow();
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

test('realSrtProbe argv is [--version] with a 5 s timeout', () => {
  const run = vi.fn(() => '0.0.83');
  const p = realSrtProbe({ PATH: out }, 'linux', run as never);
  expect(p.version(['/n', '/s.js'])).toBe('0.0.83');
  expect(run).toHaveBeenCalledWith('/n', ['/s.js', '--version'], expect.objectContaining({ timeout: 5000, encoding: 'utf8', killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: out } }));
});

describe('round 2', () => {
  test('a relative hop inside a symlinked PATH folder resolves from the real folder', () => {
    const real = join(base, 'n1/t1/t2'); mkdirSync(real, { recursive: true });
    symlinkSync(js, join(repo, 'x'));
    symlinkSync('../../../repo/x', join(real, 'srt'));
    const pd = join(base, 'pd'); symlinkSync(real, pd);
    expect(loc(probe(join(pd, 'srt')))).toEqual({ why: { kind: 'writable', path: join(repo, 'x') } });
  });
  test.each([['bom', '﻿#!/bin/sh\n'], ['space', ' #!/bin/sh\n'], ['text', 'echo hi\n']])('binary needs a known magic: %s is a launcher failure', (n, body) => {
    const d = join(base, `m-${n}`); mkdirSync(d);
    expect(loc(probe(file(join(d, 'srt'), body)))).toMatchObject({ why: { kind: 'check', check: 'launcher' } });
  });
  test('a symlink loop on execPath is a launcher failure', () => {
    const a = join(out, 'ea'), b = join(out, 'eb'); symlinkSync(b, a); symlinkSync(a, b);
    expect(loc(probe(js), [repo], a)).toMatchObject({ why: { kind: 'check', check: 'launcher' } });
  });
  test('a symlinked ancestor folder is checked at its real location', () => {
    mkdirSync(join(repo, 'stuff'));
    symlinkSync(out, join(repo, 'stuff/sub'));
    const tools = join(base, 'tools5'); symlinkSync(join(repo, 'stuff'), tools);
    expect(loc(probe(join(tools, 'sub/srt')))).toEqual({ why: { kind: 'writable', path: join(repo, 'stuff/sub') } });
  });
});
