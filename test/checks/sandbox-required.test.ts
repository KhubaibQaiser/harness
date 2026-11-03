import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { sandboxRequired, sandboxVerdict } from '../../src/checks/sandbox-required.js';
import type { SandboxMode } from '../../src/core/config.js';
import { readEvents } from '../../src/core/events.js';
import type { Layer } from '../../src/core/settings-layers.js';
import { type Ctx, dispatch, registry } from '../../src/hooks/dispatch.js';

const MSG = "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`.";
const CONFIRMED = { sandbox: { enabled: true, allowUnsandboxedCommands: false } };
const layers = (l: Partial<Record<Layer['name'], unknown>>): Layer[] =>
  (['managed', 'local', 'project', 'user'] as const).map((name) => ({ name, json: l[name] ?? null }));
const v = (o: { mode?: SandboxMode; unattended?: boolean; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; layers?: Layer[] }) =>
  sandboxVerdict({ mode: 'unattended', unattended: true, platform: 'darwin', env: {}, layers: layers({}), ...o });

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
    const bin = mkdtempSync(join(tmpdir(), 'h-sb-bin-'));
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
    expect(registry.map((c) => c.name).slice(0, 3)).toEqual(['guard', 'protect', 'sandbox-required']);
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
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED));
    const opts = { home, managed, platform: 'darwin' as const };
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, {}, opts)).toBe('');
    writeFileSync(managed, JSON.stringify({ sandbox: { enabled: false } }));
    expect(JSON.parse(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, {}, opts)).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('the user layer is read from CLAUDE_CONFIG_DIR when it is set', async () => {
    const { root, home, managed } = setup();
    const cfg = mkdtempSync(join(tmpdir(), 'h-sb-cfg-'));
    writeFileSync(join(cfg, 'settings.json'), JSON.stringify(CONFIRMED));
    expect(await dispatch(call(root, 'Bash', { command: 'ls' }), registry, { CLAUDE_CONFIG_DIR: cfg }, { home, managed, platform: 'darwin' })).toBe('');
  });

  test('without a session baseline it denies, whatever the files on disk say', async () => {
    const { root, home, managed } = setup();
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(CONFIRMED));
    const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } };
    const ctx = { input, root, home, managed, platform: 'darwin', env: {}, unattended: true, config: { sandbox: 'unattended' }, state: {}, save() {} } as unknown as Ctx;
    expect(await sandboxRequired.run(ctx)).toEqual({ kind: 'deny', reason: MSG, check: 'sandbox-required' });
  });

  test('two unattended win32 calls in one session log one sandbox-unavailable event', async () => {
    const { root, ...opts } = setup();
    for (let i = 0; i < 2; i++) expect(await dispatch(call(root, 'PowerShell', { command: 'ls' }), [sandboxRequired], {}, { ...opts, platform: 'win32' })).toBe('');
    expect(readEvents(root).map((e) => [e.check, e.decision])).toEqual([['sandbox-required', 'sandbox-unavailable']]);
  });
});
