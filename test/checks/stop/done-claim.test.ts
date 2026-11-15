// Task 9: the Stop claim checker blocks a "done" claim that has no fresh evidence, and never decides done itself.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { doneClaim } from '../../../src/checks/stop/done-claim.js';
import { multiFile } from '../../../src/checks/multi-file.js';
import { readEvents } from '../../../src/core/events.js';
import { type Contract, setActiveTask, writeContract } from '../../../src/done/contract.js';
import { appendRow } from '../../../src/done/ledger.js';
import { treeHash } from '../../../src/done/tree.js';
import type { Check } from '../../../src/hooks/check.js';
import { dispatch } from '../../../src/hooks/dispatch.js';
import { assistant } from '../../fixtures/transcripts/make.js';
import { repoWith } from '../../review/repo.js';

const contract: Contract = {
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [
    { id: 'C1', text: 'builds', check: { run: 'node build.mjs', expect_exit: 0 } },
    { id: 'C2', text: 'looks right', check: { person: 'open the login page' } },
  ],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};

function setup(o: { done?: boolean; active?: boolean; yaml?: string } = {}) {
  const { root } = repoWith({ 'README.md': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, {});
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  done: ${o.done ?? true}\n${o.yaml ?? ''}`);
  const c = writeContract(root, contract);
  if (o.active ?? true) setActiveTask(root, c.id);
  const run = (command: string, criteria: string[] = [], exit = 0) =>
    appendRow(root, { kind: 'run', ts: 't', session: 's', command, exit, tree: treeHash(root), contract: c.sha256!, criteria });
  const prompt = () => dispatch(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root, prompt: 'next' }), [multiFile], {});
  const stop = async (extra: Record<string, unknown> = { last_assistant_message: 'All tests pass.' }, checks: Check[] = [doneClaim]) => {
    const out = await dispatch(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: root, ...extra }), checks, {});
    return out ? (JSON.parse(out) as { decision?: string; reason?: string }) : {};
  };
  // the dispatcher's own `block` line is not this check's event
  const events = () => readEvents(root).filter((e) => e.check === 'done' && e.decision !== 'block');
  return { root, c, run, stop, events, prompt };
}
const blocks = (d: { decision?: string }) => expect(d.decision).toBe('block');

test('a claim with a stale check blocks and names the gap', async () => {
  const { stop, events } = setup();
  const d = await stop();
  blocks(d);
  expect(d.reason).toContain('You said "all tests pass", but test has not passed since your last edit (required check). Run it, or end with harness done --blocked "<reason>".');
  expect(d.reason).toContain('but node build.mjs has not passed since your last edit (criterion C1).');
  expect(d.reason).not.toContain('C2');
  expect(d.reason).toMatch(/\(attempt 1 of 3\)$/);
  expect(events().at(-1)).toMatchObject({ decision: 'false-done-claim', reason: '\\"all tests pass\\": test, C1' });
  expect(JSON.stringify(events())).not.toContain('All tests pass.'); // the text is never stored
});

test('a person criterion is never a gap', async () => {
  const { run, stop, events } = setup();
  run('pnpm run test');
  run('node build.mjs', ['C1']);
  expect(await stop()).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim', reason: 'all tests pass' });
});

test('no claim, or a negated claim, never blocks', async () => {
  const { stop, events } = setup();
  for (const m of ['I am still working on it.', 'It is not done yet.', 'Tests do not pass.', '']) expect(await stop({ last_assistant_message: m })).toEqual({});
  expect(events()).toEqual([]);
});

test('no active contract allows silently', async () => {
  const { stop, events } = setup({ active: false });
  expect(await stop()).toEqual({});
  expect(events()).toEqual([]);
});

test('a fresh blocked row allows the stop', async () => {
  const { root, c, stop } = setup();
  appendRow(root, { kind: 'blocked', ts: 't', session: 's', task: c.id, reason: 'no network', failing_criteria: ['C1'], tree: treeHash(root), contract: c.sha256! });
  expect(await stop()).toEqual({});
});

test('after stop.max_attempts blocks it allows once and logs false-done-gave-up', async () => {
  const { stop, events } = setup({ yaml: 'stop:\n  max_attempts: 2\n' });
  blocks(await stop());
  expect((await stop()).reason).toMatch(/\(attempt 2 of 2\)$/);
  expect(await stop()).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'false-done-gave-up' });
  expect((await stop()).reason).toMatch(/\(attempt 1 of 2\)$/); // the counter was reset
});

test('a clean claim resets the attempts', async () => {
  const { run, stop } = setup();
  blocks(await stop());
  run('pnpm run test');
  run('node build.mjs', ['C1']);
  expect(await stop()).toEqual({});
});

test('missing last_assistant_message falls back to the transcript tail', async () => {
  const { stop, events } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'h-claim-'));
  const t = join(dir, 't.jsonl');
  writeFileSync(t, JSON.stringify(assistant({ content: [{ type: 'text', text: 'All tests pass.' }] })) + '\n');
  const d = await stop({ transcript_path: t });
  blocks(d);
  expect(events().at(-1)?.reason).toBe('\\"all tests pass\\": test, C1');
});

test('a tree hash failure allows and logs done-claim-unchecked', async () => {
  const { root, stop, events } = setup();
  rmSync(join(root, '.git'), { recursive: true, force: true });
  expect(await stop()).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim-unchecked', reason: expect.stringContaining('tree hash') });
});

test('an unreadable contract allows and logs done-claim-unchecked', async () => {
  const { root, stop, events } = setup();
  writeFileSync(join(root, '.harness/tasks/add-login.json'), '{ not json');
  expect(await stop()).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim-unchecked', reason: expect.stringContaining('contract') });
});

test('with the default config nothing runs and nothing is logged', async () => {
  const { stop, events } = setup({ done: false });
  expect(await stop()).toEqual({});
  expect(events()).toEqual([]);
});

test('when it blocks, a later Stop check still runs and the done reason wins (the reverse order shows the first)', async () => {
  const { stop } = setup();
  let ran = false;
  const later: Check = { name: 'later', events: ['Stop'], run: () => ((ran = true), { kind: 'block', reason: 'later says no', check: 'later' }) };
  const d = await stop(undefined, [doneClaim, later]);
  expect(ran).toBe(true);
  expect(d.reason).toContain('You said "all tests pass"');
});

test('a passing row for an older tree does not count', async () => {
  const { root, run, stop } = setup();
  run('pnpm run test');
  run('node build.mjs', ['C1']);
  expect(await stop()).toEqual({});
  appendFileSync(join(root, 'README.md'), 'edit\n');
  const d = await stop();
  blocks(d);
  expect(d.reason).toContain('but test has not passed since your last edit');
});

test('a near-miss argv does not count as the check', async () => {
  const { run, stop } = setup();
  run('pnpm run test -- -t x');
  run('node build.mjs', ['C1']);
  blocks(await stop());
});

test('an invalid HARNESS_TASK is logged, not a silent allow', async () => {
  const { root, events } = setup();
  const out = await dispatch(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: root, last_assistant_message: 'Done.' }), [doneClaim], { HARNESS_TASK: 'Bad Id' });
  expect(out).toBe('');
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim-unchecked', reason: expect.stringContaining('HARNESS_TASK') });
});

test('a new prompt starts the attempts at 1', async () => {
  const { stop, prompt } = setup();
  expect((await stop()).reason).toMatch(/\(attempt 1 of 3\)$/);
  expect((await stop()).reason).toMatch(/\(attempt 2 of 3\)$/);
  await prompt();
  expect((await stop()).reason).toMatch(/\(attempt 1 of 3\)$/);
});

test('a Stop with no claim resets the attempts', async () => {
  const { stop } = setup();
  await stop();
  await stop();
  expect(await stop({ last_assistant_message: 'Still working.' })).toEqual({});
  expect((await stop()).reason).toMatch(/\(attempt 1 of 3\)$/);
});

test('a fresh blocked row allows and logs the claim as blocked', async () => {
  const { root, c, stop, events } = setup();
  appendRow(root, { kind: 'blocked', ts: 't', session: 's', task: c.id, reason: 'x', failing_criteria: [], tree: treeHash(root), contract: c.sha256! });
  expect(await stop()).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim', reason: 'all tests pass blocked' });
});

test('an empty or unreadable transcript logs done-claim-unchecked', async () => {
  const { root, stop, events } = setup();
  expect(await stop({ transcript_path: join(root, 'missing.jsonl') })).toEqual({});
  expect(events().at(-1)).toMatchObject({ decision: 'done-claim-unchecked', reason: 'no assistant text' });
});

test('with a failing stop gate of its own, the Stop is bounded and the gate output is shown first', async () => {
  const { stop } = setup();
  // Stand-in for stopGate: same shared counter and give-up rule as gate.ts failStep.
  const gate: Check = {
    name: 'stopGate', events: ['Stop'],
    run(ctx) {
      const n = ctx.state.stopAttempts + 1;
      if (n > ctx.config.stop.max_attempts) return ctx.save({ ...ctx.state, stopAttempts: 0 }), { kind: 'allow' };
      ctx.save({ ...ctx.state, stopAttempts: n });
      return { kind: 'block', reason: `test failed (attempt ${n})`, check: 'stop' };
    },
  };
  await stop({ last_assistant_message: 'Still working.' }, [gate, doneClaim]); // the gate alone blocks first, putting the counters out of phase
  let allowed = -1;
  for (let i = 0; i < 9 && allowed < 0; i++) {
    const d = await stop(undefined, [gate, doneClaim]);
    if (d.decision !== 'block') allowed = i;
    else expect(d.reason).toMatch(/^test failed|^You said/); // when both block, the gate's message wins
  }
  expect(allowed).toBeGreaterThanOrEqual(0);
  expect(allowed).toBeLessThanOrEqual(2 * 3);
});
