import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { RETRY, RETRY_BUDGET_MS, renameWithRetry, retryTransient, writeAtomic } from './atomic.js';
import { randomBytes } from 'node:crypto';
import { appendEventSafe } from './events.js';
import { join } from 'node:path';
import type { GuardedView } from './harness-files.js';

export interface SessionState {
  startedAt: number;
  files: string[];
  approved: boolean;
  askNoted?: true; // the multi-file note was shown this turn
  reasonDenied?: string[]; // files already denied for a missing reason this turn
  redTests: string[];
  lockedTests: string[];
  stopAttempts: number;
  stopNoGitLogged?: boolean; // stop-no-git already logged this session
  stopUnwrappedLogged?: boolean; // stop-unwrapped already logged this session
  stopOffRefusedLogged?: boolean; // stop-unwrapped-refused already logged this session
  sandboxBase?: string; // config `sandbox` at the session's first hook: only this value can unwrap the Stop steps
  stopNothingLogged?: boolean; // stop-nothing-to-run already logged this session
  sandboxUnavailableLogged?: true; // sandbox-unavailable already logged this session
  lateReasons?: { ts: string; rel: string }[]; // allow-logs with "no reason given", looked up again at the next Stop or prompt
  stopToolMissing?: string[]; // Stop steps whose missing tool was already logged and warned about this session
  baseHead?: string; // git HEAD at the session's first hook
  harnessFiles?: Record<string, string>; // sha-256 of harness's own files: the session's change-detection snapshot
  harnessHead?: string; // HEAD when that snapshot was taken
  harnessNoticed?: string; // the change set already shown at a prompt (Stop still blocks once)
  guardedBase?: Record<string, GuardedView>; // ConfigChange's baseline: the guarded settings views at the first other hook
  guardedCli?: string; // cli.id when guardedBase was taken: only a later CLI record allows a ConfigChange
  guardedOwned?: unknown[] | null; // the manifest's settings blocks when guardedBase was taken (null: unknown)
  guardedApplied?: Record<string, GuardedView>; // settings views a ConfigChange let through since guardedBase
  pendingNotice?: string; // a blocked ConfigChange, shown at the next prompt
  decisionHits?: { pattern: string; excerpt: string }[]; // team-decision signals from prompts, at most 3
  decisionNudged?: true; // the team-decision nudge was shown this session
  decisionsWarned?: string[]; // team decisions the Stop warning already named this session
  rememberAdded?: true; // a harness remember add ran this session
  doneClaimAttempts?: number; // blocks by the done-claim Stop check since the last clean claim
}

export const isSafeSessionId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';

export function statePath(root: string, session: string): string {
  if (!isSafeSessionId(session)) throw new Error(`unsafe session id: ${session}`);
  return join(root, '.harness/state', `${session}.json`);
}


// A turn reset that couldn't get the write lock waits in `<session>.reset`: reads show it applied, the next write applies it.
const resetMarker = (root: string, session: string) => `${statePath(root, session).slice(0, -'.json'.length)}.reset`;
const turnReset = (s: SessionState): SessionState => ({ ...s, files: [], approved: false, askNoted: undefined, reasonDenied: [], stopAttempts: 0, doneClaimAttempts: undefined });

export function readState(root: string, session: string, read: (p: string, e: 'utf8') => string = readFileSync): SessionState {
  const s = readFile(root, session, read);
  return existsSync(resetMarker(root, session)) ? turnReset(s) : s;
}

function readFile(root: string, session: string, read: (p: string, e: 'utf8') => string): SessionState {
  const fresh: SessionState = { startedAt: Date.now(), files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 };
  const f = statePath(root, session);
  let text: string;
  // Windows: a scanner or another process can hold the file for a moment. Retry, and never answer a read error
  // with a fresh state: the next write would then drop everything recorded so far.
  try {
    text = retryTransient(() => read(f, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return fresh; // no state yet
    throw e;
  }
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...fresh, ...(v as Partial<SessionState>) } : fresh;
  } catch {
    return fresh; // corrupt file: start over (it is rewritten on the first hook)
  }
}

// True when a usable (parseable object) state file exists.
export function stateExists(root: string, session: string): boolean {
  try {
    const v: unknown = JSON.parse(readFileSync(statePath(root, session), 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export function writeState(root: string, session: string, s: SessionState): void {
  const f = statePath(root, session);
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  writeAtomic(f, JSON.stringify(s));
}

export { renameWithRetry }; // kept for existing importers

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const key = (v: unknown): string => JSON.stringify(v) ?? 'undefined';
export const MAX_HITS = 3; // decisionHits kept per session (the decisions nudge)
// Snapshots taken as a whole: never combined with another hook's value.
const WHOLE = new Set(['guardedOwned']);

/**
 * Three-way merge of one hook's change (`base` to `next`) into the state now on disk (`cur`). A field the hook left as
 * it was keeps `cur`'s value. A list keeps `cur`'s items minus the ones the hook removed, plus the ones it added; a
 * record does the same per key; a raised counter takes the larger value (a reset stays a reset); anything else takes
 * the hook's value.
 */
export function mergeState(base: SessionState, next: SessionState, cur: SessionState): SessionState {
  const b = base as unknown as Record<string, unknown>;
  const n = next as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...cur };
  for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
    const [bv, nv, cv] = [b[k], n[k], out[k]];
    if (key(bv) === key(nv)) continue;
    if (!WHOLE.has(k) && [bv, nv, cv].every((v) => v === undefined || Array.isArray(v))) {
      const was = new Set(((bv ?? []) as unknown[]).map(key));
      const now = (nv ?? []) as unknown[];
      const nowKeys = new Set(now.map(key));
      const kept = ((cv ?? []) as unknown[]).filter((x) => !was.has(key(x)) || nowKeys.has(key(x)));
      const have = new Set(kept.map(key));
      const list = [...kept, ...now.filter((x) => !was.has(key(x)) && !have.has(key(x)))];
      out[k] = k === 'decisionHits' ? list.slice(0, MAX_HITS) : list; // the cap holds after a merge too: disk's first, then ours
    } else if (!WHOLE.has(k) && [bv, nv, cv].every((v) => v === undefined || isRecord(v))) {
      const [br, nr] = [(bv ?? {}) as Record<string, unknown>, (nv ?? {}) as Record<string, unknown>];
      const r: Record<string, unknown> = { ...(cv as Record<string, unknown> | undefined) };
      for (const f of new Set([...Object.keys(br), ...Object.keys(nr)])) {
        if (key(br[f]) === key(nr[f])) continue;
        if (nr[f] === undefined) delete r[f];
        else r[f] = nr[f];
      }
      out[k] = nv === undefined && !Object.keys(r).length ? undefined : r; // a removed record keeps keys other hooks added
    } else if (typeof nv === 'number' && typeof cv === 'number' && nv > (typeof bv === 'number' ? bv : 0)) {
      const b0 = typeof bv === 'number' ? bv : 0;
      out[k] = cv < b0 ? cv + (nv - b0) : Math.max(nv, cv); // reset by another hook meanwhile: keep the reset, add our raise
    } else out[k] = nv;
  }
  return out as unknown as SessionState;
}

/** Writes this hook's change (`base` to `next`) onto the state as it is on disk right now; returns what was written. */
export function writeMerged(root: string, session: string, base: SessionState, next: SessionState): SessionState {
  return updateState(root, session, (cur) => mergeState(base, next, cur));
}

export function clearTurn(root: string, session: string): void {
  try {
    updateState(root, session, turnReset);
  } catch (e) {
    if (!(e instanceof StateBusyError)) throw e;
    writeFileSync(resetMarker(root, session), ''); // not lost: the next write applies it, and reads already show it
    appendEventSafe(root, { ts: new Date().toISOString(), session, check: 'state-lock', decision: 'turn-reset-pending' });
  }
}

const readOwner = (lock: string): { pid?: number; nonce?: string } | null => {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner'), 'utf8'));
  } catch {
    return null;
  }
};

// Stale: the owner process is dead, or there is no readable owner file and the dir is older than 30 s.
function isStale(lock: string): boolean {
  const o = readOwner(lock);
  if (typeof o?.pid === 'number') {
    try {
      process.kill(o.pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return Date.now() - statSync(lock).mtimeMs > 30000;
}

export type LockOps = {
  rename: (from: string, to: string) => void;
  rm: (p: string, o?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }) => void;
  mkdir: (p: string, o?: { recursive?: boolean }) => unknown;
};
const REAL_OPS: LockOps = { rename: renameSync, rm: rmSync, mkdir: mkdirSync };
const BREAK_STALE_MS = 5000;
export const LOCK_WAIT = { ms: 5000 }; // bounded: a hook never hangs on a stuck holder (tests shorten it)

// Breaks a stale lock with breakers serialised by `<lock>.break`. The lock is judged again under the break lock: only a
// breaker or the lock's own (live) owner ever removes it, so a lock that was replaced since the first look (a new
// holder, maybe before its owner file exists) reads as live or young there and is left alone.
function breakStale(lock: string, nonce: string, ops: LockOps): void {
  const brk = `${lock}.break`;
  try {
    ops.mkdir(brk);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return;
    // A breaker died mid-break: clear its break lock (renamed first, so a newer one is never removed by name).
    if (Date.now() - statSync(brk).mtimeMs > BREAK_STALE_MS) {
      const old = `${brk}.stale.${nonce}`;
      ops.rename(brk, old);
      ops.rm(old, { recursive: true, force: true });
    }
    return;
  }
  try {
    if (!isStale(lock)) return;
    const gone = `${lock}.stale.${nonce}`;
    ops.rename(lock, gone);
    ops.rm(gone, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  } finally {
    ops.rm(brk, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 }); // a leftover blocks breaking for 5 s
  }
}

// One attempt at an exclusive, owner-tagged lock dir: 'held', 'busy' (a live holder; a stale one is broken first) or
// 'unusable' (the dir can't be made for another reason).
function tryTake(lock: string, nonce: string, ops: LockOps): 'held' | 'busy' | 'unusable' {
  try {
    ops.mkdir(lock);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'unusable';
    try {
      if (isStale(lock)) breakStale(lock, nonce, ops);
    } catch {
      // lock or break lock vanished meanwhile: look again
    }
    return 'busy';
  }
  try {
    writeFileSync(join(lock, 'owner'), JSON.stringify({ pid: process.pid, nonce }));
  } catch {
    // an owner-less lock still expires after 30 s
  }
  return 'held';
}

// Rename first, so the lock name is free at once; on Windows removing the dir fails while a waiter has `owner`
// open, and a half-removed lock of a now-dead owner is what several waiters then break at the same time.
function release(lock: string, nonce: string, ops: LockOps): void {
  if (readOwner(lock)?.nonce !== nonce) return;
  const freed = `${lock}.free.${nonce}`;
  let renamed = false;
  try {
    renameWithRetry(lock, freed, ops.rename);
    renamed = true;
  } catch {
    // could not rename: remove it in place (the name is still ours)
  }
  try {
    // After the rename the lock name may already be a new holder's: only ever remove the freed dir then.
    ops.rm(renamed ? freed : lock, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  } catch {
    // a leftover .free.* dir is harmless; a leftover lock has a dead owner once this process exits (broken as stale)
  }
}

const lockOf = (root: string, session: string, ext: string) => `${statePath(root, session).slice(0, -'.json'.length)}.${ext}`;

/** Hook processes set `from` (their start): both lock waits together then end by `from + ms`, well inside the 10 s hook timeout. */
export const WAIT_CAP: { from?: number; ms: number } = { ms: 7000 };
const capped = (deadline: number): number => (WAIT_CAP.from === undefined ? deadline : Math.min(deadline, WAIT_CAP.from + WAIT_CAP.ms));
export const WRITE_WAIT = { ms: 1000 }; // the write lock is held for milliseconds: a bounded synchronous spin (tests shorten it)
export class StateBusyError extends Error {
  constructor() {
    super('session state write lock busy');
  }
}
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Read, change and write a session's state under `<session>.wlock`, which every state writer takes (Stop and hooks
 * past the session-lock wait included), so no two read-merge-writes overlap. Throws StateBusyError past WRITE_WAIT.
 */
export function updateState(root: string, session: string, change: (cur: SessionState) => SessionState, ops: LockOps = REAL_OPS): SessionState {
  const lock = lockOf(root, session, 'wlock');
  const nonce = randomBytes(8).toString('hex');
  mkdirSync(join(root, '.harness/state'), { recursive: true });
  let got: 'held' | 'busy' | 'unusable';
  // A holder's reads and writes may retry transient Windows errors for up to RETRY_BUDGET_MS: the wait covers that too.
  const bound = WRITE_WAIT.ms + (RETRY.platform === 'win32' ? RETRY_BUDGET_MS : 0);
  for (const deadline = capped(Date.now() + bound); (got = tryTake(lock, nonce, ops)) === 'busy'; pause(1 + Math.random() * 3)) { // jittered, so no waiter starves
    if (Date.now() < deadline) continue;
    // The update is lost: say so on stderr and in the event log, never silently.
    process.stderr.write('harness: state write lock timeout, an update was not saved\n');
    appendEventSafe(root, { ts: new Date().toISOString(), session, check: 'state-lock', decision: 'state-write-lost' });
    throw new StateBusyError();
  }
  // Claim a pending turn reset (renamed, so one made meanwhile waits for the next write); put it back if the write fails.
  const marker = resetMarker(root, session), claimed = `${marker}.${nonce}`;
  let reset = false;
  try {
    try {
      renameSync(marker, claimed);
      reset = true;
    } catch {
      // none pending
    }
    const cur = readFile(root, session, readFileSync);
    const next = change(reset ? turnReset(cur) : cur);
    writeState(root, session, next);
    if (reset) {
      reset = false; // applied: whatever happens to the claimed file now, it is never put back
      try {
        ops.rm(claimed, { force: true });
      } catch {
        // a scanner holds it: a leftover .reset.<nonce> file is never read
      }
    }
    return next;
  } catch (e) {
    try {
      if (reset) renameSync(claimed, marker);
    } catch {
      // a newer marker took the name: it resets the turn as well
    }
    throw e;
  } finally {
    if (got === 'held') release(lock, nonce, ops);
  }
}

// Serialises a whole hook per session via the same kind of lock dir (`<session>.lock`). Waits up to LOCK_WAIT (10 ms
// steps), then warns and runs onTimeout (a gate's fail-closed answer) or, without one, fn unlocked. Unlocked, a hook's
// writes still take the write lock and merge onto the state on disk, so they don't overwrite another hook's update; a
// write that can't get even the write lock is lost, and the dispatcher logs that. Stop events skip this lock
// (long-running; they write only the attempt counters and the decision, tool-missing and notice fields, merged too).
export async function withSessionLock<T>(root: string, session: string, fn: () => T | Promise<T>, ops: LockOps = REAL_OPS, onTimeout?: () => T | Promise<T>): Promise<T> {
  const lock = lockOf(root, session, 'lock');
  const nonce = randomBytes(8).toString('hex');
  let got: 'held' | 'busy' | 'unusable' = 'unusable';
  try {
    try {
      mkdirSync(join(root, '.harness/state'), { recursive: true });
      for (const deadline = capped(Date.now() + LOCK_WAIT.ms); (got = tryTake(lock, nonce, ops)) === 'busy' && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 10));
    } catch {
      got = 'unusable'; // unwritable state dir: run unlocked, the dispatcher's own write warnings cover it
    }
    if (got === 'busy') {
      process.stderr.write('harness: state lock timeout\n');
      if (onTimeout) return await onTimeout();
    }
    return await fn();
  } finally {
    if (got === 'held') release(lock, nonce, ops);
  }
}
