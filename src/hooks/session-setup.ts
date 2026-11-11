import { spawnSync } from 'node:child_process';
import { type HarnessConfig, loadConfig } from '../core/config.js';
import { writeHookEnv } from '../core/hook-env.js';
import { bindPause, clearPause } from '../core/pause.js';
import { type SessionState, readState, stateExists, writeState } from '../core/state.js';
import { repoRoot } from '../core/repo-root.js';
import { isUnattended } from '../core/unattended.js';
import { warn } from './event-log.js';
import type { HookEvent, HookInput } from './types.js';
import { SAFE_GIT } from '../core/git-safe.js';

const NO_ROOT = '/nonexistent-harness-root'; // loadConfig/readState on it yield defaults and a fresh state without touching disk
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const GIT_TIMEOUT_MS = 2000;

type GitRun = (args: string[]) => { status: number | null; stdout: string };

// HEAD at the session's first hook. The empty tree stands in only when the repo has no commits at all; any other failure leaves it undefined.
export function detectBaseHead(root: string, run: GitRun = (args) => spawnSync('git', [...SAFE_GIT, ...args], { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })): string | undefined {
  const head = run(['rev-parse', 'HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  const any = run(['rev-list', '-n', '1', '--all']);
  return any.status === 0 && !any.stdout.trim() ? EMPTY_TREE : undefined;
}

export interface Session {
  root: string;
  config: HarnessConfig | undefined;
  state: SessionState | undefined;
  unattended: boolean;
  configErrors: string[];
  fallback: boolean; // setup failed: the state in hand is not the session's, so it must never be written back
  degraded: boolean; // no config or state: only failClosed checks run
}

function loadSession(input: HookInput, event: HookEvent, env: NodeJS.ProcessEnv): Omit<Session, 'degraded'> {
  const s: Omit<Session, 'degraded'> = { root: input.cwd, config: undefined, state: undefined, unattended: false, configErrors: [], fallback: false };
  try {
    s.root = repoRoot(input.cwd);
    const loaded = loadConfig(s.root);
    s.config = loaded.config;
    s.configErrors = loaded.errors;
    if (event === 'UserPromptSubmit') for (const w of loaded.warnings) process.stderr.write(`harness: ${w}\n`);
    s.state = readState(s.root, input.session_id);
    s.unattended = isUnattended(input, env);
  } catch (e) {
    warn('setup', e);
    s.fallback = true;
    s.root = input.cwd;
    try {
      s.unattended = isUnattended(input, env); // first: a later throw must not leave an unattended run judged attended
      s.config = loadConfig(NO_ROOT).config;
      s.state = readState(NO_ROOT, input.session_id);
    } catch (e2) {
      warn('fallback setup', e2);
      s.config = undefined; // degraded: only failClosed checks run
    }
  }
  return s;
}

/** Loads the config and session state (or a fallback), then does the per-hook bookkeeping that runs before any check. */
export function setupSession(input: HookInput, event: HookEvent, env: NodeJS.ProcessEnv): Session {
  const s = loadSession(input, event, env);
  const { root, config, state, fallback } = s;
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
  return { ...s, degraded };
}
