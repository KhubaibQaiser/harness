import type { HookInput } from './types.js';

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Shell-running tools: their input is a command line in `tool_input.command`.
export const isShell = (tool: string | undefined): boolean => tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor';

// Path an edit-type tool call targets (notebook_path for NotebookEdit), or null for any other tool.
export function editTarget(input: HookInput): string | null {
  const { tool_name = '', tool_input = {} } = input;
  if (!EDITS.has(tool_name)) return null;
  const p = tool_input[tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path'];
  return typeof p === 'string' && p ? p : null;
}
