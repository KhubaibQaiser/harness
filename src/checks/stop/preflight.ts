// Behavioural preflight: before any step runs inside srt, prove the fence holds. A check is ok only on positive evidence of a deny (see DENY).
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect } from 'node:net';
import { esc } from '../../core/config.js';
import type { CheckName, ResultLine } from './steps.js';

export type PreflightPlan = { writeCanary: string; readCanary: string; socket: string; linux: boolean };
export type Probes = { write(p: string): void; read(p: string): string; connect(sock: string): Promise<void>; https(url: string): Promise<void>; bwrap(): number | null };

export const PREFLIGHT_ORDER = (linux: boolean): CheckName[] => ['write canary', 'read canary', 'unix socket', 'network', ...(linux ? (['user namespace'] as const) : [])];

// A probe settles once: resolve = it got through (fence leak); reject = an error carrying its errno code. A sync throw from start rejects too.
const limited = (ms: number, timeoutCode: string, start: (done: (leak: boolean, code?: string) => void) => () => void) =>
  new Promise<void>((res, rej) => {
    let stop: (() => void) | undefined;
    let settled = false;
    const done = (leak: boolean, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      stop?.();
      leak ? res() : rej(Object.assign(new Error(code ?? 'error'), { code }));
    };
    const t = setTimeout(() => done(false, timeoutCode), ms);
    try {
      stop = start(done);
      if (settled) stop();
    } catch (e) {
      done(false, (e as { code?: string }).code);
    }
  });

export const realProbes: Probes = {
  write: (p) => appendFileSync(p, 'x'),
  read: (p) => readFileSync(p, 'utf8'),
  connect: (sock) =>
    limited(2000, 'ETIMEDOUT', (done) => {
      const c = connect(sock);
      c.on('connect', () => done(true)).on('error', (e: NodeJS.ErrnoException) => done(false, e.code));
      return () => c.destroy();
    }),
  // Direct egress only (agent:false: no env proxy, no redirects); srt's proxy domain filter is not tested here.
  // Reached = a TCP connection was established (certificate errors, silence or a non-TLS reply afterwards do not matter), or any completed response.
  // Blocked = the errors listed in DENY.network, or HARNESS_TIMEOUT: 3 s without a connection.
  https: (url) =>
    limited(3000, 'HARNESS_TIMEOUT', (done) => {
      const r = request(url, { method: 'HEAD', agent: false, rejectUnauthorized: false }, (res) => (res.resume(), done(true)));
      r.on('socket', (s) => s.once('connect', () => done(true))).on('error', (e: NodeJS.ErrnoException) => done(false, e.code)).end();
      return () => r.destroy();
    }),
  bwrap: () => {
    const r = spawnSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
    if (r.error || r.signal || r.status === null) throw Object.assign(new Error(`bwrap: ${(r.error as NodeJS.ErrnoException | undefined)?.code ?? r.signal ?? 'no status'}`), { code: 'BWRAP' });
    return r.status;
  },
};

// A check is ok only on positive evidence of a deny; any other error, or getting through, fails it.
const DENY: Partial<Record<CheckName, string[]>> = {
  'write canary': ['EPERM', 'EROFS', 'EACCES'],
  'read canary': ['EPERM', 'EACCES'],
  'unix socket': ['EPERM', 'EACCES'],
  network: ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPERM', 'EACCES', 'HARNESS_TIMEOUT'],
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
  // Each runner returns undefined when the probe proves a deny without throwing, or the failure line.
  const run: Record<CheckName, () => Promise<string | undefined>> = {
    'write canary': async () => (probes.write(p.writeCanary), FAIL['write canary']),
    'read canary': async () => {
      const c = probes.read(p.readCanary);
      return c === '' ? undefined : c.split('\n')[0] || FAIL['read canary']; // '' = srt masked the file
    },
    'unix socket': async () => probes.connect(p.socket).then(() => FAIL['unix socket']),
    network: async () => probes.https('https://example.com').then(() => FAIL.network),
    'user namespace': async () => {
      const s = probes.bwrap();
      return s === null ? 'bwrap: no status' : s === 0 ? FAIL['user namespace'] : undefined;
    },
  };
  for (const name of PREFLIGHT_ORDER(p.linux)) {
    let fail: string | undefined;
    try {
      fail = await run[name]();
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      if (!(typeof code === 'string' && DENY[name]?.includes(code))) fail = `${typeof code === 'string' ? `${code}: ` : ''}${String((e as Error | null)?.message ?? e).split('\n')[0]}`;
    }
    emit(fail === undefined ? { nonce, kind: 'check', name, ok: true } : { nonce, kind: 'check', name, ok: false, detail: esc(fail.slice(0, 200)).slice(0, 200) });
    if (fail !== undefined) return false;
  }
  return true;
}
