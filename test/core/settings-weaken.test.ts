import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { guardedView } from '../../src/core/harness-files.js';
import { GUARDED_ENV, type Owned, ownedSettings, weakened } from '../../src/core/settings-weaken.js';

// Plan ruling R11 (CC7): a settings change weakens harness only when it removes or loosens what harness owns.
const FORCE = 'Bash(git push *--force*)';
const USER_DENY = 'Bash(rm -rf /tmp/x)';
const H = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'], timeout: 10, onFailure: 'block' };
const GROUP = { matcher: 'Bash', hooks: [H] };
const MINE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
const OWNED: Owned = {
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
  denyWrite: ['./.harness'],
  deny: new Set([FORCE]),
  hookGroups: [JSON.stringify({ event: 'PreToolUse', group: GROUP })],
};
const FULL = {
  hooks: { PreToolUse: [GROUP] },
  permissions: { deny: [FORCE, USER_DENY] },
  sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { denyWrite: ['./.harness'] } },
};
const view = (o: unknown) => guardedView(typeof o === 'string' ? o : JSON.stringify(o), OWNED.deny);

test.each([
  ['disableAllHooks true weakens', {}, { disableAllHooks: true }, ['disableAllHooks']],
  ['disableAllHooks false does not', {}, { disableAllHooks: false }, []],
  ['local sandbox.enabled false weakens when harness wrote enabled', {}, { sandbox: { enabled: false } }, ['sandbox']],
  ['local sandbox.enabled true does not', {}, { sandbox: { enabled: true } }, []],
  ['project sandbox.enabled removed weakens', FULL, { ...FULL, sandbox: { filesystem: FULL.sandbox.filesystem } }, ['sandbox']],
  ['network.allowedDomains added does not', FULL, { ...FULL, sandbox: { ...FULL.sandbox, network: { allowedDomains: ['example.com'] } } }, []],
  ['excludedCommands added does not', FULL, { ...FULL, sandbox: { ...FULL.sandbox, excludedCommands: ['docker'] } }, []],
  ['a harness denyWrite path removed weakens', FULL, { ...FULL, sandbox: { ...FULL.sandbox, filesystem: { denyWrite: [] } } }, ['denyWrite']],
  ['a denyWrite path added does not', FULL, { ...FULL, sandbox: { ...FULL.sandbox, filesystem: { denyWrite: ['./.harness', './x'] } } }, []],
  ['a harness deny rule removed weakens', FULL, { ...FULL, permissions: { deny: [USER_DENY] } }, ['deny']],
  ['a user deny rule removed does not', FULL, { ...FULL, permissions: { deny: [FORCE] } }, []],
  ['the user\'s own hook added does not', FULL, { ...FULL, hooks: { PreToolUse: [GROUP, MINE], Stop: [MINE] } }, []],
  ['the user\'s own hook removed does not', { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, FULL, []],
  ['a harness hook group removed weakens', FULL, { ...FULL, hooks: {} }, ['hooks']],
  ['a harness hook group\'s onFailure changed weakens', FULL, { ...FULL, hooks: { PreToolUse: [{ ...GROUP, hooks: [{ ...H, onFailure: 'continue' }] }] } }, ['hooks']],
  ['NODE_OPTIONS added weakens', {}, { env: { NODE_OPTIONS: '--require x.js' } }, ['env']],
  ['a guarded prefix key changed weakens', { env: { GIT_DIR: 'a' } }, { env: { GIT_DIR: 'b' } }, ['env']],
  ['a guarded key removed weakens', { env: { PATH: '/bin' } }, {}, ['env']],
  ['a guarded key in another case weakens', {}, { env: { node_options: '--require x.js' } }, ['env']],
  ['MCP_TOKEN added does not', {}, { env: { MCP_TOKEN: 'abc' } }, []],
  ['ANTHROPIC_MODEL changed does not', { env: { ANTHROPIC_MODEL: 'a' } }, { env: { ANTHROPIC_MODEL: 'b' } }, []],
  ['unreadable JSON is [\'unreadable\']', {}, '{"disableAllHooks": true,', ['unreadable']],
])('%s', (_, base, cur, want) => {
  expect(weakened(view(base), view(cur), OWNED)).toEqual(want);
});

// Owner answer OQ1 = A (2026-11-16): the keys sandbox-required relies on stay guarded in any file, whoever wrote them.
const NONE: Owned = { sandbox: {}, denyWrite: [], deny: new Set(), hookGroups: [] };
const STRICT = { sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { strictAllowlist: true, allowManagedDomainsOnly: true } } };
const without = (patch: Record<string, unknown>, net: Record<string, unknown> = {}) => ({ sandbox: { ...STRICT.sandbox, ...patch, network: { ...STRICT.sandbox.network, ...net } } });
test.each([
  ['enabled true to false weakens, though harness did not write it', STRICT, without({ enabled: false }), ['sandbox']],
  ['enabled true removed weakens', STRICT, without({ enabled: undefined }), ['sandbox']],
  ['allowUnsandboxedCommands false to true weakens', STRICT, without({ allowUnsandboxedCommands: true }), ['sandbox']],
  ['network.strictAllowlist true to false weakens', STRICT, without({}, { strictAllowlist: false }), ['sandbox']],
  ['network.allowManagedDomainsOnly true removed weakens', STRICT, without({}, { allowManagedDomainsOnly: undefined }), ['sandbox']],
  ['the whole sandbox removed weakens', STRICT, {}, ['sandbox']],
  ['enabled false to true does not', { sandbox: { enabled: false } }, { sandbox: { enabled: true } }, []],
  ['strictAllowlist added does not', {}, { sandbox: { network: { strictAllowlist: true } } }, []],
  ['allowedDomains changed with the trusted keys kept does not', STRICT, without({}, { allowedDomains: ['example.com'] }), []],
])('trusted sandbox key: %s', (_, base, cur, want) => {
  expect(weakened(view(base), view(cur), NONE)).toEqual(want);
});

test('no baseline: a file with every harness entry passes', () => {
  expect(weakened(undefined, view({ ...FULL, permissions: { deny: [FORCE] }, env: { MCP_TOKEN: 'x' } }), OWNED)).toEqual([]);
});

test('no baseline: missing harness deny weakens', () => {
  expect(weakened(undefined, view({ ...FULL, permissions: { deny: [] } }), OWNED)).toEqual(['deny']);
});

test('no baseline: a missing hook group, owned sandbox key, denyWrite path or a guarded env key weakens', () => {
  expect(weakened(undefined, view({ permissions: { deny: [FORCE] }, env: { CI: 'false' } }), OWNED)).toEqual(['hooks', 'sandbox', 'denyWrite', 'env']);
});

test('the guarded env list is the Q7 A list', () => {
  expect(GUARDED_ENV.keys).toEqual(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'CI', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', 'AGENT_GUARD_ALLOW_INSTALL', 'XDG_RUNTIME_DIR']);
  expect(GUARDED_ENV.prefixes).toEqual(['HARNESS_', 'GIT_', 'LD_', 'DYLD_']);
});

test('ownedSettings reads the project file\'s blocks from the manifest; created parents are not owned values', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-sw-'));
  mkdirSync(join(root, '.harness'));
  const blocks = [
    { event: 'PreToolUse', group: GROUP }, { deny: FORCE }, { set: ['sandbox'], value: {} }, { set: ['sandbox', 'enabled'], value: true },
    { set: ['sandbox', 'allowUnsandboxedCommands'], value: false }, { set: ['sandbox', 'filesystem'], value: {} }, { denyWrite: './.harness' },
  ].map((b) => JSON.stringify(b));
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ files: [{ rel: '.claude/settings.json', blocks }] }));
  expect(ownedSettings(root)).toEqual(OWNED);
});

test('ownedSettings with no manifest knows nothing: deny is null', () => {
  expect(ownedSettings(mkdtempSync(join(tmpdir(), 'h-sw-')))).toEqual({ sandbox: {}, denyWrite: [], deny: null, hookGroups: [] });
});
