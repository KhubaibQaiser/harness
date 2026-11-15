// Behavioural preflight: before any step runs inside srt, prove the fence holds. A probe that throws means "blocked" = ok.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect } from 'node:net';
import { esc } from '../../core/config.js';
import type { CheckName, ResultLine } from './steps.js';

export type PreflightPlan = { writeCanary: string; readCanary: string; socket: string; linux: boolean };
export type Probes = { write(p: string): void; read(p: string): string; connect(sock: string): Promise<void>; https(url: string): Promise<void>; bwrap(): number | null };

export const PREFLIGHT_ORDER = (linux: boolean): CheckName[] => ['write canary', 'read canary', 'unix socket', 'network', ...(linux ? (['user namespace'] as const) : [])];

// A probe settles once: resolve = it got through (fence leak); reject = refused, errored or hung past its limit (fence held).
const limited = (ms: number, start: (done: (ok: boolean) => void) => () => void) =>
  new Promise<void>((res, rej) => {
    let stop = (): void => undefined;
    const done = (leak: boolean) => (clearTimeout(t), stop(), leak ? res() : rej(new Error('blocked')));
    const t = setTimeout(() => done(false), ms);
    stop = start(done);
  });

export const realProbes: Probes = {
  write: (p) => appendFileSync(p, 'x'),
  read: (p) => readFileSync(p, 'utf8'),
  connect: (sock) =>
    limited(2000, (done) => {
      const c = connect(sock);
      c.on('connect', () => done(true)).on('error', () => done(false));
      return () => c.destroy();
    }),
  // Reached = a completed HTTP response, any status (srt's proxy may answer CONNECT with a 403 page; that still means the network answered). A TLS error, refusal, reset or 3 s of silence = blocked.
  // agent:false and no redirect handling: env proxies are never used and nothing is followed.
  https: (url) =>
    limited(3000, (done) => {
      const r = request(url, { method: 'HEAD', agent: false }, (res) => (res.resume(), done(true)));
      r.on('error', () => done(false)).end();
      return () => r.destroy();
    }),
  bwrap: () => spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true'], { timeout: 5000 }).status,
};

const FAIL: Record<CheckName, string> = {
  'write canary': 'wrote to the state canary',
  'read canary': 'read the temp canary',
  'unix socket': 'connected to the runner socket',
  network: 'reached example.com',
  'user namespace': 'nested bwrap user namespace worked',
};

/** Emits one check line per check, in order, stopping after the first failure. True when every check holds. */
export async function preflight(p: PreflightPlan, probes: Probes, emit: (l: ResultLine) => void, nonce: string): Promise<boolean> {
  const run: Record<CheckName, () => Promise<string | undefined>> = {
    'write canary': async () => (probes.write(p.writeCanary), undefined),
    'read canary': async () => probes.read(p.readCanary),
    'unix socket': async () => probes.connect(p.socket).then(() => undefined),
    network: async () => probes.https('https://example.com').then(() => undefined),
    'user namespace': async () => {
      const s = probes.bwrap();
      if (s === 0) return '';
      throw new Error('blocked');
    },
  };
  for (const name of PREFLIGHT_ORDER(p.linux)) {
    let leaked: string | undefined;
    let got = false;
    try {
      leaked = await run[name]();
      got = true;
    } catch {
      // blocked
    }
    const line = (got ? (leaked ?? '').split('\n')[0]! : '') || FAIL[name];
    emit(got ? { nonce, kind: 'check', name, ok: false, detail: esc(line).slice(0, 200) } : { nonce, kind: 'check', name, ok: true });
    if (got) return false;
  }
  return true;
}
