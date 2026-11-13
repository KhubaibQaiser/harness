// Whether this machine can run Claude Code's sandbox: init picks `always` only where it can, and doctor flags a machine
// that can't run the strict sandbox the shared settings require. Probes are injected; nothing reads the real /proc.
import { expect, test } from 'vitest';
import { sandboxBlocker } from '../../src/core/sandbox-machine.js';

const files = (m: Record<string, string>) => (p: string) => m[p] ?? null;
const tools = (...have: string[]) => (c: string) => (have.includes(c) ? `/usr/bin/${c}` : null);
const ok = { which: tools('bwrap', 'socat'), read: files({}) };

test('macOS, and Linux/WSL2 with bwrap, socat and user namespaces: no blocker', () => {
  expect(sandboxBlocker('darwin', ok)).toBeNull();
  expect(sandboxBlocker('linux', ok)).toBeNull();
  expect(sandboxBlocker('linux', { ...ok, read: files({ '/proc/version': 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@x)' }) })).toBeNull();
  // Older WSL2 kernels say only "microsoft-standard", with no WSL2 string.
  expect(sandboxBlocker('linux', { ...ok, read: files({ '/proc/version': 'Linux version 4.19.128-microsoft-standard (oe-user@oe-host)' }) })).toBeNull();
  expect(sandboxBlocker('linux', { ...ok, read: files({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n' }) })).toBeNull();
});

test('native Windows, WSL1, the AppArmor userns restriction and missing tools are blockers, each with why and a fix', () => {
  expect(sandboxBlocker('win32', ok)).toEqual({ why: 'native Windows has no Claude Code sandbox', fix: '' });
  const wsl1 = sandboxBlocker('linux', { ...ok, read: files({ '/proc/version': 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0)' }) });
  expect(wsl1).toEqual({ why: 'WSL1 has no Claude Code sandbox', fix: 'move to WSL2' });
  const aa = sandboxBlocker('linux', { ...ok, read: files({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }) });
  expect(aa?.why).toMatch(/AppArmor restricts unprivileged user namespaces/);
  expect(aa?.fix).toMatch(/kernel\.apparmor_restrict_unprivileged_userns=0/);
  expect(sandboxBlocker('linux', { ...ok, which: tools('socat') })).toEqual({ why: 'the Linux sandbox needs bwrap and socat (missing: bwrap)', fix: 'install bwrap and socat' });
});
