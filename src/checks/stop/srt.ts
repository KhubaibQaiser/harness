import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { esc } from '../../core/config.js';
import { olderThan } from '../../core/min-claude.js';
import { realish, within } from '../../core/paths.js';
import { findOnPath } from './runner.js';

export const SRT_MIN = '0.0.83';
export type SrtWhy = { kind: 'missing' } | { kind: 'writable'; path: string } | { kind: 'old'; version: string } | { kind: 'check'; check: string; first: string };
// launch: argv prefix. Node scripts run through process.execPath, never the shebang's PATH lookup (PATH can be agent-controlled).
export type SrtFound = { path: string; real: string; version: string; launch: string[] };
export type SrtProbe = { which: (cmd: string) => string | null; version: (launch: string[]) => string };
type Run = (file: string, args: string[], o: { timeout: number; encoding: 'utf8' }) => string;

export const realSrtProbe = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, run: Run = execFileSync as Run): SrtProbe => ({
  which: (cmd) => findOnPath(cmd, env, platform),
  version: ([cmd, ...rest]) => run(cmd, [...rest, '--version'], { timeout: 5000, encoding: 'utf8' }),
});

function isNodeScript(p: string): boolean {
  if (/\.[cm]?js$/.test(p)) return true;
  const fd = openSync(p, 'r');
  try {
    const b = Buffer.alloc(256);
    const head = b.subarray(0, readSync(fd, b, 0, 256, 0)).toString('latin1').split('\n')[0];
    return /^#!.*\bnode\b/.test(head);
  } finally {
    closeSync(fd);
  }
}

const first = (s: string): string => esc(s.trim().split('\n')[0] ?? '');

export function locateSrt(probe: SrtProbe, writable: string[], platform: NodeJS.Platform, execPath: string = process.execPath): SrtFound | { why: SrtWhy } {
  const path = probe.which('srt');
  if (!path) return { why: { kind: 'missing' } };
  const real = realish(path);
  const node = isNodeScript(real);
  const interp = realish(execPath);
  for (const p of node ? [path, real, interp] : [path, real]) if (writable.some((w) => within(p, w, platform))) return { why: { kind: 'writable', path: p === path ? real : p } };
  const launch = node ? [execPath, real] : [real];
  let out: string;
  try {
    out = probe.version(launch);
  } catch (e) {
    return { why: { kind: 'check', check: 'version', first: first(e instanceof Error ? e.message : String(e)) } };
  }
  const version = /\d+\.\d+\.\d+/.exec(out)?.[0];
  if (!version) return { why: { kind: 'check', check: 'version', first: first(out) } };
  if (olderThan(version, SRT_MIN)) return { why: { kind: 'old', version } };
  return { path, real, version, launch };
}

export const srtReason = (w: SrtWhy): string =>
  w.kind === 'missing' ? 'is not installed'
  : w.kind === 'writable' ? `is inside the repo or a writable folder (${w.path})`
  : w.kind === 'old' ? `is ${w.version}, older than ${SRT_MIN}`
  : `failed its check: ${w.check} (${w.first})`;

export const srtMessage = (w: SrtWhy): string =>
  `Stop gate: the checks run inside sandbox-runtime (srt), and srt ${srtReason(w)}. Install @anthropic-ai/sandbox-runtime@${SRT_MIN} globally, outside the repo (Linux also needs bubblewrap 0.8 or newer, socat and ripgrep; macOS needs ripgrep), then stop again. To run the checks unsandboxed instead, set sandbox: off in .harness/config.yaml (logged).`;

export const STOP_WIN_UNATTENDED = "Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).";
export const WIN_STEPS_WARNING = "Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.";
export const VERIFY_NESTED = "harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).";
