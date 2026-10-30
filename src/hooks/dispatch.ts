import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type HarnessConfig, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { type SessionState, isSafeSessionId, readState, writeState } from '../core/state.js';
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
export const registry: Check[] = [];

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'ConfigChange'];
const CURSOR_KEYS = ['conversation_id', 'generation_id', 'model_id', 'workspace_roots'];
const rootCache = new Map<string, string>();
const warned = new Set<string>();

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
  const rec = input as unknown as Record<string, unknown>;
  if (CURSOR_KEYS.some((k) => k in rec) || input.tool_name === 'Shell') return '';

  const event = input.hook_event_name as HookEvent;
  const root = repoRoot(input.cwd);
  const { config, warnings } = loadConfig(root);
  if (!warned.has(root)) {
    warned.add(root);
    for (const w of warnings) process.stderr.write(`harness: ${w}\n`);
  }
  const state = readState(root, input.session_id);
  // Fix startedAt at the session's first hook.
  if (!existsSync(join(root, '.harness/state', `${input.session_id}.json`))) writeState(root, input.session_id, state);

  const unattended = isUnattended(input, env);
  const ctx: Ctx = {
    input, root, config, state, unattended, env,
    save(s) {
      writeState(root, input.session_id, s);
      ctx.state = s;
    },
  };
  const log = (check: string, decision: string, reason?: string) =>
    appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check, decision, ...(reason ? { reason } : {}) });

  const decisions: Decision[] = [];
  for (const c of checks.filter((c) => c.events.includes(event))) {
    let d: Decision;
    try {
      d = await c.run(ctx);
    } catch (e) {
      const msg = (e as Error).message;
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
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) void main();
