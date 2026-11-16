import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const SANDBOX_BLOCKS = [{ set: ['sandbox'], value: {} }, { set: ['sandbox', 'enabled'], value: true }];
const repo = (blocks: object[] = []) => {
  const root = mkdtempSync(join(tmpdir(), 'h-cc-'));
  const home = mkdtempSync(join(tmpdir(), 'h-cc-home-'));
  mkdirSync(join(root, '.harness/hooks'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n');
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ version: '1', createdAt: 'x', files: [{ rel: '.claude/settings.json', kind: 'create', hash: 'x', blocks: [{ deny: FORCE }, ...blocks].map((b) => JSON.stringify(b)) }] }));
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v1\n');
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(SETTINGS));
  writeFileSync(join(home, '.claude/settings.json'), '{}');
  return { root, home };
};
type Repo = ReturnType<typeof repo>;
const run = (r: Repo, input: Record<string, unknown>) => dispatch(JSON.stringify({ ...input, session_id: 's', cwd: r.root }), registry, {}, { home: r.home });
const userFile = (dir: string) => ({ ...FIXTURE.user_settings, file_path: join(dir, 'settings.json') });
const change = (r: Repo, source: string) => run(r, source === 'user_settings' ? userFile(join(r.home, '.claude')) : FIXTURE[source]);
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
  expect(out).toEqual({ decision: 'block', reason: 'Harness keeps its own hooks, deny rules, sandbox keys and hook-steering `env` keys as they were when this session started, and disableAllHooks off, so this change to `.claude/settings.json` (hooks) is not applied to the session. Ask the person to make this change outside the session.' });
  expect(readEvents(r.root).filter((e) => e.decision === 'config-change-blocked').map((e) => e.reason)).toEqual(['.claude/settings.json: hooks']);
  expect(lastConfigChangeBlocked(r.root)?.reason).toBe('.claude/settings.json: hooks');
  const notice = 'Harness blocked a change to `.claude/settings.json` (hooks): the whole file change was held for this session, not only those parts. The file is still changed on disk, so the next session loads it: review it first.';
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

test('with CLAUDE_CONFIG_DIR set, disableAllHooks in that dir\'s settings is blocked', async () => {
  const r = repo();
  const cfg = mkdtempSync(join(tmpdir(), 'h-cc-cfg-'));
  write(join(cfg, 'settings.json'), {});
  const env = { CLAUDE_CONFIG_DIR: cfg };
  const go = (input: Record<string, unknown>) => dispatch(JSON.stringify({ ...input, session_id: 's', cwd: r.root }), registry, env, { home: r.home });
  await go({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  write(join(cfg, 'settings.json'), { disableAllHooks: true });
  expect(parsed(await go(userFile(cfg))).reason).toContain(`this change to \`${join(cfg, 'settings.json')}\` (disableAllHooks)`);
});

test('with only the HARNESS_CLAUDE_CONFIG_DIR mirror set (the env scrub strips CLAUDE_CONFIG_DIR), that dir is watched', async () => {
  const r = repo();
  const cfg = mkdtempSync(join(tmpdir(), 'h-cc-mirror-'));
  write(join(cfg, 'settings.json'), {});
  const go = (input: Record<string, unknown>) =>
    dispatch(JSON.stringify({ ...input, session_id: 's', cwd: r.root }), registry, { HARNESS_CLAUDE_CONFIG_DIR: cfg }, { home: r.home });
  await go({ hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  write(join(cfg, 'settings.json'), { disableAllHooks: true });
  expect(parsed(await go(userFile(cfg))).reason).toContain(`this change to \`${join(cfg, 'settings.json')}\` (disableAllHooks)`);
});

test('R-1: a user-settings change in a file harness does not watch is blocked, naming both paths', async () => {
  const r = repo();
  await prompt(r);
  const other = mkdtempSync(join(tmpdir(), 'h-cc-other-')); // a CLAUDE_CONFIG_DIR the scrub hid from the hooks
  const out = parsed(await run(r, userFile(other)));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain(`this change to \`${join(other, 'settings.json')}\` (not the watched \`~/.claude/settings.json\`: launch with HARNESS_CLAUDE_CONFIG_DIR set)`);
});

test('R-1: an unguarded change in the watched user file, or one reported without file_path, is still judged by its diff', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { theme: 'dark' });
  expect(await change(r, 'user_settings')).toBe('');
  const { file_path: _, ...bare } = FIXTURE.user_settings;
  expect(await run(r, bare)).toBe('');
});

test('S-1: a reported ~/.claude/settings.json is the watched file in the default setup', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { theme: 'dark' });
  expect(await run(r, { ...FIXTURE.user_settings, file_path: '~/.claude/settings.json' })).toBe('');
});

test('S-2: a reported path that differs only in case is the watched file on a case-insensitive filesystem', async ({ skip }) => {
  const r = repo();
  if (!existsSync(join(r.home, '.CLAUDE'))) skip(); // case-sensitive filesystem: the two names are different files
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { theme: 'dark' });
  expect(await run(r, userFile(join(r.home, '.CLAUDE')))).toBe('');
});

test('an env change in the user file is blocked', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { env: { HARNESS_SANDBOX: '1' } });
  expect(parsed(await change(r, 'user_settings')).reason).toContain('this change to `~/.claude/settings.json` (env)');
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
  write(join(r.home, '.claude/settings.json'), { disableAllHooks: true });
  stampHarnessFiles(r.root);
  expect(parsed(await change(r, 'user_settings')).reason).toContain('(disableAllHooks)');
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

test('no baseline: a weakening change blocks, judged against the manifest; the baseline is then taken once', async () => {
  const r = repo();
  // The session's first hook is the ConfigChange itself: the local file is judged against an empty file.
  write(join(r.root, '.claude/settings.local.json'), { disableAllHooks: true });
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('`.claude/settings.local.json` (disableAllHooks)');
  expect(readState(r.root, 's').guardedBase).toBeUndefined();
  await prompt(r); // the next other hook takes the baseline, once
  const base = readState(r.root, 's').guardedBase;
  expect(base?.project?.deny).toEqual([FORCE]);
  write(join(r.root, '.claude/settings.json'), {});
  await prompt(r);
  expect(readState(r.root, 's').guardedBase).toEqual(base);
});

test('a mid-session uninstall is allowed: the CLI records the settings it leaves, absent included', async () => {
  const r = repo();
  await prompt(r);
  rmSync(join(r.root, '.claude/settings.json')); // what uninstall leaves when harness created the file
  stampHarnessFiles(r.root);
  expect(await change(r, 'project_settings')).toBe('');
  expect(readEvents(r.root).some((e) => e.decision === 'config-change-blocked')).toBe(false);
});

test('a script that strips the project file to {} after the CLI record is blocked', async () => {
  const r = repo();
  stampHarnessFiles(r.root); // install-time record of the full settings
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), {});
  expect(parsed(await change(r, 'project_settings')).reason).toContain('`.claude/settings.json` (hooks, deny)');
});

test('a CLI record for the local file does not let a later script change sandbox there', async () => {
  const r = repo(SANDBOX_BLOCKS);
  write(join(r.root, '.claude/settings.local.json'), { permissions: { allow: ['Bash(ls)'] } });
  stampHarnessFiles(r.root);
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { permissions: { allow: ['Bash(ls)'] }, sandbox: { enabled: false } });
  expect(parsed(await change(r, 'local_settings')).reason).toContain('`.claude/settings.local.json` (sandbox)');
});

test('the same blocked change twice leaves the notice once', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, disableAllHooks: true });
  await change(r, 'project_settings');
  await change(r, 'project_settings');
  expect(readState(r.root, 's').pendingNotice).toBe('Harness blocked a change to `.claude/settings.json` (disableAllHooks): the whole file change was held for this session, not only those parts. The file is still changed on disk, so the next session loads it: review it first.');
});

test('a harness deny rule rewritten narrower is blocked (C5)', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, permissions: { deny: ['Bash(git push --force)'] } });
  expect(parsed(await change(r, 'project_settings')).reason).toContain('`.claude/settings.json` (deny)');
  expect(lastConfigChangeBlocked(r.root)?.reason).toBe('.claude/settings.json: deny');
});

test('a CLI record from before the session never allows restoring its state over a later edit', async () => {
  const r = repo(SANDBOX_BLOCKS);
  stampHarnessFiles(r.root); // init or update records the project file
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { enabled: true } }); // the person's edit between sessions
  await prompt(r); // new session: baseline has the sandbox
  write(join(r.root, '.claude/settings.json'), SETTINGS); // a script restores the CLI's state
  expect(parsed(await change(r, 'project_settings')).reason).toContain('`.claude/settings.json` (sandbox)');
});

// The record's id check (only a CLI run after the baseline counts) is covered by the before-the-session test above.
test('a CLI record accepted mid-session for the project file does not cover a blocked change in the local file', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { disableAllHooks: true }); // a script's change, blocked
  expect(parsed(await change(r, 'local_settings'))?.decision).toBe('block');
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, hooks: { ...SETTINGS.hooks, Stop: [GROUP] } }); // harness update
  stampHarnessFiles(r.root); // its record also holds the local file as it is now
  expect(await change(r, 'project_settings')).toBe('');
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('`.claude/settings.local.json` (disableAllHooks)');
});

test('a CLI record never covers the local file: a blocked change recorded mid-session still blocks when it fires first', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { disableAllHooks: true }); // a script's change, blocked
  expect(parsed(await change(r, 'local_settings'))?.decision).toBe('block');
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, hooks: { ...SETTINGS.hooks, Stop: [GROUP] } }); // harness update
  stampHarnessFiles(r.root);
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('`.claude/settings.local.json` (disableAllHooks)');
  expect(await change(r, 'project_settings')).toBe('');
});

test('a user env MCP token added applies, in the user and the project file', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { env: { MCP_TOKEN: 'abc' } });
  expect(await change(r, 'user_settings')).toBe('');
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, env: { ANTHROPIC_MODEL: 'x' } });
  expect(await change(r, 'project_settings')).toBe('');
  expect(readEvents(r.root).some((e) => e.decision === 'config-change-blocked')).toBe(false);
});

const MINE = { hooks: [{ type: 'command', command: 'echo done' }] };
test('a hook added to any settings file is held; editing or removing the person\'s own hook applies (owner, 2026-11-16)', async () => {
  const r = repo();
  write(join(r.root, '.claude/settings.local.json'), { hooks: { Stop: [MINE] } });
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, hooks: { ...SETTINGS.hooks, Stop: [MINE] } });
  expect(parsed(await change(r, 'project_settings'))?.reason).toContain('`.claude/settings.json` (newHooks)');
  write(join(r.home, '.claude/settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo new' }] }] } });
  expect(parsed(await change(r, 'user_settings'))?.reason).toContain('(newHooks)');
  write(join(r.root, '.claude/settings.local.json'), { hooks: { Stop: [{ hooks: [{ ...MINE.hooks[0], timeout: 30 }] }] } });
  expect(await change(r, 'local_settings')).toBe('');
  write(join(r.root, '.claude/settings.local.json'), {});
  expect(await change(r, 'local_settings')).toBe('');
});

test('an excludedCommands entry added in the local file is held; removing one applies (owner M3)', async () => {
  const r = repo();
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { excludedCommands: ['docker'] } });
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { excludedCommands: ['docker', 'python3'] } });
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('(excludedCommands)');
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { excludedCommands: [] } });
  expect(await change(r, 'local_settings')).toBe('');
});

test('HOME set in the user file env is held (owner M2)', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { env: { HOME: '/tmp/x' } });
  expect(parsed(await change(r, 'user_settings'))?.reason).toContain('(env)');
});

test('a /sandbox-style local network.allowedDomains edit applies', async () => {
  const r = repo(SANDBOX_BLOCKS);
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { enabled: true, network: { allowedDomains: ['registry.npmjs.org'] } } });
  expect(await change(r, 'local_settings')).toBe('');
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { enabled: false } });
  expect(parsed(await change(r, 'local_settings')).reason).toContain('`.claude/settings.local.json` (sandbox)');
});

test('a change with no baseline that keeps every harness entry applies', async () => {
  // The manifest records harness's hook groups: with no baseline, a hook it doesn't record counts as added.
  const r = repo([{ event: 'PreToolUse', group: SETTINGS.hooks.PreToolUse[0] }, { event: 'ConfigChange', group: GROUP }]);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, env: { MCP_TOKEN: 'x' }, permissions: { deny: [FORCE], allow: ['Bash(ls)'] } });
  expect(await change(r, 'project_settings')).toBe('');
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, permissions: { deny: [] } });
  expect(parsed(await change(r, 'project_settings')).reason).toContain('`.claude/settings.json` (deny)');
});

test('no baseline and no readable manifest blocks', async () => {
  const r = repo();
  write(join(r.root, '.harness/manifest.json'), '{');
  expect(parsed(await change(r, 'project_settings')).reason).toContain('(no session baseline)');
});

test('the pending notice names only the weakened parts and says the whole file change was held for this session', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { env: { MCP_TOKEN: 'x', NODE_OPTIONS: '--require x.js' }, permissions: { allow: ['Bash(ls)'] } });
  expect(parsed(await change(r, 'local_settings'))?.decision).toBe('block');
  expect(readState(r.root, 's').pendingNotice).toBe('Harness blocked a change to `.claude/settings.local.json` (env): the whole file change was held for this session, not only those parts. The file is still changed on disk, so the next session loads it: review it first.');
});

// Review H1 with a known manifest: the effective value counts, and changes already applied this session count too.
test('H1: two allowed removals that together turn the sandbox off: the second is blocked', async () => {
  const r = repo();
  write(join(r.home, '.claude/settings.json'), {});
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { enabled: true } });
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { enabled: true } });
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), SETTINGS); // local still turns it on: applies
  expect(await change(r, 'project_settings')).toBe('');
  write(join(r.root, '.claude/settings.local.json'), {}); // now nothing turns it on
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('`.claude/settings.local.json` (sandbox)');
});

test('H1: a local allowUnsandboxedCommands true over the project file\'s false is blocked', async () => {
  const r = repo();
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { enabled: true, allowUnsandboxedCommands: false } });
  await prompt(r);
  write(join(r.root, '.claude/settings.local.json'), { sandbox: { allowUnsandboxedCommands: true } });
  expect(parsed(await change(r, 'local_settings'))?.reason).toContain('(sandbox)');
});

// Review M1: what harness owns comes from the session start; a manifest that breaks or loses records mid-session blocks.
const DW = './.harness/hooks';
const owning = () => {
  const r = repo([{ set: ['sandbox', 'autoAllowBashIfSandboxed'], value: false }, { denyWrite: DW }]);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: false, filesystem: { denyWrite: [DW] } } });
  return r;
};
const manifest = (r: Repo, blocks: object[]) =>
  write(join(r.root, '.harness/manifest.json'), { version: '1', createdAt: 'x', files: [{ rel: '.claude/settings.json', kind: 'create', hash: 'x', blocks: blocks.map((b) => JSON.stringify(b)) }] });

test('M1: a manifest made unreadable mid-session blocks, even an MCP token change', async () => {
  const r = owning();
  await prompt(r);
  write(join(r.root, '.harness/manifest.json'), '{');
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: false, filesystem: { denyWrite: [DW] } }, env: { MCP_TOKEN: 'x' } });
  expect(parsed(await change(r, 'project_settings'))?.reason).toContain('harness manifest unreadable or missing records');
});

test('M1: a spoofed manifest that drops harness records does not unguard them', async () => {
  const r = owning();
  await prompt(r);
  manifest(r, [{ deny: FORCE }]); // the sandbox and denyWrite records are gone
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: true, filesystem: { denyWrite: [] } } });
  const reason = parsed(await change(r, 'project_settings'))?.reason;
  expect(reason).toContain('sandbox, denyWrite');
  expect(reason).toContain('harness manifest unreadable or missing records');
});

test('M1: a manifest unreadable at the session start: every sandbox change blocks, as before CC7', async () => {
  const r = owning();
  write(join(r.root, '.harness/manifest.json'), '{');
  await prompt(r);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: false, filesystem: { denyWrite: [DW] }, network: { allowedDomains: ['x.dev'] } } });
  expect(parsed(await change(r, 'project_settings'))?.reason).toContain('(sandbox)');
});

test('M1: a manifest that only gains records (a harness update) does not block an allowed change', async () => {
  const r = owning();
  await prompt(r);
  manifest(r, [{ deny: FORCE }, { set: ['sandbox', 'autoAllowBashIfSandboxed'], value: false }, { denyWrite: DW }, { deny: 'Bash(x)' }]);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: false, filesystem: { denyWrite: [DW] } }, env: { MCP_TOKEN: 'x' } });
  expect(await change(r, 'project_settings')).toBe('');
});

test('R2-M1: a conflicting record appended to the manifest mid-session doesn\'t override the session-start value', async () => {
  const OWN = { set: ['sandbox', 'autoAllowBashIfSandboxed'], value: false };
  const r = repo([OWN]);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: false } });
  await prompt(r);
  manifest(r, [{ deny: FORCE }, OWN, { set: ['sandbox', 'autoAllowBashIfSandboxed'], value: true }]);
  write(join(r.root, '.claude/settings.json'), { ...SETTINGS, sandbox: { autoAllowBashIfSandboxed: true } });
  expect(parsed(await change(r, 'project_settings'))?.reason).toContain('`.claude/settings.json` (sandbox)');
});

test('owner round 3: enableWeakerNestedSandbox turned on in the user file is held', async () => {
  const r = repo();
  await prompt(r);
  write(join(r.home, '.claude/settings.json'), { sandbox: { enableWeakerNestedSandbox: true } });
  expect(parsed(await change(r, 'user_settings'))?.reason).toContain('(sandbox)');
});
