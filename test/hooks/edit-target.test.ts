import { expect, test } from 'vitest';
import { editTarget } from '../../src/hooks/edit-target.js';
import type { HookInput } from '../../src/hooks/types.js';

const inp = (tool_name: string, tool_input: Record<string, unknown>): HookInput => ({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r', tool_name, tool_input });

test('Edit, Write and MultiEdit read file_path', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit']) expect(editTarget(inp(t, { file_path: '/r/a.ts' }))).toBe('/r/a.ts');
});
test('NotebookEdit reads notebook_path', () => {
  expect(editTarget(inp('NotebookEdit', { notebook_path: '/r/n.ipynb', file_path: '/r/x' }))).toBe('/r/n.ipynb');
});
test('other tools and empty paths give null', () => {
  expect(editTarget(inp('Bash', { command: 'ls', file_path: '/r/a.ts' }))).toBeNull();
  expect(editTarget(inp('Edit', {}))).toBeNull();
  expect(editTarget(inp('Edit', { file_path: '' }))).toBeNull();
  expect(editTarget({ hook_event_name: 'PreToolUse', session_id: 's', cwd: '/r' })).toBeNull();
});
