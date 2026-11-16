import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { guardedView, harnessDenyRules } from '../../src/core/harness-files.js';
import type { Layer } from '../../src/core/settings-layers.js';
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
  ['excludedCommands added weakens (owner M3)', FULL, { ...FULL, sandbox: { ...FULL.sandbox, excludedCommands: ['docker'] } }, ['excludedCommands']],
  ['excludedCommands entry removed does not', { ...FULL, sandbox: { ...FULL.sandbox, excludedCommands: ['docker'] } }, FULL, []],
  ['a harness denyWrite path removed weakens', FULL, { ...FULL, sandbox: { ...FULL.sandbox, filesystem: { denyWrite: [] } } }, ['denyWrite']],
  ['a denyWrite path added does not', FULL, { ...FULL, sandbox: { ...FULL.sandbox, filesystem: { denyWrite: ['./.harness', './x'] } } }, []],
  ['a harness deny rule removed weakens', FULL, { ...FULL, permissions: { deny: [USER_DENY] } }, ['deny']],
  ['a user deny rule removed does not', FULL, { ...FULL, permissions: { deny: [FORCE] } }, []],
  ['the user\'s own hook added weakens (owner: no new hooks mid-session)', FULL, { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, ['newHooks']],
  ['the user\'s own hook removed does not', { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, FULL, []],
  ['a harness hook group removed weakens', FULL, { ...FULL, hooks: {} }, ['hooks']],
  ['a harness hook group\'s onFailure changed weakens', FULL, { ...FULL, hooks: { PreToolUse: [{ ...GROUP, hooks: [{ ...H, onFailure: 'continue' }] }] } }, ['hooks', 'newHooks']],
  ['the user\'s own hook timeout edited does not', { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, { ...FULL, hooks: { PreToolUse: [GROUP, { ...MINE, hooks: [{ ...MINE.hooks[0], timeout: 5, statusMessage: 'hi' }] }] } }, []],
  ['the user\'s own hook command changed is a new hook', { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, { ...FULL, hooks: { PreToolUse: [GROUP, { ...MINE, hooks: [{ type: 'command', command: 'echo other' }] }] } }, ['newHooks']],
  ['a known hook under another event is a new hook', { ...FULL, hooks: { PreToolUse: [GROUP, MINE] } }, { ...FULL, hooks: { PreToolUse: [GROUP, MINE], Stop: [MINE] } }, ['newHooks']],
  ['NODE_OPTIONS added weakens', {}, { env: { NODE_OPTIONS: '--require x.js' } }, ['env']],
  ['a guarded prefix key changed weakens', { env: { GIT_DIR: 'a' } }, { env: { GIT_DIR: 'b' } }, ['env']],
  ['a guarded key removed weakens', { env: { PATH: '/bin' } }, {}, ['env']],
  ['a guarded key in another case weakens', {}, { env: { node_options: '--require x.js' } }, ['env']],
  ['MCP_TOKEN added does not', {}, { env: { MCP_TOKEN: 'abc' } }, []],
  ['TMPDIR added weakens (owner M2)', {}, { env: { TMPDIR: '/home/x' } }, ['env']],
  ['ComSpec changed weakens, in any case', { env: { ComSpec: 'cmd.exe' } }, { env: { ComSpec: 'x.exe' } }, ['env']],
  ['USERPROFILE removed weakens', { env: { USERPROFILE: 'C:/u' } }, {}, ['env']],
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
  ['allowManagedDomainsOnly removed from a non-managed file does not: Claude Code reads it from managed only', STRICT, without({}, { allowManagedDomainsOnly: undefined }), []],
  ['the whole sandbox removed weakens', STRICT, {}, ['sandbox']],
  ['enabled false to true does not', { sandbox: { enabled: false } }, { sandbox: { enabled: true } }, []],
  ['strictAllowlist added does not', {}, { sandbox: { network: { strictAllowlist: true } } }, []],
  ['allowedDomains changed with the trusted keys kept does not', STRICT, without({}, { allowedDomains: ['example.com'] }), []],
])('trusted sandbox key: %s', (_, base, cur, want) => {
  expect(weakened(view(base), view(cur), NONE)).toEqual(want);
});

// Review H1: the trusted keys are judged on the value that wins across layers (settings docs: managed, --settings, local,
// project, user), with strictAllowlist honoured from user and managed only, as sandbox-required reads it.
const stack = (o: Partial<Record<Layer['name'], unknown>>): Layer[] => (['managed', 'local', 'project', 'user'] as const).map((name) => ({ name, json: o[name] ?? null }));
const USER_STRICT = { sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { strictAllowlist: true } } };
test.each([
  ['local enabled false over a user true weakens', {}, { sandbox: { enabled: false } }, { user: USER_STRICT }, 'local', ['sandbox']],
  ['project allowUnsandboxedCommands true over a user false weakens', {}, { sandbox: { allowUnsandboxedCommands: true } }, { user: USER_STRICT }, 'project', ['sandbox']],
  ['local enabled false under a managed true does not', {}, { sandbox: { enabled: false } }, { managed: { sandbox: { enabled: true } }, user: USER_STRICT }, 'local', []],
  ['project strictAllowlist false (a scope Claude Code ignores for it) does not', {}, { sandbox: { network: { strictAllowlist: false } } }, { user: USER_STRICT }, 'project', []],
  ['user strictAllowlist removed weakens', USER_STRICT, { sandbox: { enabled: true, allowUnsandboxedCommands: false } }, { user: USER_STRICT }, 'user', ['sandbox']],
  ['local enabled true over a user false does not', {}, { sandbox: { enabled: true } }, { user: { sandbox: { enabled: false } } }, 'local', []],
  ['local excludedCommands adds an entry the user file lacks: weakens', {}, { sandbox: { excludedCommands: ['python3'] } }, { user: { sandbox: { excludedCommands: ['docker'] } } }, 'local', ['excludedCommands']],
  ['local excludedCommands repeats an entry the user file has: does not', {}, { sandbox: { excludedCommands: ['docker'] } }, { user: { sandbox: { excludedCommands: ['docker'] } } }, 'local', []],
  // Owner (round 3): these weaken the sandbox when the winning value loosens; tightening applies.
  ['user httpProxyPort set weakens', {}, { sandbox: { network: { httpProxyPort: 8080 } } }, {}, 'user', ['sandbox']],
  ['local socksProxyPort moved weakens', {}, { sandbox: { network: { socksProxyPort: 1081 } } }, { user: { sandbox: { network: { socksProxyPort: 1080 } } } }, 'local', ['sandbox']],
  ['user httpProxyPort removed does not', { sandbox: { network: { httpProxyPort: 8080 } } }, {}, {}, 'user', []],
  ['project allowAllUnixSockets true weakens', {}, { sandbox: { network: { allowAllUnixSockets: true } } }, {}, 'project', ['sandbox']],
  ['local allowAllUnixSockets false under a project true does not', {}, { sandbox: { network: { allowAllUnixSockets: false } } }, { project: { sandbox: { network: { allowAllUnixSockets: true } } } }, 'local', []],
  ['user enableWeakerNestedSandbox true weakens', {}, { sandbox: { enableWeakerNestedSandbox: true } }, {}, 'user', ['sandbox']],
  ['user enableWeakerNestedSandbox turned off does not', { sandbox: { enableWeakerNestedSandbox: true } }, { sandbox: { enableWeakerNestedSandbox: false } }, {}, 'user', []],
  ['local allowUnixSockets adds a path weakens', {}, { sandbox: { network: { allowUnixSockets: ['/var/run/docker.sock'] } } }, {}, 'local', ['sandbox']],
  ['user allowUnixSockets path removed does not', { sandbox: { network: { allowUnixSockets: ['/a.sock'] } } }, { sandbox: { network: { allowUnixSockets: [] } } }, {}, 'user', []],
  // Owner (round 4): the macOS keys, and values that aren't the documented type count as loosening (fail closed).
  ['local allowLocalBinding true weakens', {}, { sandbox: { network: { allowLocalBinding: true } } }, {}, 'local', ['sandbox']],
  ['local allowLocalBinding false under a project true does not', {}, { sandbox: { network: { allowLocalBinding: false } } }, { project: { sandbox: { network: { allowLocalBinding: true } } } }, 'local', []],
  ['user allowMachLookup new service weakens', {}, { sandbox: { network: { allowMachLookup: ['com.apple.x'] } } }, {}, 'user', ['sandbox']],
  ['user allowMachLookup service removed does not', { sandbox: { network: { allowMachLookup: ['com.apple.x'] } } }, { sandbox: { network: { allowMachLookup: [] } } }, {}, 'user', []],
  ['type: local enabled "true" over a user true weakens', {}, { sandbox: { enabled: 'true' } }, { user: USER_STRICT }, 'local', ['sandbox']],
  ['type: user strictAllowlist "true" weakens', USER_STRICT, { sandbox: { ...USER_STRICT.sandbox, network: { strictAllowlist: 'true' } } }, {}, 'user', ['sandbox']],
  ['type: project allowAllUnixSockets 1 weakens', {}, { sandbox: { network: { allowAllUnixSockets: 1 } } }, {}, 'project', ['sandbox']],
  ['type: user enableWeakerNestedSandbox "yes" weakens', {}, { sandbox: { enableWeakerNestedSandbox: 'yes' } }, {}, 'user', ['sandbox']],
  ['type: local httpProxyPort "8080" weakens', {}, { sandbox: { network: { httpProxyPort: '8080' } } }, {}, 'local', ['sandbox']],
  ['type: local excludedCommands as a string weakens', {}, { sandbox: { excludedCommands: 'docker' } }, {}, 'local', ['excludedCommands']],
  ['type: user allowMachLookup as a string weakens', {}, { sandbox: { network: { allowMachLookup: '*' } } }, {}, 'user', ['sandbox']],
  ['type: local sandbox.network as a string weakens', {}, { sandbox: { network: 'open' } }, {}, 'local', ['sandbox']],
  ['type: local sandbox as a string weakens', {}, { sandbox: 'off' }, {}, 'local', ['sandbox']],
] as const)('layered: %s', (_, base, cur, others, key, want) => {
  const layers = { base: stack({ ...others, [key]: view(base) }), cur: stack({ ...others, [key]: view(cur) }) };
  expect(weakened(view(base), view(cur), NONE, layers)).toEqual(want);
});

// Review M1: with what harness owns unknown, every sandbox change counts, as before CC7.
test.each([
  ['an unowned sandbox key added', { sandbox: { autoAllowBashIfSandboxed: true, filesystem: FULL.sandbox.filesystem } }],
  ['a denyWrite path removed', { sandbox: { filesystem: { denyWrite: [] } } }],
])('unknown ownership: %s weakens', (_, cur) => {
  const unknown: Owned = { sandbox: {}, denyWrite: [], deny: null, hookGroups: [] };
  expect(weakened(view({ sandbox: { filesystem: FULL.sandbox.filesystem } }), view(cur), unknown)).toEqual(['sandbox']);
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
  expect(GUARDED_ENV.keys).toEqual(['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'CI', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', 'AGENT_GUARD_ALLOW_INSTALL', 'XDG_RUNTIME_DIR', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'COMSPEC']);
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

test('L1: a malformed manifest block makes ownership unknown for the baseline and ConfigChange alike', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-sw-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ files: [{ rel: '.claude/settings.json', blocks: [JSON.stringify({ deny: FORCE }), '{bad'] }] }));
  expect(harnessDenyRules(root)).toBeNull();
  expect(ownedSettings(root).deny).toBeNull();
});

test('ownedSettings with no manifest knows nothing: deny is null', () => {
  expect(ownedSettings(mkdtempSync(join(tmpdir(), 'h-sw-')))).toEqual({ sandbox: {}, denyWrite: [], deny: null, hookGroups: [] });
});
