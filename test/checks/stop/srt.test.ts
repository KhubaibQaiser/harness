import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { locateSrt, realSrtProbe, srtMessage, SRT_MIN, STOP_WIN_UNATTENDED, VERIFY_NESTED, WIN_STEPS_WARNING, type SrtProbe, type SrtWhy } from '../../../src/checks/stop/srt.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'srt-')));
const repo = join(base, 'repo');
const out = join(base, 'out');
const node = join(base, 'nodebin/node');
for (const d of [repo, out, join(base, 'nodebin'), join(out, 'dist')]) mkdirSync(d, { recursive: true });
writeFileSync(node, '');
const file = (p: string, s: string) => (writeFileSync(p, s), p);
const envNode = file(join(out, 'srt-env'), '#!/usr/bin/env node\nx');
const js = file(join(out, 'cli.js'), 'x');
const bin = file(join(out, 'srt-bin'), '\x7fELF');
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
  test('found path or its realpath inside a writable root is refused, naming the realpath', () => {
    expect(loc(probe(js), [out])).toEqual({ why: { kind: 'writable', path: js } });
    const inRepo = join(repo, 'srt');
    symlinkSync(js, inRepo);
    expect(loc(probe(inRepo))).toEqual({ why: { kind: 'writable', path: js } });
    expect(loc(probe(link), [join(out, 'dist')])).toEqual({ why: { kind: 'writable', path: join(out, 'dist/cli.js') } });
  });
  test('an interpreter inside a writable root is refused', () => {
    expect(loc(probe(js), [join(base, 'nodebin')])).toEqual({ why: { kind: 'writable', path: node } });
  });
  test('0.0.82 is old, 0.0.83 and 0.1.0 pass', () => {
    expect(loc(probe(js, '0.0.82'))).toEqual({ why: { kind: 'old', version: '0.0.82' } });
    expect(loc(probe(js, 'srt v0.0.83\n'))).toMatchObject({ version: '0.0.83' });
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
  test.each(cases)('srtMessage %j', (why, frag) => expect(srtMessage(why)).toBe(`Stop gate: the checks run inside sandbox-runtime (srt), and srt ${frag}.${tail}`));
  test('fixed strings', () => {
    expect(STOP_WIN_UNATTENDED).toBe("Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).");
    expect(WIN_STEPS_WARNING).toBe("Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.");
    expect(VERIFY_NESTED).toBe("harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).");
  });
});

test('realSrtProbe argv is [--version] with a 5 s timeout', () => {
  const run = vi.fn(() => '0.0.83');
  const p = realSrtProbe({ PATH: out }, 'linux', run as never);
  expect(p.version(['/n', '/s.js'])).toBe('0.0.83');
  expect(run).toHaveBeenCalledWith('/n', ['/s.js', '--version'], expect.objectContaining({ timeout: 5000, encoding: 'utf8' }));
});
