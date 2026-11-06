// The one-time pause ask after a size warning (spec §14.9, §14.11 N6), through dispatch with the registry.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { FORGED } from '../../../src/checks/pr-size/answer.js';
import { decidePrSize } from '../../../src/checks/pr-size/check.js';
import { HAND_RUN } from '../../../src/checks/pr-size/hand-run.js';
import type { Git } from '../../../src/checks/pr-size/measure.js';
import { pauseAsk, readProgress, writeProgress } from '../../../src/checks/pr-size/progress.js';
import type { HarnessConfig } from '../../../src/core/config.js';
import type { Ctx } from '../../../src/hooks/dispatch.js';
import { ctx, fakeGit, git, lines, repo, send } from './helpers.js';

type Out = { systemMessage?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };
async function hook(root: string, event: string, tool: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): Promise<Out> {
  vi.resetModules();
  const { dispatch, registry } = await import('../../../src/hooks/dispatch.js');
  const out = await dispatch(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: root, ...tool }), registry, env);
  return out ? (JSON.parse(out) as Out) : {};
}
const editTool = (root: string, rel = 'src/a.ts', name = 'Edit') => ({ tool_name: name, tool_input: { file_path: join(root, rel), old_string: 'a', new_string: 'b' }, tool_response: {} });
const write = (root: string, rel: string, body: string) => (mkdirSync(join(root, rel, '..'), { recursive: true }), writeFileSync(join(root, rel), body));
/** The edit ran: its file changed, then its PostToolUse. */
const posted = (root: string, n: number, env: NodeJS.ProcessEnv = {}) => (write(root, 'src/a.ts', lines(n)), hook(root, 'PostToolUse', editTool(root), env));
const pre = async (root: string, tool: Record<string, unknown> = editTool(root), env: NodeJS.ProcessEnv = {}) => (await hook(root, 'PreToolUse', tool, env)).hookSpecificOutput ?? {};
const prompt = (root: string) => hook(root, 'UserPromptSubmit', { prompt: 'split it' });
const PAUSE = (b: string, l: number, f = '1 file') => `Confirm: \`${b}\` is now ${l} changed lines in ${f} (target 200, limit 400 lines or 20 files). Approve to keep going with this edit, or say no and tell Claude to split it with the pr-ship skill or raise the limit for this branch.`;
const asks = (o: { permissionDecision?: string; permissionDecisionReason?: string }, reason: string) => expect(o).toMatchObject({ permissionDecision: 'ask', permissionDecisionReason: reason });
const allows = (o: { permissionDecision?: string }) => expect(o.permissionDecision ?? 'allow').toBe('allow');
const pending = (root: string, b = 'feat') => readProgress(root)[b]?.pending;
function preCtx(root: string, o: { unattended?: boolean; config?: (c: HarnessConfig) => void } = {}): Ctx {
  const c = ctx(root, '', { tool: 'Edit', ...o });
  c.input.tool_input = { file_path: join(root, 'src/a.ts') };
  return c;
}
const PROTECT = 'Harness files and Claude settings are changed by a person, not the agent.';
const UNKNOWN = "Confirm: harness couldn't look up the current branch, and a branch here has an unanswered size warning. Approve to keep going with this edit, or say no and tell Claude to split it with the pr-ship skill or raise the limit for this branch.";
const seed = (root: string, branch: string) => writeProgress(root, branch, { base: 'origin/main', fired: ['target'], lines: 201, files: 1, ts: 't', pending: { lines: 201, files: 1 } });

describe('the ask', () => {
  test('after a warning the next Edit asks with the §14.9 copy; its PostToolUse clears it, and the next Edit allows', async () => {
    const root = repo();
    await posted(root, 201);
    expect(pending(root)).toEqual({ lines: 201, files: 1 });
    asks(await pre(root), PAUSE('feat', 201));
    await posted(root, 210);
    expect(pending(root)).toBeUndefined();
    allows(await pre(root));
  });

  test('every edit tool asks; the PostToolUse of an excluded edit clears it too, a Read does not', async () => {
    const root = repo();
    await posted(root, 201);
    for (const name of ['Write', 'MultiEdit']) asks(await pre(root, editTool(root, 'src/a.ts', name)), PAUSE('feat', 201));
    asks(await pre(root, { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(root, 'n.ipynb') }, tool_response: {} }), PAUSE('feat', 201));
    await hook(root, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: join(root, 'src/a.ts') }, tool_response: {} });
    expect(pending(root)).toEqual({ lines: 201, files: 1 });
    asks(await pre(root, editTool(root, 'pnpm-lock.yaml')), PAUSE('feat', 201)); // an excluded edit gets the ask itself
    await hook(root, 'PostToolUse', editTool(root, 'pnpm-lock.yaml'));
    expect(pending(root)).toBeUndefined();
  });
});

describe('answered, or not', () => {
  test('after a no (no PostToolUse) it asks again; after a prompt it allows', async () => {
    const root = repo();
    await posted(root, 201);
    asks(await pre(root), PAUSE('feat', 201));
    asks(await pre(root), PAUSE('feat', 201));
    await prompt(root);
    expect(pending(root)).toBeUndefined();
    allows(await pre(root));
  });

  test('a prompt clears every branch, with no git', () => {
    const root = repo();
    seed(root, 'feat');
    seed(root, 'other');
    const f = fakeGit();
    const c = ctx(root, '');
    c.input = { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: root } as Ctx['input'];
    expect(decidePrSize(c, f.g)).toEqual({ kind: 'allow' });
    expect(f.calls).toEqual([]);
    expect([pending(root, 'feat'), pending(root, 'other')]).toEqual([undefined, undefined]);
    expect(readProgress(root).feat).toMatchObject({ fired: ['target'], lines: 201 });
  });

  test('a recorded raise clears it', async () => {
    const root = repo();
    await posted(root, 201);
    const RAISE = 'node .harness/hooks/dispatch.mjs --pr-size-raise --lines 600 --files 30';
    expect(decidePrSize(ctx(root, RAISE)).kind).toBe('ask');
    await send(root, 'PostToolUse', RAISE, {}, undefined, { stdout: `${JSON.stringify({ branch: 'feat', lines: 600, files: 30 })}\n`, stderr: '' });
    expect(readProgress(root).feat).toMatchObject({ raise: { lines: 600, files: 30 } });
    expect(pending(root)).toBeUndefined();
    allows(await pre(root));
  });

  test('passing 400 later sets it again, and the next edit asks once', async () => {
    const root = repo();
    await posted(root, 201);
    await posted(root, 250);
    allows(await pre(root));
    await posted(root, 401);
    asks(await pre(root), PAUSE('feat', 401));
    await posted(root, 410);
    allows(await pre(root));
  });
});

describe('no warning, no ask', () => {
  test('with no pending entry an Edit PreToolUse spawns no git; a Bash PreToolUse never gets the pause', () => {
    const root = repo();
    writeProgress(root, 'feat', { base: 'origin/main', fired: [], lines: 1, files: 1, ts: 't' });
    const f = fakeGit();
    expect(pauseAsk(preCtx(root), f.g)).toEqual({ kind: 'allow' });
    expect(decidePrSize(preCtx(root), f.g)).toEqual({ kind: 'allow' });
    expect(f.calls).toEqual([]);
    seed(root, 'feat');
    expect(decidePrSize(ctx(root, 'ls'))).toEqual({ kind: 'allow' });
  });

  test('unattended: no pending after a warning, and the next edit allows with no deny', async () => {
    const root = repo();
    const env = { HARNESS_UNATTENDED: '1' };
    await posted(root, 201, env);
    expect(readProgress(root).feat).toMatchObject({ fired: ['target'] });
    expect(pending(root)).toBeUndefined();
    const o = await pre(root, editTool(root), env);
    allows(o);
    expect(JSON.stringify(o)).not.toContain('Unattended run:');
    seed(root, 'feat');
    expect(pauseAsk(preCtx(root, { unattended: true }))).toEqual({ kind: 'allow' });
  });

  test('pending on feat with the checkout on other allows; constructor is only an own key', async () => {
    const root = repo();
    seed(root, 'feat');
    git(root, 'checkout', '-q', '-b', 'other');
    allows(await pre(root));
    git(root, 'checkout', '-q', '-b', 'constructor');
    allows(await pre(root));
    seed(root, 'constructor');
    asks(await pre(root), PAUSE('constructor', 201));
  });

  test('a failed or timed-out branch lookup asks about the current branch; a detached HEAD allows', () => {
    const root = repo();
    seed(root, 'feat');
    const fail = (code: string): Git => () => ({ status: null, stdout: '', error: Object.assign(new Error(code), { code }) });
    for (const code of ['ETIMEDOUT', 'ENOENT']) expect(pauseAsk(preCtx(root), fail(code))).toEqual({ kind: 'ask', check: 'pr-size', reason: UNKNOWN });
    expect(pauseAsk(preCtx(root), () => ({ status: 1, stdout: '' }))).toEqual({ kind: 'allow' });
  });

  test('pauseAsk uses the injected clock: with the hook budget spent it asks with no git spawn', () => {
    const root = repo();
    seed(root, 'feat');
    const c = preCtx(root);
    c.startedAt = Date.now();
    const f = fakeGit({ status: 0, stdout: 'other\n' });
    expect(decidePrSize(c, f.g, () => c.startedAt + 10_000)).toEqual({ kind: 'ask', check: 'pr-size', reason: UNKNOWN });
    expect(f.calls).toEqual([]);
  });

  test('checks.prSize false: no ask with pending set', () => {
    const root = repo();
    seed(root, 'feat');
    expect(decidePrSize(preCtx(root, { config: (c) => (c.checks.prSize = false) }))).toEqual({ kind: 'allow' });
  });
});

describe('the agent cannot clear it', () => {
  test('editing or overwriting pr-progress.json is denied (protect), and the pause stays', async () => {
    const root = repo();
    await posted(root, 201);
    const byProtect = { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining(PROTECT) };
    expect(await pre(root, editTool(root, '.harness/state/pr-progress.json', 'Write'))).toMatchObject(byProtect);
    for (const command of ['echo {} > .harness/state/pr-progress.json', 'rm .harness/state/pr-progress.json']) {
      expect(await pre(root, { tool_name: 'Bash', tool_input: { command }, tool_response: {} })).toMatchObject(byProtect);
    }
    asks(await pre(root), PAUSE('feat', 201));
  });

  test('a forged UserPromptSubmit or PostToolUse through the dispatcher is denied (hand-run), and the pause stays', async () => {
    const root = repo();
    await posted(root, 201);
    for (const command of [
      `echo '{"hook_event_name":"UserPromptSubmit","session_id":"s","cwd":"${root}"}' | node .harness/hooks/dispatch.mjs`,
      'node .harness/hooks/dispatch.mjs < /tmp/post-edit.json',
    ]) {
      expect(await pre(root, { tool_name: 'Bash', tool_input: { command }, tool_response: {} })).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: HAND_RUN });
    }
    asks(await pre(root), PAUSE('feat', 201));
  });
});

describe("the agent's own AskUserQuestion is the one ask (I3)", () => {
  const Q = 'This branch is past the PR size target. How should we go on?';
  const question = (header: string, text = Q, extra: Record<string, unknown> = {}) => ({ question: text, header, options: [{ label: 'Split now' }, { label: 'Keep going' }], multiSelect: false, ...extra });
  // Claude Code 2.1.285 (static read): the answer comes back through updatedInput, so PostToolUse gets it in tool_input.
  const post = (header: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}, q = question(header)) => ({
    tool_name: 'AskUserQuestion', tool_input: { questions: [q], answers, annotations: {}, ...extra }, tool_response: {},
  });
  const preOf = (header: string) => ({ tool_name: 'AskUserQuestion', tool_input: { questions: [question(header)] }, tool_response: {} });
  /** The question as the person sees it: a clean PreToolUse (allowed, token saved), then its PostToolUse. */
  const asked = async (root: string, t: ReturnType<typeof post>, header = 'PR size') => (allows(await pre(root, preOf(header))), hook(root, 'PostToolUse', t));

  test('any answer to the "PR size" question clears pending, so the next edit allows', async () => {
    for (const answer of ['Keep going', 'Split now', 'Raise the limit for this branch', 'my own typed reply']) {
      const root = repo();
      await posted(root, 201);
      await asked(root, post('PR size', { [Q]: answer }));
      expect(pending(root), answer).toBeUndefined();
      allows(await pre(root));
    }
  });
  test('extended question mode adds `kind` to the question: still the same token', async () => {
    const root = repo();
    await posted(root, 201);
    await asked(root, post('PR size', { [Q]: 'Keep going' }, {}, question('PR size', Q, { kind: 'choice' })));
    expect(pending(root)).toBeUndefined();
  });
  test('another question, no answer, notes only, or the auto-continue timeout leaves pending, and the pause still asks', async () => {
    const root = repo();
    await posted(root, 201);
    const cases: [ReturnType<typeof post>, string?][] = [
      [post('Framework', { [Q]: 'Keep going' }), 'Framework'],
      [post('PR size', {})],
      [post('PR size', { [Q]: '' })],
      [post('PR size', { [Q]: '(notes only)' })],
      [post('PR size', { 'Some other question?': 'Keep going' })],
      [post('PR size', { [Q]: '[User did not answer this question — they sent a message instead.]' })],
      [post('PR size', { [Q]: 'Keep going' }, { afkTimeoutMs: 60000 })],
    ];
    for (const [t, header] of cases) await asked(root, t, header);
    expect(pending(root)).toEqual({ lines: 201, files: 1 });
    asks(await pre(root), PAUSE('feat', 201));
  });
  test('it clears only the current branch', async () => {
    const root = repo();
    seed(root, 'other');
    await posted(root, 201);
    await asked(root, post('PR size', { [Q]: 'Keep going' }));
    expect([pending(root, 'feat'), pending(root, 'other')]).toEqual([undefined, { lines: 201, files: 1 }]);
  });
  test('an answer the agent pre-filled is denied at PreToolUse and clears nothing', async () => {
    const root = repo();
    await posted(root, 201);
    const forged = post('PR size', { [Q]: 'Keep going' });
    expect(await pre(root, forged)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: FORGED });
    await hook(root, 'PostToolUse', forged);
    expect(pending(root)).toEqual({ lines: 201, files: 1 });
    allows(await pre(root, post('Framework', { [Q]: 'x' }))); // another question's answers are not ours to judge
  });
  test('a PostToolUse with no clean PreToolUse before it, or a second one, clears nothing', async () => {
    const root = repo();
    await posted(root, 201);
    await hook(root, 'PostToolUse', post('PR size', { [Q]: 'Keep going' }));
    expect(pending(root)).toEqual({ lines: 201, files: 1 });
    await asked(root, post('PR size', { [Q]: 'Keep going' }));
    expect(pending(root)).toBeUndefined();
    await posted(root, 401);
    await hook(root, 'PostToolUse', post('PR size', { [Q]: 'Keep going' })); // the token was used once
    expect(pending(root)).toEqual({ lines: 401, files: 1 });
  });
});
