import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { decidePrSize, prSize } from '../../../src/checks/pr-size/check.js';
import { PROGRESS, progressWarning, readProgress, step } from '../../../src/checks/pr-size/progress.js';
import type { HarnessConfig } from '../../../src/core/config.js';
import { readEvents } from '../../../src/core/events.js';
import type { Check, Ctx } from '../../../src/hooks/dispatch.js';
import { makeRepo } from '../../install/helpers.js';
import { ctx, fakeGit, git, lines, repo } from './helpers.js';

const LIM = { target: 200, maxLines: 400, maxFiles: 20 };
const sz = (l: number, f = 1) => ({ lines: l, files: f });
const prev = (fired: ('target' | 'max')[]) => ({ base: 'origin/main', fired, lines: 0, files: 0, ts: 't' });

const ASK = 'Before your next edit, stop and ask the person how to go on, with AskUserQuestion if you have it: split now (run the pr-ship skill and show its suggested breakdown), keep going, or raise the limit for this branch (run `node .harness/hooks/dispatch.mjs --pr-size-raise --lines <n> --files <n>`, which asks them to approve).';
const TARGET = (l: number, f: string) => `PR size: this branch's change is now ${l} changed lines in ${f} against \`origin/main\` (committed and uncommitted), past the target of 200 lines. ${ASK} Harness says this once, and warns again above 400 lines or 20 files.`;
const MAX = (l: number) => `PR size: this branch's change is now ${l} changed lines in 1 file against \`origin/main\` (committed and uncommitted), past the limit of 400 lines or 20 files (aim for 200). Opening it as one PR will ask for approval. ${ASK} Harness won't warn again on this branch unless it drops below the limit.`;
const PERSON = (b: string, l: number, f = '1 file') => `harness pr-size: \`${b}\` is now ${l} changed lines in ${f} (target 200, limit 400 lines or 20 files). Claude should stop and ask you: split, keep going, or raise the limit.`;
const NOTE = 'Note from pr-size: this branch\'s change is now 201 changed lines in 1 file against `origin/main`, past the target of 200 lines. No person is here to ask, so keep going, then split the work with the pr-ship skill into stacked PRs of about 200 lines before you open any PR. A PR over 400 lines or 20 files will be refused.';

const blockStop: Check = { name: 'stop', events: ['Stop'], run: () => ({ kind: 'block', reason: 'tests fail', check: 'stop' }) };
async function hook(root: string, event: 'PostToolUse' | 'Stop', o: { tool?: string; file?: string; env?: NodeJS.ProcessEnv; checks?: Check[] } = {}) {
  writeFileSync(join(root, '.git/info/exclude'), '.harness/\n'); // as an install's .gitignore does, so harness state isn't counted
  vi.resetModules();
  const { dispatch } = await import('../../../src/hooks/dispatch.js');
  const tool = event === 'Stop' ? {} : { tool_name: o.tool ?? 'Edit', tool_input: o.tool === 'Bash' ? { command: 'ls' } : { file_path: join(root, o.file ?? 'src/a.ts') }, tool_response: {} };
  const out = await dispatch(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: root, ...tool }), o.checks ?? [prSize], o.env ?? {});
  return out ? (JSON.parse(out) as { systemMessage?: string; decision?: string; reason?: string; hookSpecificOutput?: { additionalContext?: string } }) : {};
}
const warned = (root: string) => readEvents(root).filter((e) => e.decision === 'pr-size-warned');
const edit = (root: string, rel: string, body: string) => (mkdirSync(join(root, rel, '..'), { recursive: true }), writeFileSync(join(root, rel), body));
function editCtx(root: string, file: string, o: { config?: (c: HarnessConfig) => void } = {}): Ctx {
  const c = ctx(root, '', { event: 'PostToolUse', tool: 'Edit', config: o.config });
  c.input.tool_input = { file_path: file };
  return c;
}

describe('step', () => {
  test.each([
    [undefined, sz(150), [], null],
    [undefined, sz(201), ['target'], 'target'],
    [prev(['target']), sz(250), ['target'], null],
    [prev(['target']), sz(401), ['target', 'max'], 'max'],
    [undefined, sz(500), ['target', 'max'], 'max'],
    [prev(['target', 'max']), sz(300), ['target'], null],
    [prev(['target', 'max']), sz(120), [], null],
    [undefined, sz(50, 21), ['target', 'max'], 'max'],
  ] as const)('%o at %o', (p, s, fired, announce) => {
    expect(step(p as never, s, LIM)).toEqual({ fired, announce });
  });
});

describe('through dispatch', () => {
  test('target, no repeat, max, then a reset warns again', async () => {
    const root = repo({ 'src/a.ts': lines(1) });
    edit(root, 'src/a.ts', lines(201));
    const a = await hook(root, 'PostToolUse');
    expect(a.hookSpecificOutput?.additionalContext).toBe(TARGET(201, '1 file'));
    expect(a.systemMessage).toBe(PERSON('feat', 201));
    expect(warned(root)).toEqual([expect.objectContaining({ check: 'pr-size', reason: 'feat target 201/1' })]);
    expect(JSON.parse(readFileSync(join(root, PROGRESS), 'utf8')).feat).toMatchObject({ base: 'origin/main', fired: ['target'], lines: 201, files: 1 });
    edit(root, 'src/a.ts', lines(250));
    expect(await hook(root, 'PostToolUse')).toEqual({});
    edit(root, 'src/a.ts', lines(401));
    expect((await hook(root, 'PostToolUse')).hookSpecificOutput?.additionalContext).toBe(MAX(401));
    edit(root, 'src/a.ts', lines(100));
    expect(await hook(root, 'PostToolUse')).toEqual({});
    edit(root, 'src/a.ts', lines(201));
    expect((await hook(root, 'PostToolUse')).hookSpecificOutput?.additionalContext).toBe(TARGET(201, '1 file'));
    expect(warned(root)).toHaveLength(3);
  });

  test('an excluded or out-of-repo edit, or a PostToolUse Bash, spawns no git', () => {
    const root = repo();
    for (const file of [join(root, 'pnpm-lock.yaml'), '/elsewhere/a.ts']) {
      const f = fakeGit();
      expect(progressWarning(editCtx(root, file), f.g)).toEqual({ kind: 'allow' });
      expect(f.calls).toEqual([]);
    }
    const f = fakeGit();
    expect(decidePrSize(ctx(root, 'ls', { event: 'PostToolUse' }), f.g)).toEqual({ kind: 'allow' });
    expect(f.calls).toEqual([]);
  });

  test('a detached HEAD gives no output and no file', async () => {
    const root = repo({ 'src/a.ts': lines(1) });
    git(root, 'checkout', '-q', '--detach');
    edit(root, 'src/a.ts', lines(300));
    expect(await hook(root, 'PostToolUse')).toEqual({});
    expect(existsSync(join(root, PROGRESS))).toBe(false);
  });
});

describe('Stop', () => {
  test('a shell-made untracked file is announced as systemMessage, and survives a Stop block', async () => {
    const root = repo();
    edit(root, 'gen/out.ts', lines(300));
    expect(await hook(root, 'Stop')).toEqual({ systemMessage: PERSON('feat', 300) });
    const r2 = repo();
    edit(r2, 'gen/out.ts', lines(300));
    expect(await hook(r2, 'Stop', { checks: [prSize, blockStop] })).toEqual({ decision: 'block', reason: 'tests fail', systemMessage: PERSON('feat', 300) });
  });
});

describe('unattended', () => {
  test('the note as additionalContext with no systemMessage; at Stop the event only', async () => {
    const root = repo();
    edit(root, 'src/a.ts', lines(201));
    const a = await hook(root, 'PostToolUse', { env: { HARNESS_UNATTENDED: '1' } });
    expect(a).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: NOTE } });
    const r2 = repo();
    edit(r2, 'src/a.ts', lines(201));
    expect(await hook(r2, 'Stop', { env: { HARNESS_UNATTENDED: '1' } })).toEqual({});
    expect(warned(r2)).toHaveLength(1);
  });
});

describe('off, unmeasured, bad state, odd names', () => {
  test('checks.prSize false: no output and no file', () => {
    const root = repo();
    edit(root, 'src/a.ts', lines(300));
    expect(decidePrSize(editCtx(root, join(root, 'src/a.ts'), { config: (c) => (c.checks.prSize = false) }))).toEqual({ kind: 'allow' });
    expect(existsSync(join(root, PROGRESS))).toBe(false);
  });

  test('a missing base: no output and no event', async () => {
    const root = makeRepo({ 'README.md': 'hi\n' }, { branch: 'feat' });
    edit(root, 'src/a.ts', lines(300));
    expect(await hook(root, 'PostToolUse')).toEqual({});
    expect(readEvents(root).filter((e) => e.check === 'pr-size')).toEqual([]);
  });

  test.each(['not json', '[]', '{"feat":{"fired":"x"}}'])('pr-progress.json %s reads as {} and the edit allows', async (body) => {
    const root = repo();
    mkdirSync(join(root, '.harness/state'), { recursive: true });
    writeFileSync(join(root, PROGRESS), body);
    expect(readProgress(root)).toEqual({});
    edit(root, 'src/a.ts', lines(10));
    expect(await hook(root, 'PostToolUse')).toEqual({});
  });

  test('a branch named constructor warns at 201', async () => {
    const root = repo();
    git(root, 'checkout', '-q', '-b', 'constructor');
    edit(root, 'src/a.ts', lines(201));
    expect((await hook(root, 'PostToolUse')).systemMessage).toBe(PERSON('constructor', 201));
  });

  test('a branch name with a bidi override is escaped', async () => {
    const root = repo();
    git(root, 'checkout', '-q', '-b', 'feat‮x');
    edit(root, 'src/a.ts', lines(201));
    expect((await hook(root, 'PostToolUse')).systemMessage).toBe(PERSON('feat\\u202ex', 201));
  });

});
