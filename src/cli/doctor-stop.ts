// Doctor's "Stop sandbox" section: whether the Stop gate's steps can run inside srt, and what the last wrapped Stop saw.
import { execFileSync } from 'node:child_process';
import { allowWriteMessage, allowWriteProblem } from '../checks/stop/allow-write.js';
import { PREFLIGHT_ORDER } from '../checks/stop/preflight.js';
import { readStopRecord, type StopSandboxRecord } from '../checks/stop/record.js';
import { locateSrt, SRT_MIN, srtReason, WIN_STEPS_WARNING, type SrtProbe } from '../checks/stop/srt.js';
import { tempRoots, writableRoots } from '../checks/stop/srt-settings.js';
import { esc, type HarnessConfig } from '../core/config.js';
import { credentialFiles } from '../core/credentials.js';
import { olderThan } from '../core/min-claude.js';
import { realish } from '../core/paths.js';
import { sandboxBlocker, type MachineProbe } from '../core/sandbox-machine.js';
import { tokenBase } from '../core/token-base.js';

type P = { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void };
type Sys = {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; srt: SrtProbe; read?: MachineProbe['read'];
  bwrapVersion?: () => string | null; tokenBase?: () => string | null; record?: () => StopSandboxRecord | null;
};

const BWRAP_MIN = '0.8.0';
const cap = (s: string): string => esc(s.trim().split('\n')[0] ?? '').slice(0, 200); // record text can hold raw srt stderr
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `bwrap --version` output, or null when it can't be run. */
const realBwrapVersion = (): string | null => {
  try {
    return execFileSync('bwrap', ['--version'], { timeout: 5000, encoding: 'utf8', killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
};

export function stopSandboxChecks(root: string, config: HarnessConfig, p: P, sys: Sys): void {
  // Doctor never throws from here: any surprise is a fix naming the check.
  const guard = (check: string, f: () => void): void => {
    try {
      f();
    } catch (e) {
      p.fix(`Stop sandbox: ${check} could not be checked (${cap(msg(e))})`, 'run harness doctor again');
    }
  };
  const { platform } = sys;
  if (platform === 'win32') p.note(WIN_STEPS_WARNING);
  if (config.sandbox === 'off') p.note('Stop steps run without srt (sandbox: off; each session logs stop-unwrapped)');
  if (platform === 'win32' || config.sandbox === 'off') return;

  const stop = config.stop;
  let srtReal: string | null = null;
  guard('srt', () => {
    const which = sys.srt.which('srt');
    srtReal = which ? realish(which) : null;
    const found = locateSrt(sys.srt, writableRoots({ root: realish(root), stop, home: sys.home, tmp: tempRoots() }), platform);
    if ('why' in found) p.fix(`Stop sandbox: srt ${srtReason(found.why)}`, `install @anthropic-ai/sandbox-runtime@${SRT_MIN} globally, outside the repo`);
    else p.ok(`Stop sandbox: srt ${found.version} (${found.real})`);
  });

  guard('rg', () => {
    if (!sys.srt.which('rg')) p.fix('Stop sandbox: rg is not on PATH', 'install ripgrep');
  });
  if (platform === 'linux') {
    guard('bwrap', () => {
      const block = sandboxBlocker(platform, { which: sys.srt.which, read: sys.read });
      if (block) p.fix(`Stop sandbox: ${block.why}`, block.fix || 'use a machine that can run it');
      if (!sys.srt.which('bwrap')) return; // already named above
      const out = (sys.bwrapVersion ?? realBwrapVersion)();
      const v = out === null ? null : /^bubblewrap (\d+\.\d+\.\d+)\s*$/.exec(out)?.[1];
      if (!v) p.fix(`Stop sandbox: bwrap --version ${out === null ? 'failed' : `gave no version (${cap(out)})`}`, 'install bubblewrap 0.8 or newer');
      else if (olderThan(v, BWRAP_MIN)) p.fix(`Stop sandbox: bwrap ${v} is older than 0.8`, 'install bubblewrap 0.8 or newer');
    });
  }

  guard('stop.allow_write', () => {
    const base = { root: realish(root), home: sys.home, env: sys.env, platform, srtReal, tokenBase: (sys.tokenBase ?? (() => tokenBase(platform, sys.env)))() };
    for (const entry of stop.allow_write) {
      try {
        const why = allowWriteProblem(entry, base);
        if (why) p.fix(allowWriteMessage(entry, why), 'remove it from stop.allow_write in .harness/config.yaml');
      } catch (e) {
        p.fix(`stop.allow_write entry ${esc(entry)} is refused (${cap(msg(e))})`, 'fix it in .harness/config.yaml');
      }
    }
  });
  if (stop.allow_local) p.note("stop.allow_local is on: on macOS Stop steps reach every service on this machine's loopback, Claude Code's sandbox proxy included; on Linux it has no effect");
  guard('credential paths', () => {
    for (const s of credentialFiles(sys.home).skipped) p.note(`credential path ${esc(s)} has glob characters, so srt can't deny it`);
  });

  guard('last Stop record', () => {
    const r = (sys.record ?? (() => readStopRecord(root)))();
    if (!r) return p.note('no Stop has run inside srt yet');
    if (r.outcome !== 'never-ran') {
      for (const name of PREFLIGHT_ORDER(platform === 'linux')) {
        const d = r.checks[name];
        if (d === undefined) continue;
        if (d === 'ok') p.ok(`last Stop preflight: ${name} ok`);
        else p.fix(`last Stop preflight: ${name} failed (${cap(d)})`, 'fix what it names, then stop again');
      }
    }
    if (r.outcome === 'unavailable') p.fix(`last Stop: srt unavailable (${cap(r.reason ?? 'no reason recorded')})`, 'fix what it names, then stop again');
    else if (r.outcome === 'never-ran') p.fix(`last Stop: checks never ran (${cap(r.reason ?? 'no reason recorded')})`, 'fix what it names, then stop again');
  });
}
