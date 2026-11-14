import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readlinkSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { esc } from '../../core/config.js';
import { olderThan } from '../../core/min-claude.js';
import { realish, within } from '../../core/paths.js';
import { findOnPath } from './runner.js';

export const SRT_MIN = '0.0.83';
export type SrtWhy = { kind: 'missing' } | { kind: 'writable'; path: string } | { kind: 'old'; version: string } | { kind: 'check'; check: string; first: string };
// launch: argv prefix. Node scripts run through process.execPath, never the shebang's PATH lookup (PATH can be agent-controlled).
export type SrtFound = { path: string; real: string; version: string; launch: string[] };
export type SrtProbe = { which: (cmd: string) => string | null; version: (launch: string[]) => string };
type Run = (file: string, args: string[], o: { timeout: number; encoding: 'utf8'; killSignal: 'SIGKILL'; stdio: ['ignore', 'pipe', 'pipe']; env: NodeJS.ProcessEnv }) => string;

export const realSrtProbe = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, run: Run = execFileSync as Run, timeout = 5000): SrtProbe => ({
  // A relative PATH entry is agent-controlled (cwd), so it is never searched.
  which: (cmd) => {
    const win = platform === 'win32';
    const key = Object.keys(env).find((k) => (win ? k.toUpperCase() === 'PATH' : k === 'PATH'));
    const abs = key ? (env[key] ?? '').split(win ? ';' : ':').filter((d) => isAbsolute(d)).join(win ? ';' : ':') : '';
    return findOnPath(cmd, { ...env, ...(key ? { [key]: abs } : {}) }, platform);
  },
  version: ([cmd, ...rest]) => run(cmd, [...rest, '--version'], { timeout, encoding: 'utf8', killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], env }),
});

type Kind = 'node' | 'script' | 'binary';
// The kind of the launch target, and its first line (shown when a script is refused).
function classify(p: string): { kind: Kind; head: string } {
  const fd = openSync(p, 'r');
  try {
    const b = Buffer.alloc(256);
    const head = b.subarray(0, readSync(fd, b, 0, 256, 0)).toString('latin1').split('\n')[0];
    const kind = /\.[cm]?js$/.test(p) || /^#!.*\bnode\b/.test(head) ? 'node' : head.startsWith('#!') ? 'script' : 'binary';
    return { kind, head };
  } finally {
    closeSync(fd);
  }
}

const first = (s: string): string => esc(s.trim().split('\n')[0] ?? '');
const text = (v: unknown): string => (v == null ? '' : String(v));
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const check = (c: string, f: string): { why: SrtWhy } => ({ why: { kind: 'check', check: c, first: f } });

// Every link in the chain, each as written and with its folder resolved (a link may be reached through a symlinked folder).
function chain(p: string): string[] | null {
  const out: string[] = [];
  for (let cur = p, i = 0; i < 40; i++) {
    out.push(cur, join(realish(dirname(cur)), basename(cur)));
    let t: string;
    try {
      t = readlinkSync(cur);
    } catch {
      return out;
    }
    cur = resolve(dirname(cur), t);
  }
  return null;
}

export function locateSrt(probe: SrtProbe, writable: string[], platform: NodeJS.Platform, execPath: string = process.execPath): SrtFound | { why: SrtWhy } {
  const found = probe.which('srt');
  if (!found) return { why: { kind: 'missing' } };
  const path = resolve(found);
  const hops = chain(path);
  if (!hops) return check('launcher', 'too many symlinks');
  const real = realish(path);
  let c: { kind: Kind; head: string };
  try {
    c = classify(real);
  } catch (e) {
    return check('version', first(e instanceof Error ? e.message : String(e)));
  }
  const interp = realish(execPath);
  const roots = writable.flatMap((w) => [w, realish(w)]);
  const hit = [...hops, real, ...(c.kind === 'node' ? [...(chain(execPath) ?? []), interp] : [])].find((p) => roots.some((w) => within(p, w, platform)));
  if (hit) return { why: { kind: 'writable', path: esc(hit) } };
  if (c.kind === 'script') return check('launcher', first(c.head));
  if (c.kind === 'binary' && !/^srt(\.exe)?$/.test(basename(real))) return check('launcher', esc(basename(real)));
  const launch = c.kind === 'node' ? [interp, real] : [real];
  let out: string;
  try {
    out = probe.version(launch);
  } catch (e) {
    const x = e as { stderr?: unknown; stdout?: unknown; message?: unknown };
    return check('version', first(text(x.stderr).trim() ? text(x.stderr) : text(x.stdout).trim() ? text(x.stdout) : text(x.message)));
  }
  const line = out.replace(ANSI, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(line)?.[1];
  if (!version) return check('version', first(out));
  if (olderThan(version, SRT_MIN)) return { why: { kind: 'old', version } };
  return { path, real, version, launch };
}

export const srtReason = (w: SrtWhy): string =>
  w.kind === 'missing' ? 'is not installed'
  : w.kind === 'writable' ? `is inside the repo or a writable folder (${w.path})`
  : w.kind === 'old' ? `is ${w.version}, older than ${SRT_MIN}`
  : `failed its check: ${w.check} (${w.first})`;

export const srtMessage = (w: SrtWhy): string =>
  `Stop gate: the checks run inside sandbox-runtime (srt), and srt ${srtReason(w)}. Install @anthropic-ai/sandbox-runtime@${SRT_MIN} globally, outside the repo (Linux also needs bubblewrap 0.8 or newer, socat and ripgrep; macOS needs ripgrep), then stop again. To run the checks unsandboxed instead, set sandbox: off in .harness/config.yaml (logged).${w.kind === 'check' && w.check === 'launcher' ? ` Install it with npm i -g @anthropic-ai/sandbox-runtime@${SRT_MIN} so srt is a node script, not a shim.` : ''}`;

export const STOP_WIN_UNATTENDED = "Stop steps don't run unsandboxed in an unattended run on native Windows. Run in WSL2 or the harness dev container, or set sandbox: off (logged).";
export const WIN_STEPS_WARNING = "Stop steps run without a sandbox on native Windows: the project's tests run with your full access. Use WSL2 or the harness dev container for a sandboxed Stop gate.";
