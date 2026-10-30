import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { guard } from '../checks/guard.js';
import { multiFile } from '../checks/multi-file.js';
import { protect } from '../checks/protect.js';
import { type HarnessConfig, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { type SessionState, isSafeSessionId, readState, stateExists, withSessionLock, writeState } from '../core/state.js';
import { isUnattended } from '../core/unattended.js';
import { emit, parseInput } from './io.js';
import type { Decision, HookEvent, HookInput } from './types.js';

export interface Ctx {
  input: HookInput;
  root: string;
  config: HarnessConfig;
  state: SessionState;
  unattended: boolean;
  env: NodeJS.ProcessEnv;
  save(s: SessionState): void;
}

export interface Check {
  name: string;
  events: HookEvent[];
  failClosed?: boolean;
  run(ctx: Ctx): Decision | Promise<Decision>;
}

// Later tasks register here, in the order guard, protect, depVerify, multiFile, redFirst, tamper, testLock, specGate, stopGate.
export const registry: Check[] = [guard, protect, multiFile];

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'ConfigChange'];
const CURSOR_KEYS = ['conversation_id', 'generation_id', 'model_id', 'workspace_roots'];
const rootCache = new Map<string, string>();
const NO_ROOT = '/nonexistent-harness-root'; // loadConfig/readState on it yield defaults and a fresh state without touching disk
const warn = (what: string, e: unknown) => process.stderr.write(`harness: ${what} failed: ${String((e as Error)?.message ?? e)}\n`);

function repoRoot(cwd: string): string {
  let r = rootCache.get(cwd);
  if (r === undefined) {
    try {
      r = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
    } catch {
      r = cwd;
    }
    rootCache.set(cwd, r);
  }
  return r;
}

export async function dispatch(raw: string, checks: Check[], env: NodeJS.ProcessEnv): Promise<string> {
  const input = parseInput(raw);
  if (!input || !EVENTS.includes(input.hook_event_name) || !isSafeSessionId(input.session_id)) return '';
  if (!input.cwd) return dispatchLocked(raw, checks, env);
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
  try {
    root = repoRoot(input.cwd);
    const loaded = loadConfig(root);
    config = loaded.config;
    if (event === 'UserPromptSubmit') for (const w of loaded.warnings) process.stderr.write(`harness: ${w}\n`);
    state = readState(root, input.session_id);
    unattended = isUnattended(input, env);
  } catch (e) {
    warn('setup', e);
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
      if (!stateExists(root, input.session_id)) writeState(root, input.session_id, state);
    } catch (e) {
      warn('state write', e);
    }
  }

  const ctx = {
    input, root, config, state, unattended, env,
    save(s: SessionState) {
      writeState(root, input.session_id, s);
      ctx.state = s;
    },
  } as Ctx;
  const log = (check: string, decision: string, reason?: string) => {
    try {
      appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check, decision, ...(reason ? { reason } : {}) });
    } catch (e) {
      warn('event log', e);
    }
  };

  const decisions: Decision[] = [];
  for (const c of checks.filter((c) => c.events.includes(event) && (!degraded || c.failClosed))) {
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
    log(d.check, d.kind, d.kind === 'context' ? d.text : d.reason);
    decisions.push(d);
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
