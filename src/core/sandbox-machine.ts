import { readFileSync } from 'node:fs';

export type MachineProbe = { which: (cmd: string) => string | null; read?: (path: string) => string | null };
export type Blocker = { why: string; fix: string };

const readProc = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};
const AA = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

/**
 * Why this machine can't run Claude Code's sandbox, or null when it can. Init picks `sandbox: always` only when null, and
 * doctor flags a blocked machine. bwrap needs unprivileged user namespaces, which Ubuntu 23.10+ AppArmor restricts.
 */
export function sandboxBlocker(platform: NodeJS.Platform, probe: MachineProbe): Blocker | null {
  if (platform === 'win32') return { why: 'native Windows has no Claude Code sandbox', fix: '' };
  if (platform === 'darwin') return null;
  const read = probe.read ?? readProc;
  // WSL1's kernel string says "Microsoft" with no WSL2 marker; WSL2 says "microsoft-standard-WSL2".
  const version = read('/proc/version') ?? '';
  if (/microsoft/i.test(version) && !/wsl2/i.test(version)) return { why: 'WSL1 has no Claude Code sandbox', fix: 'move to WSL2' };
  const missing = ['bwrap', 'socat'].filter((c) => !probe.which(c));
  if (missing.length) return { why: `the Linux sandbox needs bwrap and socat (missing: ${missing.join(', ')})`, fix: 'install bwrap and socat' };
  if (read(AA)?.trim() === '1') {
    return {
      why: 'AppArmor restricts unprivileged user namespaces, which bwrap needs',
      fix: 'add an AppArmor profile that lets bwrap use user namespaces, or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`',
    };
  }
  return null;
}
