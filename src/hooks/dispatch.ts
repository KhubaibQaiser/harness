import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { configChange } from '../checks/config-change.js';
import { decisionSignals } from '../checks/decisions-stop.js';
import { guard } from '../checks/guard.js';
import { prSize } from '../checks/pr-size/check.js';
import { prSizeEntry } from '../checks/pr-size/entry.js';
import { prBody } from '../checks/pr-body.js';
import { secretScan } from '../checks/secret-scan.js';
import { mcpWrites } from '../checks/mcp-writes.js';
import { workdir } from '../cli/guide.js';
import { multiFile } from '../checks/multi-file.js';
import { protect } from '../checks/protect.js';
import { taskGate } from '../checks/task-gate.js';
import { stateCardCheck } from '../checks/state-card.js';
import { sandboxRequired } from '../checks/sandbox-required.js';
import { redFirst } from '../checks/tdd/red-first.js';
import { tamper } from '../checks/tdd/tamper.js';
import { specGate } from '../checks/tdd/spec-gate.js';
import { stopGate } from '../checks/stop/gate.js';
import { testLock } from '../checks/tdd/test-lock.js';
import { type SessionState, isSafeSessionId, withSessionLock, writeState } from '../core/state.js';
import { repoRoot } from '../core/repo-root.js';
import { appendTiming, type TimingLine } from '../core/timing.js';
import { managedSettingsPath, repoEnvSets } from '../core/settings-layers.js';
import { detectHarnessFileChanges, seedBaselines } from './change-detection.js';
import type { Check, Ctx } from './check.js';
import { configInvalidGate } from './config-gate.js';
import { eventLog, warn } from './event-log.js';
import { capMessage, emit, MAX_CONTEXT, parseInput } from './io.js';
import { mergeContext, winner } from './notice.js';
import { runAfterAllow, runChecks } from './run-checks.js';
import { setupSession } from './session-setup.js';
import type { HookEvent } from './types.js';

export type { Check, Ctx } from './check.js';
export { configInvalidWhy } from './config-gate.js';
export { detectBaseHead } from './session-setup.js';

// multiFile runs after every other PreToolUse check, so an edit another check denies is never recorded as touched.
export const registry: Check[] = [guard, prSize, protect, taskGate, sandboxRequired, redFirst, tamper, testLock, specGate, prBody, secretScan, mcpWrites, multiFile, decisionSignals, configChange, stopGate, stateCardCheck];

const PROCESS_START = Date.now();
const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'ConfigChange'];
const CURSOR_KEYS = ['conversation_id', 'generation_id', 'model_id', 'workspace_roots'];

export type DispatchOpts = { home?: string; platform?: NodeJS.Platform; managed?: string; timing?: typeof appendTiming };

/** The decision kind a hook's output carries; empty output is an allow. */
function outcomeOf(out: string): TimingLine['outcome'] {
  if (!out) return 'allow';
  const o = JSON.parse(out) as { decision?: string; hookSpecificOutput?: { permissionDecision?: string } };
  const d = o.decision ?? o.hookSpecificOutput?.permissionDecision;
  return d === 'block' || d === 'deny' || d === 'ask' ? d : 'context';
}

export async function dispatch(raw: string, checks: Check[], env: NodeJS.ProcessEnv, opts: DispatchOpts = {}): Promise<string> {
  const input = parseInput(raw);
  if (!input || !EVENTS.includes(input.hook_event_name) || !isSafeSessionId(input.session_id)) return '';
  if (!input.cwd || input.hook_event_name === 'Stop') return dispatchLocked(raw, checks, env, opts);
  // One hook at a time per session, so parallel tool calls cannot race on the state file.
  return withSessionLock(repoRoot(input.cwd), input.session_id, () => dispatchLocked(raw, checks, env, opts));
}

async function dispatchLocked(raw: string, checks: Check[], env: NodeJS.ProcessEnv, opts: DispatchOpts): Promise<string> {
  const input = parseInput(raw);
  if (!input) return '';
  const rec = input as unknown as Record<string, unknown>;
  if (CURSOR_KEYS.some((k) => k in rec) || input.tool_name === 'Shell') return '';

  const event = input.hook_event_name as HookEvent;
  const { root, config, state, unattended, configErrors, fallback, degraded } = setupSession(input, event, env);
  const platform = opts.platform ?? process.platform;
  // Claude Code ignores CLAUDE_CONFIG_DIR in a repo's settings env, so the repo can't name the mirror either: only the
  // launcher's counts. Read only when the mirror is set, so other hooks pay nothing.
  const hookEnv = env.HARNESS_CLAUDE_CONFIG_DIR && repoEnvSets(root, 'HARNESS_CLAUDE_CONFIG_DIR') ? { ...env, HARNESS_CLAUDE_CONFIG_DIR: undefined } : env;
  const ctx = {
    input, root, config, state, unattended, env: hookEnv, configErrors, startedAt: PROCESS_START,
    home: opts.home ?? homedir(), platform, managed: opts.managed ?? managedSettingsPath(platform),
    save(s: SessionState) {
      if (!fallback) writeState(root, input.session_id, s);
      ctx.state = s;
    },
  } as Ctx;
  const log = eventLog(root, input.session_id, input.tool_use_id, PROCESS_START);
  // Every return records one timing line; a failed write never changes the decision.
  const done = (out: string): string => {
    try {
      (opts.timing ?? appendTiming)(root, { ts: new Date().toISOString(), session: input.session_id, event, ...(input.tool_name ? { tool: input.tool_name } : {}), outcome: outcomeOf(out), ms: Date.now() - PROCESS_START });
    } catch (e) {
      warn('timing log', e);
    }
    return out;
  };

  let notice = '';
  let pending = ''; // a blocked ConfigChange, shown at this prompt with the change-detection notice
  if (state && !fallback) {
    pending = seedBaselines(ctx, event, checks);
    const found = detectHarnessFileChanges(ctx, event, log);
    if (found.out !== undefined) return done(found.out);
    notice = found.notice;
  }

  if (configErrors.length && !degraded) {
    const out = configInvalidGate(ctx, event, configErrors, log);
    if (out !== undefined) return done(out);
  }

  const decisions = await runChecks(ctx, checks, degraded, log);
  if (event === 'PreToolUse' && !decisions.some((d) => d.kind === 'deny' || d.kind === 'ask')) runAfterAllow(ctx, checks, degraded);

  const out = mergeContext(event, decisions, winner(decisions));
  const all = [pending, notice].filter(Boolean).join('\n');
  return done(all ? withNotice(event, out, all) : out);
}

/** Adds a notice the person sees (systemMessage) and the model gets (additionalContext) to a hook's JSON output. */
function withNotice(event: string, out: string, notice: string): string {
  const o = out ? JSON.parse(out) : {};
  o.systemMessage = capMessage([o.systemMessage, notice].filter(Boolean).join('\n'));
  const extra = o.hookSpecificOutput?.additionalContext;
  o.hookSpecificOutput = { ...o.hookSpecificOutput, hookEventName: event, additionalContext: capMessage([extra, notice].filter(Boolean).join('\n'), MAX_CONTEXT) };
  return JSON.stringify(o);
}

/** Runs one hook. A failure denies a PreToolUse call (exit 0) and exits 1 for any other event, so a broken dispatcher never reads as an allow. */
export async function runHook(raw: string, run: (raw: string) => Promise<string>): Promise<{ out: string; code: 0 | 1 }> {
  let message: string;
  try {
    if (!parseInput(raw)) throw new Error('unreadable hook input');
    return { out: await run(raw), code: 0 };
  } catch (e) {
    message = String((e as Error)?.message ?? e);
  }
  process.stderr.write(`harness: dispatcher failed: ${message}\n`);
  let event: unknown;
  try {
    event = (JSON.parse(raw) as { hook_event_name?: unknown } | null)?.hook_event_name;
  } catch {
    // unparseable: no event to name
  }
  return event === 'PreToolUse'
    ? { out: emit('PreToolUse', { kind: 'deny', reason: `harness dispatcher failed: ${message}`, check: 'dispatcher' }), code: 0 }
    : { out: '', code: 1 };
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    process.stdout.write(`ok ${process.version}\n`);
    return;
  }
  if (process.argv.includes('--pr-size') || process.argv.includes('--pr-size-raise')) {
    process.exitCode = prSizeEntry(process.argv.slice(2), process.cwd(), (l) => process.stdout.write(l + '\n'));
    return;
  }
  // The skills' work folder, for installed skills that have no `harness` binary on PATH (same code and refusals as `harness workdir`).
  const wd = process.argv.indexOf('--workdir');
  if (wd >= 0) {
    process.exitCode = workdir(process.argv.slice(wd + 1), { root: repoRoot(process.cwd()), env: process.env, out: (l) => process.stdout.write(l + '\n') });
    return;
  }
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    // no readable stdin: runHook exits 1 on the empty input
  }
  const { out, code } = await runHook(raw, (r) => dispatch(r, registry, process.env));
  if (out) process.stdout.write(out);
  process.exitCode = code;
}

// Run only as the process entry (also true for the bundled dist file), so tests can import `dispatch`.
const entry = process.argv[1];
try {
  if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) void main();
} catch {
  process.exitCode = 1; // unresolvable entry path
}
