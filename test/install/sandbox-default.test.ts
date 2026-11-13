// Owner ruling 2026-11-13: init turns Claude Code's sandbox on by default where the platform supports it, and leaves it
// off on native Windows (and on Linux without bwrap/socat) with a stated reason.
import { expect, test } from 'vitest';
import { detect } from '../../src/install/detect.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from './helpers.js';

const facts = () => detect(makeRepo({ 'package.json': JSON.stringify({ name: 'app' }) + '\n' }));
const ALL = (cmd: string) => `/bin/${cmd}`;
const NONE = () => null;
const NOPROC = () => null; // the real /proc is never read: CI's Ubuntu restricts user namespaces
const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;

test('macOS, and Linux/WSL2 with bwrap and socat: sandbox always', () => {
  expect(preset(facts(), ALL, 'darwin', NOPROC).config.sandbox).toBe('always');
  expect(preset(facts(), ALL, 'linux', NOPROC).config.sandbox).toBe('always');
  expect(preset(facts(), ALL, 'darwin', NOPROC).reasons.sandbox).toMatch(/on in every session/);
});

test('native Windows, and Linux without bwrap/socat: required for unattended runs only, with the reason', () => {
  const win = preset(facts(), ALL, 'win32', NOPROC);
  expect(win.config.sandbox).toBe('unattended');
  expect(win.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/native Windows has no Claude Code sandbox/) });
  const lin = preset(facts(), NONE, 'linux', NOPROC);
  expect(lin.config.sandbox).toBe('unattended');
  expect(lin.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/bwrap and socat/) });
});

test('WSL1 and the Ubuntu AppArmor user-namespace restriction: required for unattended runs only, with the reason and fix', () => {
  const wsl1 = preset(facts(), ALL, 'linux', files({ '/proc/version': 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)' }));
  expect(wsl1.config.sandbox).toBe('unattended');
  expect(wsl1.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/WSL1 has no Claude Code sandbox.*move to WSL2/) });
  const aa = preset(facts(), ALL, 'linux', files({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }));
  expect(aa.config.sandbox).toBe('unattended');
  expect(aa.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/AppArmor restricts unprivileged user namespaces.*apparmor_restrict_unprivileged_userns=0/) });
  expect(preset(facts(), ALL, 'linux', files({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n' })).config.sandbox).toBe('always');
});
