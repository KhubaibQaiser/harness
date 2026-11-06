import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configChange } from '../checks/config-change.js';
import { guard } from '../checks/guard.js';
import { prSize } from '../checks/pr-size/check.js';
import { prSizeEntry } from '../checks/pr-size/entry.js';
import { multiFile } from '../checks/multi-file.js';
import { protect, shellWriteTargets } from '../checks/protect.js';
import { sandboxRequired } from '../checks/sandbox-required.js';
import { redFirst } from '../checks/tdd/red-first.js';
import { tamper } from '../checks/tdd/tamper.js';
import { specGate } from '../checks/tdd/spec-gate.js';
import { stopGate } from '../checks/stop/gate.js';
import { testLock } from '../checks/tdd/test-lock.js';
import { type HarnessConfig, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { writeHookEnv } from '../core/hook-env.js';
import { bindPause, clearPause } from '../core/pause.js';
import { type SessionState, isSafeSessionId, readState, stateExists, withSessionLock, writeState } from '../core/state.js';
import { repoRoot } from '../core/repo-root.js';
import { changedFiles, gitHead, guardedViews, readRepoSnapshot, recordLastSeen, snapshotHarnessFiles, type Snapshot } from '../core/harness-files.js';
import { managedSettingsPath } from '../core/settings-layers.js';
import { isUnattended } from '../core/unattended.js';
import { toRepoPath } from '../core/paths.js';
import { editTarget, isShell } from './edit-target.js';
import { capMessage, emit, parseInput } from './io.js';
import { mergeContext } from './notice.js';
import type { Decision, HookEvent, HookInput } from './types.js';

export interface Ctx {
  input: HookInput;
  root: string;
  config: HarnessConfig;
  state: SessionState;
  unattended: boolean;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  managed: string; // managed-settings.json path; tests point it away from the real system file
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
export const registry: Check[] = [guard, prSize, protect, sandboxRequired, redFirst, tamper, testLock, specGate, multiFile, configChange, stopGate];

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

export type DispatchOpts = { home?: string; platform?: NodeJS.Platform; managed?: string };

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
      unattended = isUnattended(input, env); // first: a later throw must not leave an unattended run judged attended
      config = loadConfig(NO_ROOT).config;
      state = readState(NO_ROOT, input.session_id);
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

  if (event === 'UserPromptSubmit' && !fallback) {
    try {
      writeHookEnv(root);
    } catch (e) {
      warn('hook env', e);
    }
  }

  const platform = opts.platform ?? process.platform;
  const ctx = {
    input, root, config, state, unattended, env, startedAt: PROCESS_START,
    home: opts.home ?? homedir(), platform, managed: opts.managed ?? managedSettingsPath(platform),
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

  // Change detection, the backstop behind the path checks: a session's baseline is the repo's last-seen snapshot (or,
  // on a fresh clone, the files at its first hook). A change shows at the next prompt (a notice, once) and blocks the
  // next Stop once (the snapshot is then renewed, and the block counts within stop.max_attempts). Each Stop and
  // SessionEnd records what the session has accounted for as the next session's baseline, so a change between
  // sessions is reported too. Changes the harness CLI made match its own record and don't count.
  let notice = '';
  let pending = ''; // a blocked ConfigChange, shown at this prompt with the change-detection notice
  if (state && !fallback) {
    try {
      // ConfigChange's and sandbox-required's baseline (plan ruling 4): once per session, before any check runs, and
      // only when a check will compare against it.
      if (!ctx.state.guardedBase && event !== 'ConfigChange' && checks.some((c) => c.events.includes('ConfigChange') || c.name === 'sandbox-required')) ctx.save({ ...ctx.state, guardedBase: guardedViews(root, ctx.home, env), guardedCli: readRepoSnapshot(root).cli?.id });
      if (event === 'UserPromptSubmit' && ctx.state.pendingNotice) {
        pending = ctx.state.pendingNotice;
        ctx.save({ ...ctx.state, pendingNotice: undefined });
      }
    } catch (e) {
      warn('config-change baseline', e);
    }
    try {
      if (!ctx.state.harnessFiles) {
        const seen = readRepoSnapshot(root).lastSeen;
        ctx.save({ ...ctx.state, harnessFiles: seen?.files ?? snapshotHarnessFiles(root), harnessHead: seen ? seen.head : ctx.state.baseHead });
      }
      if (event === 'Stop' || event === 'UserPromptSubmit' || event === 'SessionEnd') {
        const prev = ctx.state.harnessFiles!;
        const cur = snapshotHarnessFiles(root);
        // A change shown at a prompt that is no longer as shown (undone, or changed again) before the Stop that would
        // account for it: report that at this Stop, once. At SessionEnd, an undone change makes the shown state the
        // next session's baseline, so the next session reports the undoing.
        const noticed: [string, string | null][] | null = ctx.state.harnessNoticed ? JSON.parse(ctx.state.harnessNoticed) : null;
        const gone = !!noticed && noticed.some(([f, h]) => (cur[f] ?? null) !== h);
        const shown: Snapshot = { ...prev };
        for (const [f, h] of noticed ?? []) if (h === null) delete shown[f]; else shown[f] = h;
        if (gone && event === 'Stop') {
          const changed = [...new Set([...noticed!.map(([f]) => f), ...changedFiles(shown, cur)])].sort();
          log('harness-files', 'harness-files-changed', changed.join(', '));
          const head = gitHead(root);
          const why = `The change to ${noticed!.map(([f]) => `\`${f}\``).join(', ')} shown at the last prompt is no longer there: something changed these files again before this Stop, possibly undoing the person's edit. ${filesChangedWhy(changed, ctx.state.harnessHead, head)}`;
          const attempts = ctx.state.stopAttempts + 1;
          const over = attempts > (config?.stop.max_attempts ?? 3);
          ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: over ? 0 : attempts });
          recordLastSeen(root, cur, head);
          if (over) log('harness-files', 'stop-gave-up', why);
          else return emit(event, { kind: 'block', reason: why, check: 'harness-files' });
        }
        const files = event === 'SessionEnd' && gone ? [] : changedFiles(ctx.state.harnessFiles!, cur);
        const cli = files.length ? readRepoSnapshot(root).cli : undefined;
        if (files.length && cli && !changedFiles(cli.files, cur).length) ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: gitHead(root), harnessNoticed: undefined });
        else if (files.length && event !== 'SessionEnd') {
          const key = JSON.stringify(files.map((f) => [f, cur[f] ?? null]));
          if (ctx.state.harnessNoticed !== key) log('harness-files', 'harness-files-changed', files.join(', '));
          const head = gitHead(root);
          const why = filesChangedWhy(files, ctx.state.harnessHead, head);
          const attempts = ctx.state.stopAttempts + 1;
          if (event === 'UserPromptSubmit') {
            if (ctx.state.harnessNoticed !== key) notice = why;
            ctx.save({ ...ctx.state, harnessNoticed: key });
          } else if (attempts > (config?.stop.max_attempts ?? 3)) {
            ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: 0 });
            log('harness-files', 'stop-gave-up', why);
          } else {
            ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: attempts });
            recordLastSeen(root, cur, head);
            return emit(event, { kind: 'block', reason: why, check: 'harness-files' });
          }
        }
        // What this session has accounted for (not an unreported change) is where the next session starts.
        // At SessionEnd the shown state becomes the next baseline only when the shown change was undone or changed again
        // (so the next session reports that); a change still there keeps the old baseline, so the next Stop blocks it.
        if (event === 'Stop' || event === 'SessionEnd') recordLastSeen(root, event === 'SessionEnd' && gone ? shown : ctx.state.harnessFiles!, ctx.state.harnessHead);
      }
    } catch (e) {
      warn('harness-files', e);
    }
  }

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
    // Shell writes and deletes count as edits; a target outside the repo, or the config itself, does not.
    const shell = event === 'PreToolUse' && isShell(input.tool_name) ? shellWriteTargets(String(input.tool_input?.command ?? '')) : [];
    const inRepo = (p: string) => { const rel = toRepoPath(root, p); return rel !== null ? rel.toLowerCase() !== CONFIG : resolve(root, p) === resolve(root); };
    if ((t !== null && toRepoPath(root, t)?.toLowerCase() !== CONFIG) || shell.some(inRepo)) {
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
  const out = mergeContext(event, decisions, win);
  const all = [pending, notice].filter(Boolean).join('\n');
  return all ? withNotice(event, out, all) : out;
}

function filesChangedWhy(files: string[], startHead: string | undefined, head: string | undefined): string {
  const list = files.map((f) => `\`${f}\``).join(', ');
  const short = (h: string) => h.slice(0, 12);
  const review = startHead
    ? `\`git diff ${short(startHead)} -- .harness .claude/settings.json\` (everything since the session started), and \`git diff -- .harness .claude/settings.json\` for what is not committed`
    : '`git diff -- .harness .claude/settings.json`';
  const moved = startHead && head && head !== startHead ? ` HEAD moved since the session started (${short(startHead)} -> ${short(head)}): a branch switch, a pull or a commit can explain the change.` : '';
  return `Harness files changed since harness last checked them: ${list}. Tell the person now and ask them to review the change with ${review} (any command or script can change these files, not only an edit).${moved} Harness says this once per change.`;
}
/** Adds a notice the person sees (systemMessage) and the model gets (additionalContext) to a hook's JSON output. */
function withNotice(event: string, out: string, notice: string): string {
  const o = out ? JSON.parse(out) : {};
  o.systemMessage = capMessage([o.systemMessage, notice].filter(Boolean).join('\n'));
  const extra = o.hookSpecificOutput?.additionalContext;
  o.hookSpecificOutput = { ...o.hookSpecificOutput, hookEventName: event, additionalContext: [extra, notice].filter(Boolean).join('\n') };
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
  if (process.argv.includes('--pr-size')) {
    process.exitCode = prSizeEntry(process.argv.slice(2), process.cwd(), (l) => process.stdout.write(l + '\n'));
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
