import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import { sandboxRequired, sandboxVerdict } from '../../src/checks/sandbox-required.js';
import type { SandboxMode } from '../../src/core/config.js';
import { readEvents } from '../../src/core/events.js';
import type { Layer } from '../../src/core/settings-layers.js';
import { type Ctx, dispatch, registry } from '../../src/hooks/dispatch.js';

const MSG = "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`.";
const STRICT_MSG =
  "Unattended `bypassPermissions` or plan-mode run without `sandbox.network.strictAllowlist: true`, so sandboxed commands can reach any host. Start it with the command in the README (Unattended runs and CI), or set the key in your user or managed settings (a repo's settings can't).";
const CONFIRMED = { sandbox: { enabled: true, allowUnsandboxedCommands: false } };
const STRICT = { sandbox: { network: { strictAllowlist: true } } };
const CONFIRMED_STRICT = { sandbox: { ...CONFIRMED.sandbox, ...STRICT.sandbox } };
const layers = (l: Partial<Record<Layer['name'], unknown>>): Layer[] =>
  (['managed', 'local', 'project', 'user'] as const).map((name) => ({ name, json: l[name] ?? null }));
const v = (o: { mode?: SandboxMode; unattended?: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; layers?: Layer[]; permissionMode?: string }) =>
  sandboxVerdict({ mode: 'unattended', unattended: true, platform: 'darwin', env: {}, layers: layers({}), permissionMode: 'dontAsk', ...o });

describe('sandboxVerdict', () => {
  test('attended allows', () => expect(v({ unattended: false })).toBe('allow'));
  test('off allows', () => expect(v({ mode: 'off' })).toBe('allow'));
  test('no sandbox denies', () => expect(v({})).toBe('deny'));
  test('win32 is unavailable', () => expect(v({ platform: 'win32' })).toBe('unavailable'));
  test('HARNESS_SANDBOX=1 allows, true does not', () => {
    expect(v({ env: { HARNESS_SANDBOX: '1' } })).toBe('allow');
    expect(v({ env: { HARNESS_SANDBOX: 'true' } })).toBe('deny');
  });
  test('project enabled and no unsandboxed commands allows on darwin', () => expect(v({ layers: layers({ project: CONFIRMED }) })).toBe('allow'));
  test('linux also needs bwrap and socat on PATH', () => {
    // A relative dir: a linux PATH splits at ':', so a Windows host's drive-letter temp path would not survive the split.
    mkdirSync('node_modules/.cache', { recursive: true });
    const bin = mkdtempSync(join('node_modules', '.cache', 'h-sb-bin-'));
    onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
    const l = layers({ project: CONFIRMED });
    expect(v({ platform: 'linux', layers: l, env: { PATH: bin } })).toBe('deny');
    for (const n of ['bwrap', 'socat']) {
      writeFileSync(join(bin, n), '#!/bin/sh\n');
      chmodSync(join(bin, n), 0o755);
      if (n === 'bwrap') expect(v({ platform: 'linux', layers: l, env: { PATH: bin } }), 'bwrap without socat').toBe('deny');
    }
    expect(v({ platform: 'linux', layers: l, env: { PATH: bin } })).toBe('allow');
  });
  test('enabled without allowUnsandboxedCommands false denies', () => expect(v({ layers: layers({ project: { sandbox: { enabled: true } } }) })).toBe('deny'));
});

describe('bypassPermissions needs strictAllowlist', () => {
  const bp = (o: Parameters<typeof v>[0]) => v({ permissionMode: 'bypassPermissions', ...o });
  test('a confirmed sandbox without strictAllowlist is no-strict', () => expect(bp({ layers: layers({ project: CONFIRMED }) })).toBe('no-strict'));
  test('a repo strictAllowlist does not count', () =>
    expect(bp({ layers: layers({ project: CONFIRMED_STRICT, local: STRICT }) })).toBe('no-strict'));
  test('a user strictAllowlist allows', () => expect(bp({ layers: layers({ project: CONFIRMED, user: STRICT }) })).toBe('allow'));
  test('a managed strictAllowlist allows, even over a user false', () =>
    expect(bp({ layers: layers({ project: CONFIRMED, managed: STRICT, user: { sandbox: { network: { strictAllowlist: false } } } }) })).toBe('allow'));
  test('a user true counts over a managed false', () =>
    expect(bp({ layers: layers({ project: CONFIRMED, managed: { sandbox: { network: { strictAllowlist: false } } }, user: STRICT }) })).toBe('allow'));
  test('HARNESS_SANDBOX=1 stands for the documented --settings, strictAllowlist included', () =>
    expect(bp({ env: { HARNESS_SANDBOX: '1' } })).toBe('allow'));
  test('no sandbox at all is the plain deny', () => expect(bp({ layers: layers({ user: STRICT }) })).toBe('deny'));
  test.each(['dontAsk', 'default', 'acceptEdits', 'auto'])('permission mode %s is unchanged', (permissionMode) =>
    expect(v({ permissionMode, layers: layers({ project: CONFIRMED }) })).toBe('allow'));
  // plan mode can carry bypass, which the hook can't see; a missing mode fails closed like the check itself.
  test.each(['plan', undefined])('permission mode %s also needs strictAllowlist', (permissionMode) => {
    expect(v({ permissionMode, layers: layers({ project: CONFIRMED }) })).toBe('no-strict');
    expect(v({ permissionMode, layers: layers({ project: CONFIRMED, user: STRICT }) })).toBe('allow');
  });
  test('a managed allowManagedDomainsOnly counts; a user or repo one does not', () => {
    const only = { sandbox: { network: { allowManagedDomainsOnly: true } } };
    expect(bp({ layers: layers({ project: CONFIRMED, managed: only }) })).toBe('allow');
    expect(bp({ layers: layers({ project: CONFIRMED, user: only }) })).toBe('no-strict');
    expect(bp({ layers: layers({ project: CONFIRMED_STRICT, local: only }) })).toBe('no-strict');
  });
});

describe('precedence', () => {
  test('local sandbox.enabled false beats committed always', () =>
    expect(v({ layers: layers({ project: CONFIRMED, local: { sandbox: { enabled: false } } }) })).toBe('deny'));
  test('managed true beats local false', () =>
    expect(v({ layers: layers({ managed: CONFIRMED, local: { sandbox: { enabled: false } } }) })).toBe('allow'));
  test('user-only true allows', () => expect(v({ layers: layers({ user: CONFIRMED }) })).toBe('allow'));
});

describe('the check', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'h-sb-root-'));
    const home = mkdtempSync(join(tmpdir(), 'h-sb-home-'));
    mkdirSync(join(root, '.git'));
    return { root, home, managed: join(home, 'managed.json') };
  };
  const call = (root: string, tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: root, permission_mode: 'bypassPermissions', tool_name, tool_input });

  test('is registered after protect, fail-closed, on PreToolUse', () => {
    expect(registry.map((c) => c.name).slice(0, 5)).toEqual(['guard', 'pr-size', 'protect', 'task', 'sandbox-required']);
    expect(sandboxRequired.failClosed).toBe(true);
    expect(sandboxRequired.events).toEqual(['PreToolUse']);
    expect(sandboxRequired.pure).toBeFalsy();
  });

  test.each(['Bash', 'PowerShell', 'Monitor'])('unattended %s is denied with the exact message', async (tool) => {
    const { root, ...opts } = setup();
    const out = JSON.parse(await dispatch(call(root, tool, { command: 'ls' }), [sandboxRequired], {}, { ...opts, platform: 'darwin' }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(MSG);
    expect(readEvents(root).map((e) => [e.check, e.decision])).toEqual([['sandbox-required', 'deny']]);
  });

  test('a degraded run (no config) still gets the exact deny message', async () => {
    const { root, home, managed } = setup();
    const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } };
    const ctx = { input, root, home, managed, platform: 'darwin', env: {}, unattended: true, config: undefined, state: undefined, save() {} } as unknown as Ctx;
    expect(await sandboxRequired.run(ctx)).toEqual({ kind: 'deny', reason: MSG, check: 'sandbox-required' });
  });

  test('an unattended Edit is allowed', async () => {
    const { root, ...opts } = setup();
    expect(await dispatch(call(root, 'Edit', { file_path: 'a.ts' }), [sandboxRequired], {}, { ...opts, platform: 'darwin' })).toBe('');
  });

  test('C1: a Write to the user settings mid-session does not turn the requirement off', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    const opts = { home, managed, platform: 'darwin' as const };
    const bash = async () => JSON.parse((await dispatch(call(root, 'Bash', { command: 'ls' }), registry, {}, opts)) || '{}').hookSpecificOutput?.permissionDecision;
    const user = join(home, '.claude/settings.json');
    expect(await bash()).toBe('deny');
    expect(await dispatch(call(root, 'Write', { file_path: user, content: JSON.stringify(CONFIRMED) }), registry, {}, opts)).toBe('');
    writeFileSync(user, JSON.stringify(CONFIRMED)); // what the allowed Write does
    const cc = JSON.stringify({ hook_event_name: 'ConfigChange', session_id: 's', cwd: root, source: 'user_settings', file_path: user });
    expect(JSON.parse(await dispatch(cc, registry, {}, opts)).decision).toBe('block');
    expect(await bash()).toBe('deny');
  });

  test('a sandbox confirmed at the session start allows; managed is still read from disk', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED_STRICT));
    const opts = { home, managed, platform: 'darwin' as const };
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, {}, opts)).toBe('');
    writeFileSync(managed, JSON.stringify({ sandbox: { enabled: false } }));
    expect(JSON.parse(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, {}, opts)).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('the user layer is read from CLAUDE_CONFIG_DIR when it is set', async () => {
    const { root, home, managed } = setup();
    const cfg = mkdtempSync(join(tmpdir(), 'h-sb-cfg-'));
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify(CONFIRMED_STRICT));
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, { CLAUDE_CONFIG_DIR: cfg }, { home, managed, platform: 'darwin' })).toBe('');
  });

  test('the user layer is read from the HARNESS_CLAUDE_CONFIG_DIR mirror', async () => {
    const { root, home, managed } = setup();
    const cfg = mkdtempSync(join(tmpdir(), 'h-sb-mirror-'));
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify(CONFIRMED_STRICT));
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, { HARNESS_CLAUDE_CONFIG_DIR: cfg }, { home, managed, platform: 'darwin' })).toBe('');
  });

  test.each(['settings.json', 'settings.local.json'])('a mirror that the repo %s sets in env is ignored', async (file) => {
    const { root, home, managed } = setup();
    const cfg = mkdtempSync(join(tmpdir(), 'h-sb-mirror-'));
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify(CONFIRMED_STRICT));
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude', file), JSON.stringify({ env: { HARNESS_CLAUDE_CONFIG_DIR: cfg } }));
    const out = await dispatch(call(root, 'Bash', { command: 'ls' }), registry, { HARNESS_CLAUDE_CONFIG_DIR: cfg }, { home, managed, platform: 'darwin' });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('HARNESS_SANDBOX is ignored when a settings file sets it in env', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ env: { HARNESS_SANDBOX: '1' } }));
    const out = await dispatch(call(root, 'Bash', { command: 'ls' }), registry, { HARNESS_SANDBOX: '1' }, { home, managed, platform: 'darwin' });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('without a session baseline, HARNESS_SANDBOX=1 still denies', async () => {
    const { root, home, managed } = setup();
    const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } };
    const ctx = { input, root, home, managed, platform: 'darwin', env: { HARNESS_SANDBOX: '1' }, unattended: true, config: { sandbox: 'unattended' }, state: {}, save() {} } as unknown as Ctx;
    expect(await sandboxRequired.run(ctx)).toEqual({ kind: 'deny', reason: MSG, check: 'sandbox-required' });
  });

  test('without a session baseline it denies, whatever the files on disk say', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED));
    const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } };
    const ctx = { input, root, home, managed, platform: 'darwin', env: {}, unattended: true, config: { sandbox: 'unattended' }, state: {}, save() {} } as unknown as Ctx;
    expect(await sandboxRequired.run(ctx)).toEqual({ kind: 'deny', reason: MSG, check: 'sandbox-required' });
  });

  test('bypassPermissions with a confirmed sandbox but no strictAllowlist is denied with the strict message', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED));
    const out = JSON.parse(await dispatch(call(root, 'Bash', { command: 'ls' }), [sandboxRequired], {}, { home, managed, platform: 'darwin' }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe(STRICT_MSG);
  });

  test('dontAsk with the same settings is allowed', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED));
    const input = JSON.parse(call(root, 'Bash', { command: 'ls' }));
    expect(await dispatch(JSON.stringify({ ...input, permission_mode: 'dontAsk' }), [sandboxRequired], {}, { home, managed, platform: 'darwin' })).toBe('');
  });

  test('bypassPermissions with HARNESS_SANDBOX=1 from the launcher is allowed', async () => {
    const { root, home, managed } = setup();
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), [sandboxRequired], { HARNESS_SANDBOX: '1' }, { home, managed, platform: 'darwin' })).toBe('');
  });

  test('two unattended win32 calls in one session log one sandbox-unavailable event', async () => {
    const { root, ...opts } = setup();
    for (let i = 0; i < 2; i++) expect(await dispatch(call(root, 'PowerShell', { command: 'ls' }), [sandboxRequired], {}, { ...opts, platform: 'win32' })).toBe('');
    expect(readEvents(root).map((e) => [e.check, e.decision])).toEqual([['sandbox-required', 'sandbox-unavailable']]);
  });
});
