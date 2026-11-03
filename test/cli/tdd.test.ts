import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { readEvents } from '../../src/core/events.js';
import { pauseStatus } from '../../src/core/pause.js';
import { dispatch } from '../../src/hooks/dispatch.js';

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'h-tdd-'));
  mkdirSync(join(root, '.harness'));
  return root;
};
const cli = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  let out = '';
  const code = run(args, { root, env, out: (s) => (out += s + '\n') });
  return { code, out: out.trim() };
};
const hook = (root: string, session: string, ev: string) => dispatch(JSON.stringify({ hook_event_name: ev, session_id: session, cwd: root }), [], {});

test('off -> pending -> bound to first session -> only that SessionEnd clears', async () => {
  const root = mk();
  expect(cli(root, ['tdd', 'status']).out).toBe('TDD gate: on');
  const r = cli(root, ['tdd', 'off']);
  expect(r).toEqual({ code: 0, out: 'TDD layers 2–4 paused for your next Claude Code session. Stop gate and CI still apply.' });
  expect(pauseStatus(root)).toBe('pending');
  expect(cli(root, ['tdd', 'status']).out).toBe('TDD gate: paused (waiting for next session)');
  await hook(root, 'a', 'PreToolUse');
  await hook(root, 'b', 'PreToolUse');
  expect(pauseStatus(root)).toEqual({ session: 'a' });
  expect(cli(root, ['tdd', 'status']).out).toBe('TDD gate: paused for session a');
  await hook(root, 'b', 'SessionEnd');
  expect(pauseStatus(root)).toEqual({ session: 'a' });
  await hook(root, 'a', 'SessionEnd');
  expect(pauseStatus(root)).toBe('off');
  expect(readEvents(root).map((e) => `${e.check}/${e.decision}`)).toEqual(['tdd/paused']);
});

test('off while already paused keeps the file, shows status, logs nothing more', async () => {
  const root = mk();
  cli(root, ['tdd', 'off']);
  await hook(root, 'a', 'PreToolUse');
  const r = cli(root, ['tdd', 'off']);
  expect(r.out).toBe('TDD gate: paused for session a');
  expect(pauseStatus(root)).toEqual({ session: 'a' });
  expect(readEvents(root)).toHaveLength(1);
});

test('on clears the pause and logs resumed', () => {
  const root = mk();
  cli(root, ['tdd', 'off']);
  expect(cli(root, ['tdd', 'on']).code).toBe(0);
  expect(pauseStatus(root)).toBe('off');
  expect(existsSync(join(root, '.harness/state/tdd-pause.json'))).toBe(false);
  expect(readEvents(root).map((e) => e.decision)).toEqual(['paused', 'resumed']);
});

test('off refuses inside Claude Code', () => {
  const root = mk();
  const r = cli(root, ['tdd', 'off'], { CLAUDECODE: '1' });
  expect(r).toEqual({ code: 1, out: `Run harness tdd off from a plain terminal, not inside Claude Code: node "${resolve(process.argv[1])}" tdd off` });
  expect(pauseStatus(root)).toBe('off');
  expect(readEvents(root).map((e) => `${e.check}/${e.decision}`)).toEqual(['tdd/refused']);
});

test('help and unknown commands exit 2', () => {
  const root = mk();
  for (const a of [['--help'], ['nope'], [], ['tdd'], ['tdd', 'x']]) expect(cli(root, a).code).toBe(2);
});

test('a session already running when tdd off ran never takes the pause', async () => {
  const root = mk();
  await hook(root, 'old', 'PreToolUse');
  await new Promise((r) => setTimeout(r, 5));
  cli(root, ['tdd', 'off']);
  await hook(root, 'old', 'PreToolUse');
  expect(pauseStatus(root)).toBe('pending');
  await hook(root, 'new', 'PreToolUse');
  expect(pauseStatus(root)).toEqual({ session: 'new' });
});
