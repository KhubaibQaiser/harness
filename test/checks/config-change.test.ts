import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { configChange } from '../../src/checks/config-change.js';
import { lastConfigChangeBlocked, readEvents } from '../../src/core/events.js';
import { stampHarnessFiles } from '../../src/core/harness-files.js';
import { readState } from '../../src/core/state.js';
import { dispatch, registry } from '../../src/hooks/dispatch.js';

// ConfigChange (spec 3.3, D6, C1, C5): a mid-session change to harness's hooks, its deny rules, disableAllHooks or the
// sandbox settings is not applied to the running session. Inputs come from the documented shapes in the fixture.
const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../fixtures/hooks/config-change.json'), 'utf8'));
const FORCE = 'Bash(git push *--force*)';
const GROUP = { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'], onFailure: 'block' }] };
const SETTINGS = { hooks: { PreToolUse: [{ matcher: 'Bash', ...GROUP }], ConfigChange: [GROUP] }, permissions: { deny: [FORCE] } };

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), 'h-cc-'));
  const home = mkdtempSync(join(tmpdir(), 'h-cc-home-'));
  mkdirSync(join(root, '.harness/hooks'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n');
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ version: '1', createdAt: 'x', files: [{ rel: '.claude/settings.json', kind: 'create', hash: 'x', blocks: [JSON.stringify({ deny: FORCE })] }] }));
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v1\n');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(SETTINGS));
  writeFileSync(join(home, '.claude/settings.json'), '{}');
  return { root, home };
};
type Repo = ReturnType<typeof repo>;
const run = (r: Repo, input: Record<string, unknown>) => dispatch(JSON.stringify({ ...input, session_id: 's', cwd: r.root }), registry, {}, { home: r.home });
const change = (r: Repo, source: string) => run(r, FIXTURE[source]);
const prompt = (r: Repo) => run(r, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
const parsed = (s: string) => (s ? JSON.parse(s) : null);
const write = (p: string, v: unknown) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));

test('config-change is fail-closed and handles ConfigChange only', () => {
  expect(configChange).toMatchObject({ name: 'config-change', events: ['ConfigChange'], failClosed: true });
  expect(registry).toContain(configChange);
});

test('a project hook removed is blocked, logged, and noticed at the next prompt only', async () => {
  const r = repo();
  await prompt(r); // first hook: baseline
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, hooks: { ConfigChange: [GROUP] } });
  const out = parsed(await change(r, 'project_settings'));
  expect(out).toEqual({ decision: 'block', reason: 'Harness keeps its hooks, its deny rules, disableAllHooks and the sandbox settings as they were when this session started, so this change to `.claude/settings.json` (hooks) is not applied to the session.' });
  expect(readEvents(r.root).filter((e) => e.decision === 'config-change-blocked').map((e) => e.reason)).toEqual(['.claude/settings.json: hooks']);
  expect(lastConfigChangeBlocked(r.root)?.reason).toBe('.claude/settings.json: hooks');
  const notice = 'Harness blocked a change to `.claude/settings.json` (hooks) in this session. The file is still changed on disk, so the next session loads it: review it first.';
  expect(readState(r.root, 's').pendingNotice).toBe(notice);
  const next = parsed(await prompt(r));
  expect(next.systemMessage).toContain(notice);
  expect(next.hookSpecificOutput.additionalContext).toContain(notice);
  expect(JSON.stringify(parsed(await prompt(r)) ?? {})).not.toContain('Harness blocked a change');
});

test('the ConfigChange notice and the change-detection notice share one message', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, disableAllHooks: true });
  await change(r, 'project_settings');
  const next = parsed(await prompt(r));
  const [blocked, changed] = next.systemMessage.split('\n');
  expect(blocked).toContain('Harness blocked a change to `.claude/settings.json` (disableAllHooks)');
  expect(changed).toContain('Harness files changed since harness last checked them: `.claude/settings.json`');
  expect(next.hookSpecificOutput.additionalContext).toBe(next.systemMessage);
});

test('disableAllHooks in the user file is blocked', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { disableAllHooks: true });
  expect(parsed(await change(r, 'user_settings')).reason).toContain('this change to `~/.claude/settings.json` (disableAllHooks)');
});

test('an "Always allow" click in the local file, and any other source, are allowed', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { permissions: { allow: ['Bash(ls)'] } });
  expect(await change(r, 'local_settings')).toBe('');
  write(join(r.root, '.claude/settings.json'), {});
  expect(await change(r, 'policy_settings')).toBe('');
  expect(await change(r, 'skills')).toBe('');
});

test('a CLI-recorded change is allowed, and so is a later allow-only change to the same file', async () => {
  const r = repo();
  await prompt(r);
  const updated = { ...SETTINGS, hooks: { ...SETTINGS.hooks, Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['.harness/hooks/dispatch.mjs'] }] }] } };
  write(join(r.root, '.claude/settings.json'), updated);
  stampHarnessFiles(r.root);
  expect(await change(r, 'project_settings')).toBe('');
  write(join(r.root, '.claude/settings.json'), { ...updated, permissions: { ...updated.permissions, allow: ['Bash(ls)'] } });
  expect(await change(r, 'project_settings')).toBe('');
});

test('the CLI record never covers the user file', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { sandbox: { enabled: false } });
  stampHarnessFiles(r.root);
  expect(parsed(await change(r, 'user_settings')).reason).toContain('(sandbox)');
});

test('deleting the project settings blocks', async () => {
  const r = repo();
  await prompt(r);
  rmSync(join(r.root, '.claude/settings.json'));
  expect(parsed(await change(r, 'project_settings')).reason).toContain('`.claude/settings.json` (hooks, deny)');
  expect(lastConfigChangeBlocked(r.root)?.reason).toBe('.claude/settings.json: hooks, deny');
});

test('a non-JSON guarded file blocks as unreadable', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), '{"disableAllHooks": true,');
  expect(parsed(await change(r, 'local_settings')).reason).toContain('`.claude/settings.local.json` (unreadable)');
});

test('no baseline blocks', async () => {
  const r = repo();
  // The session's first hook is the ConfigChange itself: nothing to compare against, so it blocks as onFailure would.
  expect(parsed(await change(r, 'local_settings'))?.decision).toBe('block');
  expect(readState(r.root, 's').guardedBase).toBeUndefined();
  await prompt(r); // the next other hook takes the baseline, once
  const base = readState(r.root, 's').guardedBase;
  expect(base?.project?.deny).toEqual([FORCE]);
  write(join(r.root, '.claude/settings.json'), {});
  await prompt(r);
  expect(readState(r.root, 's').guardedBase).toEqual(base);
});
