export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SessionStart'
  | 'SessionEnd'
  | 'ConfigChange';

export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  permission_mode?: string;
  transcript_path?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  file_path?: string;
  last_assistant_message?: string;
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny' | 'ask'; reason: string; check: string; log?: string } // log: the event text when reason holds what must not be logged
  | { kind: 'block'; reason: string; check: string }
  | { kind: 'context'; text: string; check: string; notice?: string };
