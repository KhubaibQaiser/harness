import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { status } from '../../src/cli/status.js';
import { doctor } from '../../src/cli/doctor.js';
import { readEvents } from '../../src/core/events.js';
import { guardedDiff, guardedView, snapshotHarnessFiles, stampHarnessFiles } from '../../src/core/harness-files.js';
import { dispatch } from '../../src/hooks/dispatch.js';

// Change detection (owner decision 2026-11-03): the backstop for every route the path checks can't see.
const repo = (config = 'checks:\n  guard: true\n') => {
  const root = mkdtempSync(join(tmpdir(), 'h-hf-'));
  mkdirSync(join(root, '.harness/hooks'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.harness/config.yaml'), config);
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ version: '1', createdAt: 'x', files: [] }));
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v1\n');
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  return root;
};
const hook = (root: string, event: string, env: NodeJS.ProcessEnv = {}, session = 's') =>
  dispatch(JSON.stringify({ hook_event_name: event, session_id: session, cwd: root, prompt: 'go', tool_name: 'Read', tool_input: { file_path: join(root, 'a') } }), [], env);
const parsed = (s: string) => (s ? JSON.parse(s) : null);

test('snapshot covers config, manifest, every hooks file and the Claude settings files that exist', () => {
  const root = repo();
  writeFileSync(join(root, '.harness/hooks/jest-results.cjs'), 'x');
  writeFileSync(join(root, '.claude/settings.json'), '{"permissions":{"deny":["Mine"]}}');
  expect(Object.keys(snapshotHarnessFiles(root)).sort()).toEqual(['.claude/settings.json', '.harness/config.yaml', '.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/manifest.json']);
  writeFileSync(join(root, '.claude/settings.local.json'), '{"permissions":{"allow":["Bash(ls)"]}}');
  expect(Object.keys(snapshotHarnessFiles(root))).not.toContain('.claude/settings.local.json'); // nothing harness relies on
  writeFileSync(join(root, '.claude/settings.local.json'), '{"disableAllHooks":true}');
  expect(Object.keys(snapshotHarnessFiles(root))).toContain('.claude/settings.local.json');
});

test('a harness file changed mid-session: Stop blocks once naming it, logs it, and does not loop', async () => {
  const root = repo();
  expect(await hook(root, 'PreToolUse')).toBe(''); // first hook: snapshot
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n');
  const out = parsed(await hook(root, 'Stop'));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('`.harness/config.yaml`');
  expect(out.reason).toContain('git diff -- .harness .claude/settings.json');
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed').map((e) => e.reason)).toEqual(['.harness/config.yaml']);
  expect(await hook(root, 'Stop')).toBe(''); // re-snapshotted: blocked once per change set
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// tampered\n');
  expect(parsed(await hook(root, 'Stop')).reason).toContain('`.harness/hooks/dispatch.mjs`'); // a new change set blocks again
});

test('a removed or added file counts; unattended runs block the same way', async () => {
  const root = repo();
  await hook(root, 'PreToolUse', { CI: 'true' });
  writeFileSync(join(root, '.claude/settings.local.json'), '{"disableAllHooks":true}');
  const out = parsed(await hook(root, 'Stop', { CI: 'true' }));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('`.claude/settings.local.json`');
});

test('UserPromptSubmit shows the person a systemMessage and gives the model the same context', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.claude/settings.json'), '{"disableAllHooks":true}\n');
  const out = parsed(await hook(root, 'UserPromptSubmit'));
  expect(out.systemMessage).toContain('`.claude/settings.json`');
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
  expect(out.hookSpecificOutput.additionalContext).toContain('`.claude/settings.json`');
  expect(await hook(root, 'UserPromptSubmit')).toBe(''); // said once
});

test('changes written by the harness CLI (it stamps the new snapshot) do not trigger', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v2\n');
  stampHarnessFiles(root); // what init, update and uninstall do after writing
  expect(await hook(root, 'Stop')).toBe('');
  expect(await hook(root, 'UserPromptSubmit')).toBe('');
});

test('the change block counts within stop.max_attempts, so the session can always end', async () => {
  const root = repo('stop:\n  max_attempts: 1\n');
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/manifest.json'), '{"version":"2","createdAt":"x","files":[]}');
  expect(parsed(await hook(root, 'Stop')).decision).toBe('block');
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// again\n');
  expect(await hook(root, 'Stop')).toBe(''); // attempts used up: allowed, still logged
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed')).toHaveLength(2);
});

test('status and doctor show the last change event', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n# edit\n');
  await hook(root, 'Stop');
  let s = '';
  status([], { root, env: {}, out: (l) => (s += l + '\n') });
  expect(s).toMatch(/Harness files last changed during a session: .* \(`\.harness\/config\.yaml`\)/);
  let d = '';
  doctor([], { root, env: {}, out: (l) => (d += l + '\n') });
  expect(d).toMatch(/^note harness files changed during a session at .*: `\.harness\/config\.yaml`/m);
});

// Round 14 D2: a change between sessions is reported at the next session's first prompt and its Stop.
test('a change made between sessions is reported at the first prompt and blocks the next Stop once', async () => {
  const root = repo();
  await hook(root, 'UserPromptSubmit', {}, 's2');
  expect(await hook(root, 'Stop', {}, 's2')).toBe('');
  await hook(root, 'SessionEnd', {}, 's2');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n'); // no session open
  const p = parsed(await hook(root, 'UserPromptSubmit', {}, 's3'));
  expect(p.systemMessage).toContain('`.harness/config.yaml`');
  expect(p.hookSpecificOutput.additionalContext).toContain('`.harness/config.yaml`');
  expect(parsed(await hook(root, 'Stop', {}, 's3')).reason).toContain('`.harness/config.yaml`');
  expect(await hook(root, 'Stop', {}, 's3')).toBe('');
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed')).toHaveLength(1); // one event per change set
});
test('a change after the last Stop of a session, before it ends, is reported in the next session', async () => {
  const root = repo();
  await hook(root, 'UserPromptSubmit', {}, 'a');
  await hook(root, 'Stop', {}, 'a');
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// late\n');
  await hook(root, 'SessionEnd', {}, 'a');
  expect(parsed(await hook(root, 'Stop', {}, 'b')).reason).toContain('`.harness/hooks/dispatch.mjs`');
});
test('a fresh clone (no last-seen snapshot) starts from the files at the first hook', async () => {
  const root = repo();
  expect(await hook(root, 'UserPromptSubmit', {}, 'fresh')).toBe('');
  expect(await hook(root, 'Stop', {}, 'fresh')).toBe('');
});
// D3: only what harness relies on in the Claude settings files counts.
const DENY = 'Read(./secrets/**)';
const HOOKS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"' }] }] }, permissions: { deny: [DENY] } };
const MANIFEST = JSON.stringify({ version: '1', createdAt: 'x', files: [{ rel: '.claude/settings.json', kind: 'create', hash: 'x', blocks: [JSON.stringify({ deny: DENY })] }] });
test('an "Always allow" write to the settings does not trigger; removing a harness hook or deny rule does', async () => {
  const root = repo();
  writeFileSync(join(root, '.harness/manifest.json'), MANIFEST);
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(HOOKS, null, 2));
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] } }));
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ ...HOOKS, permissions: { allow: ['Bash(ls)'], deny: [DENY, 'Mine'] }, model: 'x' }, null, 2));
  expect(await hook(root, 'Stop')).toBe('');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ ...HOOKS, permissions: { deny: [] } }));
  expect(parsed(await hook(root, 'Stop')).reason).toContain('`.claude/settings.json`');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { deny: [] } }));
  expect(parsed(await hook(root, 'Stop')).reason).toContain('`.claude/settings.json`'); // the hook entry removed
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  expect(parsed(await hook(root, 'Stop')).reason).toContain('`.claude/settings.local.json`');
});
// D4: line endings don't count; the message names the session's start commit, and a moved HEAD.
test('a CRLF-only rewrite does not trigger', async () => {
  const root = repo('checks:\n  guard: true\n');
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\r\n  guard: true\r\n');
  expect(await hook(root, 'Stop')).toBe('');
});
test('the message names the start commit and says when HEAD moved', async () => {
  const { execFileSync } = await import('node:child_process');
  const root = repo();
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const start = git('rev-parse', 'HEAD');
  await hook(root, 'PreToolUse', {}, 'g');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n');
  git('commit', '-q', '-am', 'two');
  const r = parsed(await hook(root, 'Stop', {}, 'g')).reason as string;
  expect(r).toContain(`git diff ${start.slice(0, 12)} -- .harness .claude/settings.json`);
  expect(r).toContain('git diff -- .harness .claude/settings.json');
  expect(r).toMatch(/HEAD moved since the session started .*branch switch/);
});

// Round 16 F2: a change shown at a prompt, then undone before the next Stop, is reported at that Stop.
test('a change shown at a prompt and undone before the next Stop is reported once', async () => {
  const root = repo();
  await hook(root, 'UserPromptSubmit', {}, 'f2');
  expect(await hook(root, 'Stop', {}, 'f2')).toBe('');
  const cfg = join(root, '.harness/config.yaml');
  const before = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, 'checks:\n  guard: false\n'); // the person's edit between turns
  expect(parsed(await hook(root, 'UserPromptSubmit', {}, 'f2')).systemMessage).toContain('`.harness/config.yaml`');
  writeFileSync(cfg, before); // a script restores the previous config during the turn
  const r = parsed(await hook(root, 'Stop', {}, 'f2'));
  expect(r.decision).toBe('block');
  expect(r.reason).toContain('`.harness/config.yaml`');
  expect(r.reason).toMatch(/shown at the last prompt is no longer there/);
  expect(await hook(root, 'Stop', {}, 'f2')).toBe('');
  expect(await hook(root, 'UserPromptSubmit', {}, 'f2')).toBe('');
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed')).toHaveLength(2); // the edit, then its undoing
});
test('a change shown at a prompt and still there blocks the Stop once, with the usual message', async () => {
  const root = repo();
  await hook(root, 'PreToolUse', {}, 'f2b');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n');
  await hook(root, 'UserPromptSubmit', {}, 'f2b');
  const r = parsed(await hook(root, 'Stop', {}, 'f2b'));
  expect(r.reason).not.toMatch(/no longer there/);
  expect(await hook(root, 'Stop', {}, 'f2b')).toBe('');
});
test('a change shown at a prompt and undone before the session ends is reported in the next session', async () => {
  const root = repo();
  await hook(root, 'UserPromptSubmit', {}, 'f2c');
  await hook(root, 'Stop', {}, 'f2c');
  const cfg = join(root, '.harness/config.yaml');
  const before = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, 'checks:\n  guard: false\n');
  await hook(root, 'UserPromptSubmit', {}, 'f2c');
  writeFileSync(cfg, before);
  await hook(root, 'SessionEnd', {}, 'f2c');
  expect(parsed(await hook(root, 'Stop', {}, 'f2d')).reason).toContain('`.harness/config.yaml`');
});
test('G2: a change shown at a prompt and still there when the session ends gives the next session a notice and one Stop block', async () => {
  const root = repo();
  await hook(root, 'UserPromptSubmit', {}, 'g2a');
  await hook(root, 'Stop', {}, 'g2a');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n'); // the person's edit between turns
  expect(parsed(await hook(root, 'UserPromptSubmit', {}, 'g2a')).systemMessage).toContain('`.harness/config.yaml`');
  await hook(root, 'SessionEnd', {}, 'g2a'); // the change is still there
  expect(parsed(await hook(root, 'UserPromptSubmit', {}, 'g2b')).systemMessage).toContain('`.harness/config.yaml`');
  expect(parsed(await hook(root, 'Stop', {}, 'g2b')).reason).toContain('`.harness/config.yaml`');
  expect(await hook(root, 'Stop', {}, 'g2b')).toBe('');
});

// ConfigChange's guarded view (spec 3.3, C5): harness's hook groups, its deny rules, disableAllHooks and sandbox.
const GROUP = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'], onFailure: 'block' }] };
const FORCE = 'Bash(git push *--force*)';
const BASE = { hooks: { PreToolUse: [GROUP], Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['.harness/hooks/dispatch.mjs'] }] }] }, permissions: { allow: ['Bash(ls)'], deny: [FORCE, 'Mine'] }, sandbox: { enabled: true } };
const diffOf = (cur: unknown, deny: Set<string> | null = new Set([FORCE])) =>
  guardedDiff(guardedView(JSON.stringify(BASE), deny), guardedView(JSON.stringify(cur), deny));

test('guardedDiff reports only the guarded parts that changed', () => {
  expect(diffOf(BASE)).toEqual([]);
  expect(diffOf({ ...BASE, hooks: { Stop: BASE.hooks.Stop } })).toEqual(['hooks']); // a dispatcher group removed
  expect(diffOf({ ...BASE, hooks: { ...BASE.hooks, PreToolUse: [{ ...GROUP, hooks: [{ ...GROUP.hooks[0], onFailure: undefined }] }] } })).toEqual(['hooks']);
  expect(diffOf({ ...BASE, permissions: { deny: ['Mine'] } })).toEqual(['deny']); // a harness rule removed
  expect(diffOf({ ...BASE, permissions: { deny: ['Bash(git push --force)', 'Mine'] } })).toEqual(['deny']); // narrowed
  expect(diffOf({ ...BASE, permissions: { deny: [FORCE, 'Mine', 'Bash(rm *)'] } })).toEqual([]); // added
  expect(diffOf({ ...BASE, permissions: { deny: [FORCE] } })).toEqual([]); // a rule harness didn't install
  expect(diffOf({ ...BASE, disableAllHooks: true })).toEqual(['disableAllHooks']);
  expect(diffOf({ ...BASE, sandbox: { enabled: true, autoAllowBashIfSandboxed: true } })).toEqual(['sandbox']);
  expect(diffOf({ ...BASE, sandbox: undefined })).toEqual(['sandbox']);
  expect(diffOf({ ...BASE, permissions: { ...BASE.permissions, allow: ['Bash(ls)', 'Bash(pwd)'] } })).toEqual([]);
  expect(guardedDiff(guardedView(null, null), guardedView('{}', null))).toEqual([]); // absent is the empty view
  expect(guardedView('{not json', null)).toBeNull();
  expect(guardedDiff(guardedView('{}', null), null)).toEqual(['unreadable']);
});

test('change detection reports a sandbox change', () => {
  const root = repo();
  const before = snapshotHarnessFiles(root)['.claude/settings.json'];
  writeFileSync(join(root, '.claude/settings.json'), '{"sandbox":{"enabled":false}}');
  expect(snapshotHarnessFiles(root)['.claude/settings.json']).not.toBe(before);
});
