import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { guard } from '../checks/guard.js';
import { multiFile } from '../checks/multi-file.js';
import { protect } from '../checks/protect.js';
import { redFirst } from '../checks/tdd/red-first.js';
import { tamper } from '../checks/tdd/tamper.js';
import { specGate } from '../checks/tdd/spec-gate.js';
import { stopGate } from '../checks/stop/gate.js';
import { testLock } from '../checks/tdd/test-lock.js';
import { type HarnessConfig, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { bindPause, clearPause } from '../core/pause.js';
import { type SessionState, isSafeSessionId, readState, stateExists, withSessionLock, writeState } from '../core/state.js';
import { repoRoot } from '../core/repo-root.js';
import { isUnattended } from '../core/unattended.js';
import { toRepoPath } from '../core/paths.js';
import { editTarget } from './edit-target.js';
import { emit, parseInput } from './io.js';
import type { Decision, HookEvent, HookInput } from './types.js';

export interface Ctx {
  input: HookInput;
  root: string;
  config: HarnessConfig;
  state: SessionState;
  unattended: boolean;
  env: NodeJS.ProcessEnv;
  startedAt: number; // process start, for the hook time budget
  save(s: SessionState): void;
}

export interface Check {
  name: string;
  events: HookEvent[];
  failClosed?: boolean;
  pure?: boolean; // never calls ctx.save or writes files other than the event log
  run(ctx: Ctx): Decision | Promise<Decision>;
  afterAllow?(ctx: Ctx): void; // PreToolUse only: called when the final outcome is a plain allow (no deny or ask from any check)
}

// multiFile runs after every other PreToolUse check, so an edit another check denies is never recorded as touched.
export const registry: Check[] = [guard, protect, redFirst, tamper, testLock, specGate, multiFile, stopGate];

const PROCESS_START = Date.now();
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'ConfigChange'];
const CURSOR_KEYS = ['conversation_id', 'generation_id', 'model_id', 'workspace_roots'];
const NO_ROOT = '/nonexistent-harness-root'; // loadConfig/readState on it yield defaults and a fresh state without touching disk
const CONFIG = '.harness/config.yaml';
export const configInvalidWhy = (errors: string[]): string =>
  `\`${CONFIG}\` is invalid: ${errors.join('; ')}. Harness blocks edits and stopping until a person fixes it, so no gate is off by mistake: ask the user to correct ${CONFIG} (harness doctor checks it).`;
const warn = (what: string, e: unknown) => process.stderr.write(`harness: ${what} failed: ${String((e as Error)?.message ?? e)}\n`);

type GitRun = (args: string[]) => { status: number | null; stdout: string };

// HEAD at the session's first hook. The empty tree stands in only when the repo has no commits at all; any other failure leaves it undefined.
export function detectBaseHead(root: string, run: GitRun = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2000 })): string | undefined {
  const head = run(['rev-parse', 'HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  const any = run(['rev-list', '-n', '1', '--all']);
  return any.status === 0 && !any.stdout.trim() ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : undefined;
}

export async function dispatch(raw: string, checks: Check[], env: NodeJS.ProcessEnv): Promise<string> {
  const input = parseInput(raw);
  if (!input || !EVENTS.includes(input.hook_event_name) || !isSafeSessionId(input.session_id)) return '';
  if (!input.cwd || input.hook_event_name === 'Stop') return dispatchLocked(raw, checks, env);
  // One hook at a time per session, so parallel tool calls cannot race on the state file.
  return withSessionLock(repoRoot(input.cwd), input.session_id, () => dispatchLocked(raw, checks, env));
}

async function dispatchLocked(raw: string, checks: Check[], env: NodeJS.ProcessEnv): Promise<string> {
  const input = parseInput(raw);
  if (!input) return '';
  const rec = input as unknown as Record<string, unknown>;
  if (CURSOR_KEYS.some((k) => k in rec) || input.tool_name === 'Shell') return '';

  const event = input.hook_event_name as HookEvent;
  let root = input.cwd;
  let config: HarnessConfig | undefined;
  let state: SessionState | undefined;
  let unattended = false;
  let configErrors: string[] = [];
  let fallback = false; // setup failed: the state in hand is not the session's, so it must never be written back
  try {
    root = repoRoot(input.cwd);
    const loaded = loadConfig(root);
    config = loaded.config;
    configErrors = loaded.errors;
    if (event === 'UserPromptSubmit') for (const w of loaded.warnings) process.stderr.write(`harness: ${w}\n`);
    state = readState(root, input.session_id);
    unattended = isUnattended(input, env);
  } catch (e) {
    warn('setup', e);
    fallback = true;
    root = input.cwd;
    try {
      config = loadConfig(NO_ROOT).config;
      state = readState(NO_ROOT, input.session_id);
      unattended = isUnattended(input, env);
    } catch (e2) {
      warn('fallback setup', e2);
      config = undefined; // degraded: only failClosed checks run
    }
  }
  const degraded = !config || !state;
  if (state) {
    // Fix startedAt at the session's first hook.
    try {
      if (!fallback && !stateExists(root, input.session_id)) {
        state.baseHead = detectBaseHead(root);
        writeState(root, input.session_id, state);
      }
    } catch (e) {
      warn('state write', e);
    }
  }

  try {
    if (event === 'SessionEnd') clearPause(root, input.session_id);
    else if (state && config) bindPause(root, input.session_id, state.startedAt);
  } catch (e) {
    warn('tdd pause', e);
  }

  const ctx = {
    input, root, config, state, unattended, env, startedAt: PROCESS_START,
    save(s: SessionState) {
      if (!fallback) writeState(root, input.session_id, s);
      ctx.state = s;
    },
  } as Ctx;
  const log = (check: string, decision: string, reason?: string, co?: true) => {
    try {
      appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check, decision, ...(reason ? { reason } : {}), ...(co ? { co } : {}) });
    } catch (e) {
      warn('event log', e);
    }
  };

  // An invalid config never turns a gate off silently: edits (except to the config itself, which the usual checks
  // still judge) and Stop fail closed. Stop shares the Stop gate's attempt counter, so the session can still end.
  if (configErrors.length && !degraded) {
    const reason = configInvalidWhy(configErrors);
    if (event === 'Stop') {
      const attempts = ctx.state.stopAttempts + 1;
      if (attempts > config!.stop.max_attempts) {
        ctx.save({ ...ctx.state, stopAttempts: 0 });
        log('config', 'stop-gave-up', reason);
        return '';
      }
      ctx.save({ ...ctx.state, stopAttempts: attempts });
      log('config', 'block', reason);
      return emit(event, { kind: 'block', reason, check: 'config' });
    }
    const t = event === 'PreToolUse' ? editTarget(input) : null;
    if (t !== null && toRepoPath(root, t)?.toLowerCase() !== CONFIG) {
      log('config', 'deny', reason);
      return emit(event, { kind: 'deny', reason, check: 'config' });
    }
  }

  const decisions: Decision[] = [];
  let denied = false; // after the first PreToolUse deny only pure checks run; their findings are logged, not returned
  for (const c of checks.filter((c) => c.events.includes(event) && (!degraded || c.failClosed))) {
    if (denied && !c.pure) continue;
    let d: Decision;
    try {
      const r = await c.run(ctx);
      if (!r || typeof r !== 'object' || typeof r.kind !== 'string') throw new Error('invalid check result');
      d = r;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!c.failClosed) {
        process.stderr.write(`harness: check ${c.name} failed: ${msg}\n`);
        continue;
      }
      d = { kind: 'deny', reason: `harness check ${c.name} failed: ${msg}`, check: c.name };
    }
    if (d.kind === 'allow') continue;
    if (d.kind === 'ask') {
      if (event === 'Stop') d = { kind: 'block', reason: d.reason, check: d.check };
      else if (event !== 'PreToolUse') {
        log(d.check, 'ask-ignored', d.reason);
        continue;
      } else if (unattended) d = { kind: 'deny', reason: `Unattended run: ${d.reason}`, check: d.check };
    }
    log(d.check, d.kind, d.kind === 'context' ? d.text : d.reason, denied ? true : undefined);
    if (!denied) decisions.push(d);
    if (event === 'PreToolUse' && d.kind === 'deny') denied = true;
  }

  if (event === 'PreToolUse' && !decisions.some((d) => d.kind === 'deny' || d.kind === 'ask')) {
    for (const c of checks) {
      if (!c.afterAllow || !c.events.includes(event) || (degraded && !c.failClosed)) continue;
      try {
        c.afterAllow(ctx);
      } catch (e) {
        warn(`check ${c.name} afterAllow`, e);
      }
    }
  }

  const win =
    decisions.find((d) => d.kind === 'deny' || d.kind === 'block') ?? decisions.find((d) => d.kind === 'ask');
  if (win) return emit(event, win);
  const ctxs = decisions.flatMap((d) => (d.kind === 'context' ? [d.text] : []));
  return ctxs.length ? emit(event, { kind: 'context', text: ctxs.join('\n'), check: 'context' }) : '';
}

async function main(): Promise<void> {
  let out = '';
  try {
    out = await dispatch(readFileSync(0, 'utf8'), registry, process.env);
  } catch (e) {
    process.stderr.write(`harness: dispatcher failed: ${(e as Error).message}\n`);
  }
  if (out) process.stdout.write(out);
  process.exitCode = 0;
}

// Run only as the process entry (also true for the bundled dist file), so tests can import `dispatch`.
const entry = process.argv[1];
try {
  if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) void main();
} catch {
  // unresolvable entry path: stay silent, exit 0
}
