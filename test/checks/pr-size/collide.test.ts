// Two checks asking on one tool call: the dispatcher shows one dialog with every reason (final review I1).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { writeProgress } from '../../../src/checks/pr-size/progress.js';
import { commit, lines, repo } from './helpers.js';

type Out = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
async function hook(root: string, event: string, tool: Record<string, unknown>): Promise<Out> {
  vi.resetModules();
  const { dispatch, registry } = await import('../../../src/hooks/dispatch.js');
  const out = await dispatch(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: root, ...tool }), registry, {});
  return out ? (JSON.parse(out) as Out) : {};
}
const edit = (root: string, rel: string) => ({ tool_name: 'Edit', tool_input: { file_path: join(root, rel), old_string: 'a', new_string: 'b' }, tool_response: {} });

test('a pending pause and a second-file edit: one ask that names both, and approving it is informed', async () => {
  const root = repo();
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  multiFile: true\n');
  expect((await hook(root, 'PreToolUse', edit(root, 'src/f0.ts'))).hookSpecificOutput?.permissionDecision).toBeUndefined();
  writeProgress(root, 'feat', { base: 'origin/main', fired: ['target'], lines: 201, files: 1, ts: 't', pending: { lines: 201, files: 1 } });
  const o = (await hook(root, 'PreToolUse', edit(root, 'src/f1.ts'))).hookSpecificOutput!;
  expect(o.permissionDecision).toBe('ask');
  expect(o.permissionDecisionReason).toContain('Confirm: `feat` is now 201 changed lines in 1 file');
  expect(o.permissionDecisionReason).toContain('\nAlso: This change now spans more than one file. Touched: src/f0.ts. Next: src/f1.ts.');
});

test('a guard ask and a PR-size ask on one Bash command: one ask that names both', async () => {
  const root = repo();
  commit(root, { 'a.ts': lines(512) });
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  prBody: false\n'); // the body check would deny this bare create first
  const o = (await hook(root, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD~1 && gh pr create' } })).hookSpecificOutput!;
  expect(o.permissionDecision).toBe('ask');
  const [first, second] = o.permissionDecisionReason!.split('\nAlso: ');
  expect(first).not.toContain('pr-ship');
  expect(second).toContain('Confirm: this pull request is 512 changed lines in 1 file against `origin/main`');
});
