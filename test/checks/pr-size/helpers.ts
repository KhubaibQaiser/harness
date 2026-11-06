import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prSize } from '../../../src/checks/pr-size/check.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
import { defaults, type HarnessConfig } from '../../../src/core/config.js';
import { type Ctx, dispatch } from '../../../src/hooks/dispatch.js';
import { makeRepo } from '../../install/helpers.js';

export const PR_URL = { stdout: 'https://github.com/o/r/pull/7\n', stderr: '', interrupted: false, isImage: false };
export const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
export const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('');
export function commit(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), body));
  git(root, 'add', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '-m', 'c');
}
/** main with origin/main and origin/HEAD, then `feat` checked out with `files` committed. */
export function repo(files: Record<string, string> = {}) {
  const root = makeRepo({ 'README.md': 'hi\n' }, { branch: 'main', remoteHead: 'main' });
  git(root, 'checkout', '-q', '-b', 'feat');
  if (Object.keys(files).length) commit(root, files);
  return root;
}
export type Over = { response?: unknown; event?: 'PreToolUse' | 'PostToolUse'; unattended?: boolean; config?: (c: HarnessConfig) => void; tool?: string };
export function ctx(root: string, command: string, o: Over = {}): Ctx {
  const config = defaults();
  o.config?.(config);
  const input = { hook_event_name: o.event ?? 'PreToolUse', session_id: 's', cwd: root, tool_name: o.tool ?? 'Bash', tool_input: { command }, tool_response: 'response' in o ? o.response : PR_URL };
  return { input, root, config, unattended: o.unattended ?? false, env: {} } as unknown as Ctx;
}
export const fakeGit = (reply: ReturnType<Git> = { status: 0, stdout: '' }) => {
  const calls: string[][] = [];
  const g: Git = (args) => (calls.push(args), reply);
  return { calls, g, diffs: () => calls.filter((a) => a.includes('diff')) };
};
export const send = (root: string, event: string, command: string, env: NodeJS.ProcessEnv = {}, checks = [prSize], response: unknown = PR_URL) =>
  dispatch(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command }, tool_response: response }), checks, env);
