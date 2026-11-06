import type { HarnessConfig } from '../core/config.js';
import type { SessionState } from '../core/state.js';
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
