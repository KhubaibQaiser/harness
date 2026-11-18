import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { init } from '../../src/cli/init.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { appendEvent } from '../../src/core/events.js';
import { PREFIX } from '../e2e/fixtures.js';
import { makeRepo } from '../install/helpers.js';
import { pkgDir, prompt, installed, withNode, bin, hermetic, run, setConfig } from './doctor-helpers.js';

// The Stop sandbox section never looks for a real srt or bwrap: an existing .mjs stands in for srt, and every tool is found.
// Doctor's Stop sandbox section asks getconf for the macOS token folder; a stub keeps the darwin cases off the host (no getconf on Windows).
vi.mock('../../src/core/token-base.js', async (orig) => {
  const m = await orig<typeof import('../../src/core/token-base.js')>();
  return { ...m, tokenBase: (p: NodeJS.Platform, e: NodeJS.ProcessEnv) => m.tokenBase(p, e, () => '/var/folders/zz/test/T/\n') };
});

const editSettings = (root: string, edit: (s: any) => void) => {
  const p = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(p, 'utf8'));
  edit(s);
  writeFileSync(p, JSON.stringify(s, null, 2));
};

const differs = (ev: string) => new RegExp(`^fix \`\\.claude/settings\\.json\`: \`hooks\\.${ev}\` harness hook differs from the one harness installs: undo the edit or delete that group, then run \/harness:update$`, 'm');

const toShell = (s: any) => {
  const h = s.hooks.PreToolUse[0].hooks[0];
  h.command = 'node "${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"';
  delete h.args;
};

/** Edits the settings group, and records the result as an older harness's own block, as an old install's manifest does. */
const recordOld = (root: string, ev: string, edit: (s: any) => void) => {
  editSettings(root, edit);
  const group = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks[ev][0];
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.files.find((f: any) => f.rel === '.claude/settings.json').blocks.push(JSON.stringify({ event: ev, group }));
  writeFileSync(mp, JSON.stringify(m));
};

test('an old recorded shell-form entry is a run-harness-update fix', async () => {
  const root = await installed(PREFIX);
  recordOld(root, 'PreToolUse', toShell);
  const r = run(root, { path: bin('npm') });
  // Through the platform shell, from a path with a space. cmd.exe does not expand ${CLAUDE_PROJECT_DIR} (a POSIX-shell
  // form, the known limit that exec form fixes), so on win32 the self-test fails; the update fix below is the point.
  if (process.platform !== 'win32') expect(r.out).toMatch(/^ok dispatcher runs$/m);
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json` runs the dispatcher through a shell: run \/harness:update$/m);
  expect(r.out).not.toMatch(differs('PreToolUse'));
  expect(r.code).toBe(1);
});

test('an old recorded shell-form entry without onFailure gets one update line', async () => {
  const root = await installed(PREFIX);
  recordOld(root, 'PreToolUse', (s) => (toShell(s), delete s.hooks.PreToolUse[0].hooks[0].onFailure));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/through a shell: run \/harness:update$/m);
  expect(r.out).not.toMatch(/^fix PreToolUse hook has no onFailure/m);
});

test('a shell-form entry the person wrote is an edit: the differs line only', async () => {
  const root = await installed(PREFIX);
  editSettings(root, toShell);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(differs('PreToolUse'));
  expect(r.out).not.toMatch(/through a shell/);
  expect(r.code).toBe(1);
});

test('an old recorded group without onFailure is a run-harness-update fix', async () => {
  const root = await installed();
  recordOld(root, 'UserPromptSubmit', (s) => delete s.hooks.UserPromptSubmit[0].hooks[0].onFailure);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix UserPromptSubmit hook has no onFailure "block": run \/harness:update$/m);
  expect(r.out).not.toMatch(/differs/);
  expect(r.out).not.toMatch(/^fix (PreToolUse|ConfigChange) hook/m);
  expect(r.code).toBe(1);
});

test('a fragment group missing from its event is a run-harness-update fix', async () => {
  const root = await installed();
  editSettings(root, (s) => s.hooks.PreToolUse.splice(1, 1)); // the AskUserQuestion group
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json`: `hooks\.PreToolUse` is missing the harness group for `AskUserQuestion`: run \/harness:update$/m);
  expect(r.code).toBe(1);
});

test('deleting onFailure on a fresh install is an edit: the differs line only', async () => {
  const root = await installed();
  editSettings(root, (s) => delete s.hooks.UserPromptSubmit[0].hooks[0].onFailure);
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(differs('UserPromptSubmit'));
  expect(r.out).not.toMatch(/onFailure/);
  expect(r.code).toBe(1);
});

test('an edited harness hook group is a fix', async () => {
  const root = await installed();
  editSettings(root, (s) => (s.hooks.Stop[0].hooks[0].timeout = 5));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^fix `\.claude\/settings\.json`: `hooks\.Stop` harness hook differs from the one harness installs: undo the edit or delete that group, then run \/harness:update$/m);
  expect(r.lines.filter((l) => l.includes('differs'))).toHaveLength(1);
  expect(r.code).toBe(1);
});

test('sandbox lines per platform and mode', async () => {
  const root = await installed();
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok sandbox: unattended \(required for unattended runs\)$/m);
  const win = run(root, { path: bin('npm'), platform: 'win32' });
  expect(win.out).toMatch(/^note this machine can't run Claude Code's sandbox \(native Windows has no Claude Code sandbox\): hooks, permission rules and text checks only$/m);
  expect(win.code).toBe(0);
  const lin = run(root, { path: bin('npm'), platform: 'linux' });
  expect(lin.out).toMatch(/^note this machine can't run Claude Code's sandbox \(the Linux sandbox needs bwrap and socat \(missing: bwrap, socat\)\): install bwrap and socat$/m);
  expect(lin.out).not.toMatch(/sandbox is off in interactive/); // says why it can't run instead
  expect(lin.code).toBe(0);
  const both = withNode(bin('npm')) + delimiter + bin('bwrap') + delimiter + bin('socat');
  let out = '';
  doctor([], { root, env: { PATH: both }, out: (s) => (out += s + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, platform: 'linux', ...hermetic() });
  if (process.platform !== 'win32') expect(out).not.toMatch(/bwrap/); // a linux PATH splits on ':', which a Windows PATH breaks
  setConfig(root, (s) => s.replace('sandbox: unattended', 'sandbox: always'));
  const always = run(root, { path: bin('npm'), platform: 'linux' });
  expect(always.out).toMatch(/^ok sandbox: always \(on in every session\)$/m);
  expect(always.out).toMatch(/^fix this machine can't run Claude Code's sandbox \(the Linux sandbox needs bwrap and socat \(missing: bwrap, socat\)\): install bwrap and socat$/m);
  expect(always.code).toBe(1);
  setConfig(root, (s) => s.replace('sandbox: always', 'sandbox: off'));
  const off = run(root, { path: bin('npm'), platform: 'linux' });
  expect(off.out).toMatch(/^ok sandbox: off \(text checks only\)$/m);
  expect(off.out).toMatch(/^note this machine can't run Claude Code's sandbox \(the Linux sandbox needs bwrap/m);
  expect(off.out).not.toMatch(/sandbox is off in interactive/);
});

test('doctor: the sandbox settings that undo or weaken the protection', async () => {
  const root = await installed();
  const sp = join(root, '.claude/settings.json');
  const edit = (f: (s: any) => void) => { const s = JSON.parse(readFileSync(sp, 'utf8')); f(s); writeFileSync(sp, JSON.stringify(s, null, 2) + '\n'); };
  const mac = () => run(root, { path: bin('npm'), platform: 'darwin' });
  // init wrote every denyWrite path; the sandbox is off (sandbox: unattended), which is a note with the fix.
  expect(mac().out).not.toMatch(/denyWrite/);
  expect(mac().out).toMatch(/^note Claude Code's sandbox is off in interactive sessions: set `sandbox: always` in `\.harness\/config\.yaml` and run \/harness:update$/m);
  expect(run(root, { path: bin('npm'), platform: 'win32' }).out).not.toMatch(/sandbox is off in interactive/); // nothing to turn on there
  edit((s) => { s.sandbox.enabled = true; });
  expect(mac().out).not.toMatch(/sandbox is off/);
  edit((s) => { s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p: string) => p !== './.harness/config.yaml'); });
  let r = mac();
  expect(r.out).toMatch(/^fix `sandbox\.filesystem\.denyWrite` is missing \.\/\.harness\/config\.yaml: run \/harness:update$/m);
  expect(r.code).toBe(1);
  edit((s) => { s.sandbox.filesystem.denyWrite.push('./.harness/config.yaml'); s.sandbox.allowUnsandboxedCommands = true; });
  r = mac();
  expect(r.out).toMatch(/^note `sandbox\.allowUnsandboxedCommands` is true/m);
  expect(r.code).toBe(0);
  edit((s) => { s.sandbox.allowUnsandboxedCommands = false; s.sandbox.excludedCommands = ['git']; });
  expect(mac().out).toMatch(/^fix `sandbox\.excludedCommands` lists git, which run outside the sandbox/m);
  edit((s) => { delete s.sandbox.excludedCommands; s.sandbox.filesystem.disabled = true; });
  expect(mac().out).not.toMatch(/filesystem\.disabled/); // Claude Code reads it from user, managed and --settings only
});

test('doctor: user and managed settings count, and sandbox filesystem arrays merge across scopes', async () => {
  const root = await installed();
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  const config = s.sandbox.filesystem.denyWrite.filter((p: string) => p === './.harness/config.yaml');
  s.sandbox.filesystem.denyWrite = s.sandbox.filesystem.denyWrite.filter((p: string) => p !== './.harness/config.yaml');
  s.sandbox.enabled = true;
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  const home = mkdtempSync(join(tmpdir(), 'h-home-'));
  const user = (j: unknown) => { mkdirSync(join(home, '.claude'), { recursive: true }); writeFileSync(join(home, '.claude/settings.json'), JSON.stringify(j)); };
  const mac = () => run(root, { path: bin('npm'), platform: 'darwin', home });
  expect(mac().out).toMatch(/^fix `sandbox\.filesystem\.denyWrite` is missing \.\/\.harness\/config\.yaml/m);
  // A local denyWrite adds to the project's (Claude Code merges the arrays), so the union has every path.
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ sandbox: { filesystem: { denyWrite: config } } }));
  expect(mac().out).not.toMatch(/denyWrite/);
  rmSync(join(root, '.claude/settings.local.json'));
  user({ sandbox: { filesystem: { denyWrite: config } } });
  expect(mac().out).not.toMatch(/denyWrite/);
  // The user's own file is where the protection is usually undone.
  user({ sandbox: { filesystem: { denyWrite: config, disabled: true }, excludedCommands: ['git'] } });
  let r = mac();
  expect(r.out).toMatch(/^fix `sandbox\.filesystem\.disabled` is true in `.*\.claude\/settings\.json`, which turns off the sandbox's write rules: remove it$/m);
  expect(r.out).toMatch(/^fix `sandbox\.excludedCommands` lists git, which run outside the sandbox/m);
  expect(r.code).toBe(1);
  // Managed settings too (a drop-in folder sits beside the file).
  user({ sandbox: { filesystem: { denyWrite: config } } });
  const managed = join(home, 'managed-settings.json');
  writeFileSync(managed, JSON.stringify({ sandbox: { excludedCommands: ['docker'] } }));
  expect(run(root, { path: bin('npm'), platform: 'darwin', home, managed }).out).toMatch(/^fix `sandbox\.excludedCommands` lists docker/m);
  // Scalars keep precedence: a user `enabled: false` loses to the project's `true`.
  user({ sandbox: { enabled: false, filesystem: { denyWrite: config } } });
  expect(mac().out).not.toMatch(/sandbox is off/);
  // R-2: the launcher's HARNESS_CLAUDE_CONFIG_DIR mirror names the user file; one a repo's settings env sets doesn't count.
  user({ sandbox: { filesystem: { denyWrite: config } } });
  const mirror = mkdtempSync(join(tmpdir(), 'h-mirror-'));
  writeFileSync(join(mirror, 'settings.json'), JSON.stringify({ sandbox: { filesystem: { denyWrite: config, disabled: true } } }));
  const viaMirror = () => run(root, { path: bin('npm'), platform: 'darwin', home, env: { HARNESS_CLAUDE_CONFIG_DIR: mirror } }).out;
  expect(viaMirror()).toMatch(/^fix `sandbox\.filesystem\.disabled` is true in `.*h-mirror-/m);
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ env: { HARNESS_CLAUDE_CONFIG_DIR: mirror } }));
  expect(viaMirror()).not.toMatch(/filesystem\.disabled/);
  rmSync(join(root, '.claude/settings.local.json'));
});

test('doctor: WSL1 and the AppArmor user-namespace restriction are machines that cannot run the sandbox', async () => {
  const root = await installed();
  const tools = withNode(bin('npm')) + delimiter + bin('bwrap') + delimiter + bin('socat');
  const go = (files: Record<string, string>) => {
    let out = '';
    const code = doctor([], { root, env: { PATH: tools }, out: (x) => (out += x + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, platform: 'linux', ...hermetic({ read: (p) => files[p] ?? null }) });
    return { out, code };
  };
  if (process.platform === 'win32') return; // a linux PATH splits on ':', which a Windows PATH breaks
  const aa = go({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' });
  expect(aa.out).toMatch(/^note this machine can't run Claude Code's sandbox \(AppArmor restricts unprivileged user namespaces, which bwrap needs\): .*kernel\.apparmor_restrict_unprivileged_userns=0/m);
  expect(aa.out).not.toMatch(/sandbox is off in interactive/);
  const wsl1 = go({ '/proc/version': 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com)' });
  expect(wsl1.out).toMatch(/^note this machine can't run Claude Code's sandbox \(WSL1 has no Claude Code sandbox\): move to WSL2$/m);
  // With the strict keys committed, it is the fix that names the opt-out.
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  s.sandbox = { ...s.sandbox, enabled: true, failIfUnavailable: true };
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  const strict = go({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' });
  expect(strict.out).toMatch(/^fix this machine can't run Claude Code's sandbox \(AppArmor restricts .*\), and Claude Code's settings set `sandbox\.failIfUnavailable: true`, so it won't run Bash here: add an AppArmor profile .*, or set `sandbox\.failIfUnavailable: false` in your own `\.claude\/settings\.local\.json` \(text guards only\)$/m);
  expect(strict.code).toBe(1);
});

test('doctor: this machine cannot run the sandbox the shared settings require (failIfUnavailable: true)', async () => {
  const root = await installed();
  const sp = join(root, '.claude/settings.json');
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  s.sandbox = { ...s.sandbox, enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false };
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  const CANT = /^fix this machine can't run Claude Code's sandbox \((?:native Windows has no Claude Code sandbox|the Linux sandbox needs bwrap and socat \(missing: bwrap, socat\))\), and Claude Code's settings set `sandbox\.failIfUnavailable: true`, so it won't run Bash here: /m;
  // Linux without bwrap/socat: install them, or opt out in the personal settings file.
  const lin = run(root, { path: bin('npm'), platform: 'linux' });
  expect(lin.out).toMatch(CANT);
  expect(lin.out).toMatch(/install bwrap and socat, or set `sandbox\.failIfUnavailable: false` in your own `\.claude\/settings\.local\.json` \(text guards only\)$/m);
  expect(lin.code).toBe(1);
  // Native Windows: no sandbox to install, so only the personal opt-out.
  const win = run(root, { path: bin('npm'), platform: 'win32' });
  expect(win.out).toMatch(CANT);
  expect(win.out).toMatch(/: set `sandbox\.failIfUnavailable: false` in your own `\.claude\/settings\.local\.json` \(text guards only\)$/m);
  // macOS runs the sandbox; Linux with both tools does too.
  expect(run(root, { path: bin('npm'), platform: 'darwin' }).out).not.toMatch(CANT);
  if (process.platform !== 'win32') {
    let out = '';
    doctor([], { root, env: { PATH: withNode(bin('npm')) + delimiter + bin('bwrap') + delimiter + bin('socat') }, out: (x) => (out += x + '\n') }, { gh: () => ({ status: null, stdout: '' }), claudeVersion: () => MIN_CLAUDE_CODE, platform: 'linux', ...hermetic() });
    expect(out).not.toMatch(CANT);
  }
  // The personal override turns the fix off.
  writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify({ sandbox: { failIfUnavailable: false } }) + '\n');
  expect(run(root, { path: bin('npm'), platform: 'linux' }).out).not.toMatch(CANT);
});

test('a package still writing under .harness/state is a fix', async () => {
  const root = await installed();
  const p = join(root, 'vitest.config.ts');
  writeFileSync(p, readFileSync(p, 'utf8').replaceAll('.harness/results', '.harness/state/test-results'));
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(LEGACY_FIX);
  expect(r.out).not.toMatch(/reporter output/); // one line, one piece of advice
  expect(r.code).toBe(1);
});

const LEGACY_FIX = /^fix the root package writes test results under \.harness\/state, which the sandbox denies: run \/harness:update$/m;

test.each([
  ['a Jest script', {}],
  ['jest.config.js', { 'jest.config.js': "module.exports = { outputFile: '.harness/results/root.json' };\n" }],
])('a Jest package still writing under .harness/state is one fix (%s)', async (_n, extra) => {
  const root = makeRepo({ 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }), 'package-lock.json': '{}\n', ...extra });
  await init(['--yes'], { env: { HARNESS_PLAIN_INIT: '1' }, root, out: () => {}, prompt, version: '1.2.3', templatesDir: join(pkgDir, 'templates'), distDir: join(pkgDir, 'dist'), platform: 'linux' });
  for (const f of ['package.json', ...Object.keys(extra)]) {
    const p = join(root, f);
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('.harness/results', '.harness/state/test-results'));
  }
  expect(readFileSync(join(root, Object.keys(extra)[0] ?? 'package.json'), 'utf8')).toContain('.harness/state/test-results');
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(LEGACY_FIX);
  expect(r.out).not.toMatch(/reporter output/);
  expect(r.code).toBe(1);
});

test('the last blocked settings change is a note', async () => {
  const root = await installed();
  appendEvent(root, { ts: '2026-11-01T00:00:00.000Z', session: 's', check: 'config-change', decision: 'config-change-blocked', reason: 'old' });
  appendEvent(root, { ts: '2026-11-02T00:00:00.000Z', session: 's', check: 'config-change', decision: 'config-change-blocked', reason: '.claude/settings.json: hooks' });
  const r = run(root, { path: bin('npm') });
  expect(r.out).toMatch(/^note harness blocked a settings change at 2026-11-02T00:00:00\.000Z \(\.claude\/settings\.json: hooks\): review the file before the next session$/m);
  expect(r.code).toBe(0);
});
