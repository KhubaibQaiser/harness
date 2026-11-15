// The wrapped Stop runner: one srt call per run, the steps inside it, strict nonce-tagged result lines. Every failure is unavailable.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { esc, type HarnessConfig } from '../../core/config.js';
import { real, realish, within } from '../../core/paths.js';
import { allowWriteMessage, allowWriteProblem } from './allow-write.js';
import type { Exec } from './gate.js';
import { PREFLIGHT_ORDER, type PreflightPlan } from './preflight.js';
import { locateSrt, srtMessage, type SrtProbe } from './srt.js';
import { renderSrtSettings, tempRoots, writableRoots } from './srt-settings.js';
import type { CheckName, Plan, ResultLine, RunSteps, StepResult, StepsRun } from './steps.js';

export interface WrapDeps { root: string; stop: HarnessConfig['stop']; exec: Exec; now: () => number; srt: SrtProbe; home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tokenBase: () => string | null; node: string; nonce?: () => string; tmp?: string }
export type Expected = { kind: 'check'; name: CheckName } | { kind: 'step'; label: string };

export const srtArgv = (settings: string, node: string, runner: string, plan: string, nonce: string): string[] => ['--settings', settings, node, '--no-warnings', runner, '--stop-steps', plan, nonce];

const PROXY = 'sandbox proxy:';
const MAX_PROXY = 1024;
const first = (s: string): string => esc(s.trim().split('\n')[0] ?? '');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const failing = (l: ResultLine): boolean => (l.kind === 'step' ? l.timedOut || l.status !== 0 : !l.ok);
const opt = (v: unknown) => v === undefined || typeof v === 'string';
const valid = (o: Record<string, unknown>): boolean =>
  o.kind === 'step'
    ? (o.status === null || Number.isInteger(o.status)) && typeof o.timedOut === 'boolean' && Number.isFinite(o.ms) && opt(o.output)
    : typeof o.ok === 'boolean' && opt(o.detail);
const desc = (e: Expected): string => (e.kind === 'step' ? `step '${e.label}'` : `check '${e.name}'`);

/** Lines must match `expected` in order, and stop right after the first failing entry or at its end. */
export function parseResults(stdout: string, nonce: string, expected: Expected[], seal: string): { lines: ResultLine[] } | { error: string } {
  const lines: ResultLine[] = [];
  const all = stdout.split('\n').filter((s) => s.trim());
  // The sealed end line must be last, once, and carry the seal. Only the runner holds the seal (step code reads the nonce, never this), so forged result lines cannot pass.
  // Residual: a step with ptrace-attach rights over its parent (Yama ptrace_scope=0) could read runner memory; live batch LS checks srt's ptrace/seccomp policy.
  const sealed = (t: string): boolean => {
    try {
      const o = JSON.parse(t);
      return o?.nonce === nonce && o.kind === 'end' && o.seal === seal;
    } catch {
      return false;
    }
  };
  if (!all.length || !sealed(all.pop()!)) return { error: 'end line: missing' };
  for (const [i, text] of all.entries()) {
    const at = `line ${i + 1}`;
    const e = expected[i];
    if (!e || (lines.length && failing(lines.at(-1)!))) return { error: `${at}: extra` };
    let o: Record<string, unknown> | null;
    try {
      o = JSON.parse(text);
    } catch {
      return { error: `${at}: not JSON` };
    }
    if (!o || typeof o !== 'object' || o.nonce !== nonce) return { error: `${at}: no nonce` };
    if (o.kind !== e.kind || (e.kind === 'step' ? o.label !== e.label : o.name !== e.name)) return { error: `${at}: out of order (expected ${desc(e)})` };
    if (!valid(o)) return { error: `${at}: bad fields` };
    lines.push(o as ResultLine);
  }
  if (lines.length < expected.length && !(lines.length && failing(lines.at(-1)!))) return { error: `line ${lines.length + 1}: missing (${desc(expected[lines.length]!)})` };
  return { lines };
}

// lstat does not follow links; ctime moves on any write, chmod or rename and userland cannot set it back.
const identity = (f: string): string => {
  const st = lstatSync(f);
  return st.isFile() ? [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':') : 'not a file';
};
const MAX_SOCK = 104; // macOS sun_path, including the NUL

export interface Preflight { plan: PreflightPlan; denyWrite: string[]; denyRead: string[]; verify(): string | null; close(): void }

/** Outer side of the preflight: new canaries and a listening socket (all exclusive creates), checked again after srt returns. */
export async function preparePreflight(root: string, tmp: string, nonce: string, platform: NodeJS.Platform): Promise<Preflight> {
  if (platform === 'win32') throw new Error('srt is not supported on native Windows');
  const writeCanary = join(root, '.harness/state', `canary-${nonce}`);
  const readCanary = join(tmp, `h-canary-${nonce}`);
  const socket = join(tmp, `h-${nonce.slice(0, 12)}.sock`);
  if (Buffer.byteLength(socket) >= MAX_SOCK) throw new Error(`socket path is ${Buffer.byteLength(socket)} bytes, over the ${MAX_SOCK - 1} limit: ${socket}`);
  const body = randomBytes(16).toString('hex');
  const made: string[] = [];
  let connected = false;
  let ident = '';
  const server = createServer((c) => ((connected = true), c.destroy()));
  let listening = false;
  const close = (): void => {
    if (listening) server.close();
    for (const f of made) {
      try {
        rmSync(f, { force: true });
      } catch (e) {
        process.stderr.write(`harness: could not delete ${f}: ${first(msg(e))}\n`);
      }
    }
  };
  try {
    writeFileSync(writeCanary, body, { flag: 'wx', mode: 0o600 });
    made.push(writeCanary);
    ident = identity(writeCanary);
    writeFileSync(readCanary, randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 });
    made.push(readCanary);
    await new Promise<void>((res, rej) => server.once('error', rej).listen(socket, res));
    listening = true;
    made.push(socket);
  } catch (e) {
    close();
    throw e;
  }
  return {
    plan: { writeCanary, readCanary, socket, linux: platform === 'linux' },
    denyWrite: [writeCanary],
    denyRead: [readCanary],
    verify: () => {
      try {
        if (identity(writeCanary) !== ident || readFileSync(writeCanary, 'utf8') !== body) return 'write canary';
      } catch {
        return 'write canary';
      }
      return connected ? 'unix socket' : null;
    },
    close,
  };
}

export const runWrapped = (d: WrapDeps): RunSteps => async (steps, deadline) => {
  const fail = (check: string, why: string): StepsRun => ({ kind: 'unavailable', message: srtMessage({ kind: 'check', check, first: first(why) }), reason: check });
  const files: string[] = [];
  let pre: Preflight | undefined;
  let stage = 'token base'; // names the failed check when anything below throws
  try {
    const tokenBase = d.tokenBase();
    stage = 'stop.allow_write';
    const root = realish(d.root);
    const which = d.srt.which('srt');
    const sys = { root, home: d.home, env: d.env, platform: d.platform, srtReal: which ? realish(which) : null, tokenBase };
    for (const entry of d.stop.allow_write) {
      const why = allowWriteProblem(entry, sys);
      if (why) return { kind: 'unavailable', message: allowWriteMessage(entry, why), reason: 'stop.allow_write' };
    }
    stage = 'launcher';
    const inputs = { root, stop: d.stop, home: d.home, tmp: tempRoots() };
    const roots = writableRoots(inputs);
    const found = locateSrt(d.srt, roots, d.platform, d.node);
    if ('why' in found) return { kind: 'unavailable', message: srtMessage(found.why), reason: found.why.kind === 'check' ? found.why.check : found.why.kind };
    // launch[0] for a node launch; a binary srt still runs the step runner with node, so check it the same way.
    const node = realish(d.node);
    const hit = [d.node, node].find((p) => roots.flatMap((w) => [w, realish(w)]).some((w) => within(p, w, d.platform)));
    if (hit) return { kind: 'unavailable', message: srtMessage({ kind: 'writable', path: esc(hit) }), reason: 'writable' };
    stage = 'step runner';
    const runner = join(root, '.harness/hooks/dispatch.mjs'); // R2: the protected hook bundle, on srt's denyWrite
    if (!lstatSync(runner).isFile()) return fail(stage, 'not a regular file');
    if (real(runner) !== runner) return fail(stage, 'not its own realpath');
    stage = 'settings file';
    const nonce = (d.nonce ?? (() => randomBytes(16).toString('hex')))();
    const dir = join(root, '.harness/state');
    const sFile = join(dir, `srt-${nonce}.json`);
    const pFile = join(dir, `plan-${nonce}.json`);
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory() || real(dir) !== dir) return fail(stage, 'state folder is not a real directory');
    stage = 'preflight';
    pre = await preparePreflight(root, d.tmp ?? inputs.tmp.reduce((a, b) => (Buffer.byteLength(b) < Buffer.byteLength(a) ? b : a)), nonce, d.platform);
    stage = 'settings file';
    // R1: the runner must read the plan, so only the settings file is on denyRead. The nonce binds a line's origin; it is not a secret (step code can read it).
    const settings = Buffer.from(JSON.stringify(renderSrtSettings({ ...inputs, tokenBase, denyWrite: pre.denyWrite, denyRead: [sFile, ...pre.denyRead] }, d.platform)));
    const plan: Plan = { nonce, deadlineMs: deadline, steps, preflight: pre.plan };
    writeFileSync(sFile, settings, { flag: 'wx', mode: 0o600 });
    files.push(sFile);
    try {
      writeFileSync(pFile, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      return fail(stage, `plan: ${msg(e)}`);
    }
    files.push(pFile);
    const ms = deadline - d.now();
    if (ms <= 0) return { kind: 'timeout' };
    // srt only debug-logs a missing settings file, so check it holds our bytes just before the spawn.
    let st;
    try {
      st = lstatSync(sFile);
    } catch {
      return fail(stage, 'missing');
    }
    if (!st.isFile()) return fail(stage, 'not a regular file');
    if (!readFileSync(sFile).equals(settings)) return fail(stage, 'changed');
    stage = 'srt exit';
    const seal = randomBytes(32).toString('hex'); // stdin only: never in a file, argv, env or message
    const r = await d.exec(found.launch[0]!, [...found.launch.slice(1), ...srtArgv(sFile, node, runner, pFile, nonce)], ms, `${seal}\n`);
    await new Promise((res) => setImmediate(res)); // let the listener accept a connection that arrived at the very end
    const seen = pre.verify(); // the outer view of the canaries and socket, whatever the inner lines say
    if (seen) return fail(seen, 'seen by the outer runner');
    if (r.timedOut) {
      // Steps start only after every check passed, so a timeout stays a timeout unless a check line that did arrive failed.
      for (const text of (r.stdout ?? '').split('\n')) {
        try {
          const o = JSON.parse(text);
          if (o?.nonce === nonce && o.kind === 'check' && o.ok === false && PREFLIGHT_ORDER(pre.plan.linux).includes(o.name)) return fail(o.name, typeof o.detail === 'string' ? esc(o.detail.slice(0, 200)).slice(0, 200) : 'failed');
        } catch {
          /* a partial or non-JSON line is ignored */
        }
      }
      return { kind: 'timeout' };
    }
    const err = r.stderr ?? '';
    if (r.status !== 0) return fail(stage, err.trim() ? err : r.output.trim() ? r.output : `status ${r.status}`);
    const expected: Expected[] = [...PREFLIGHT_ORDER(pre.plan.linux).map((name): Expected => ({ kind: 'check', name })), ...steps.map((s): Expected => ({ kind: 'step', label: s.label }))];
    const parsed = parseResults(r.stdout ?? '', nonce, expected, seal);
    if ('error' in parsed) return fail('result lines', parsed.error);
    const results: StepResult[] = parsed.lines.flatMap((l) => (l.kind === 'step' ? [{ label: l.label, status: l.status, timedOut: l.timedOut, ms: l.ms, output: l.output ?? '' }] : []));
    const bad = parsed.lines.find((l) => l.kind === 'check' && !l.ok);
    if (bad?.kind === 'check') return fail(bad.name, bad.detail ?? 'failed');
    // R12: srt's stderr should hold only proxy lines; anything else means a degraded srt.
    const errLines = err.split('\n').filter((s) => s.trim());
    const warn = errLines.find((s) => !s.startsWith(PROXY));
    if (warn) return fail('srt warning', warn);
    const last = results.at(-1);
    const failed = !!last && (last.timedOut || last.status !== 0);
    if (!failed && r.stderrRolled) return fail('srt warning', 'stderr overflow'); // the dropped head may have held a warning
    const all = errLines.join('\n');
    const cut = all.slice(-MAX_PROXY);
    const proxy = all.length > MAX_PROXY && all[all.length - MAX_PROXY - 1] !== '\n' ? cut.slice(cut.indexOf('\n') + 1) : cut; // start at a line boundary
    if (failed && proxy) last.output += `\n${proxy}`; // srt's own denial lines explain a step that needed the network
    return { kind: 'ran', results };
  } catch (e) {
    return fail(stage, msg(e));
  } finally {
    pre?.close();
    for (const f of files) {
      try {
        rmSync(f, { force: true });
      } catch (e) {
        process.stderr.write(`harness: could not delete ${f}: ${first(msg(e))}\n`);
      }
    }
  }
};
