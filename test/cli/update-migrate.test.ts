import { denyWritePaths } from '../../src/checks/protect.js';
import * as realFs from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { uninstall } from '../../src/cli/uninstall.js';
import { readManifest } from '../../src/install/apply.js';
import { sha256 } from '../../src/install/text.js';
import { REPO, fake, newDist, commitAll, installed, up, DISPATCH, un, betaInstall, SETTINGS, settingsBlocks, OWN_IDS, aiInstalled } from './update-helpers.js';

test('change detection: files that update writes do not trigger a block at the next Stop', async () => {
  const { dispatch } = await import('../../src/hooks/dispatch.js');
  const root = await installed();
  const hook = (event: string) => dispatch(JSON.stringify({ hook_event_name: event, session_id: 'cd', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'x') } }), [], {});
  await hook('PreToolUse'); // session snapshot
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readFileSync(join(root, DISPATCH), 'utf8')).toContain('// v2');
  expect(await hook('Stop')).toBe('');
  // a change after the update is still seen
  writeFileSync(join(root, DISPATCH), 'tampered\n');
  expect(JSON.parse(await hook('Stop')).reason).toContain(`\`${DISPATCH}\``);
});

// Round 15 E2: the CLI's record covers only the change the CLI made; a later revert to it is reported.
test('change detection: a script restoring the update-time config after a person edit is reported once', async () => {
  const { dispatch } = await import('../../src/hooks/dispatch.js');
  const { readEvents } = await import('../../src/core/events.js');
  const root = await installed();
  const hook = (event: string) => dispatch(JSON.stringify({ hook_event_name: event, session_id: 'e2', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'x') } }), [], {});
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0); // stamps the CLI record
  commitAll(root);
  await hook('PreToolUse');
  const cfg = join(root, '.harness/config.yaml');
  const updateTime = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, updateTime.replace('tdd: true', 'tdd: false')); // the person's edit
  commitAll(root);
  expect(JSON.parse(await hook('Stop')).decision).toBe('block');
  const events = () => readEvents(root).filter((e) => e.decision === 'harness-files-changed').length;
  const before = events();
  writeFileSync(cfg, updateTime); // a script restores the update-time config
  expect(JSON.parse(await hook('Stop')).reason).toContain('`.harness/config.yaml`');
  expect(await hook('Stop')).toBe('');
  expect(events() - before).toBe(1);
});

// Round 15 E3: init writes the CLI record, so a change before the first session is reported.
test('change detection: a change between init and the first session is reported', async () => {
  const { dispatch } = await import('../../src/hooks/dispatch.js');
  const root = await installed();
  expect(realFs.existsSync(join(root, '.harness/state/files-snapshot.json'))).toBe(true);
  writeFileSync(join(root, '.harness/config.yaml'), readFileSync(join(root, '.harness/config.yaml'), 'utf8') + '# changed before any session\n');
  const hook = (event: string) => dispatch(JSON.stringify({ hook_event_name: event, session_id: 'e3', cwd: root, prompt: 'go' }), [], {});
  expect(JSON.parse(await hook('UserPromptSubmit')).systemMessage).toContain('`.harness/config.yaml`');
  expect(JSON.parse(await hook('Stop')).decision).toBe('block');
});

// An install from before .harness/results: the config, the Vitest path and the manifest all name the old folder.
const OLD = '.harness/state/test-results', NEW = '.harness/results';

const CONFIG = '.harness/config.yaml';

const oldResultsInstall = async () => {
  const root = await installed();
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  for (const rel of [CONFIG, 'vitest.config.ts']) {
    const text = readFileSync(join(root, rel), 'utf8').replace(`${NEW}`, OLD);
    writeFileSync(join(root, rel), text);
    const f = m.files.find((x: { rel: string }) => x.rel === rel);
    f.hash = sha256(text);
    if (f.blocks) f.blocks = f.blocks.map((b: string) => b.replace(NEW, OLD));
  }
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  realFs.mkdirSync(join(root, OLD), { recursive: true });
  writeFileSync(join(root, OLD, 'root.json'), '{}\n');
  commitAll(root);
  return root;
};

test('update migrates the old results_dir before validating', async () => {
  const root = await oldResultsInstall();
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`-  results_dir: ${OLD}\n+  results_dir: ${NEW}`);
  expect(readFileSync(join(root, CONFIG), 'utf8')).toContain(`results_dir: ${NEW}\n`);
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toContain(`'${NEW}/root.json'`);
  const m = readManifest(root)!;
  const blocks = m.files.find((x) => x.rel === 'vitest.config.ts')!.blocks!;
  expect(blocks.join('')).toContain(`${NEW}/root.json`);
  expect(blocks.join('')).not.toContain(OLD);
  expect(m.files.find((x) => x.rel === CONFIG)!.hash).toBe(sha256(readFileSync(join(root, CONFIG), 'utf8')));
  expect(realFs.existsSync(join(root, OLD, 'root.json'))).toBe(true);
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() })).toBe(0);
  for (const [rel, text] of Object.entries(REPO)) expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(text);
});

test('an edited config keeps its old manifest hash', async () => {
  const root = await oldResultsInstall();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8') + '# mine\n');
  commitAll(root);
  const hash = readManifest(root)!.files.find((x) => x.rel === CONFIG)!.hash;
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readFileSync(p, 'utf8')).toContain(`results_dir: ${NEW}\n`);
  expect(readManifest(root)!.files.find((x) => x.rel === CONFIG)!.hash).toBe(hash);
  expect(r.out).not.toContain('You edited');
});

test('a hand-set Jest path is migrated with recorded hunks and uninstall restores it', async () => {
  // jest.reporters in package.json makes init print manual lines; the person then applied them with the old path.
  const pkg = (script: string, reporters: string[]) => JSON.stringify({ name: 'app', scripts: { test: script }, jest: { reporters }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n';
  const root = await installed({ 'package.json': pkg('jest', ['default']), 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n' });
  expect(readManifest(root)!.files.some((x) => x.rel === 'package.json')).toBe(false);
  const hand = pkg(`jest "--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=${OLD}/root.json --coverage`, ['default', './.harness/hooks/jest-results.cjs']);
  writeFileSync(join(root, 'package.json'), hand);
  const cfg = join(root, CONFIG);
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('tdd: false', 'tdd: true')); // and turned TDD on
  commitAll(root);
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(hand.replace(OLD, NEW));
  const f = readManifest(root)!.files.find((x) => x.rel === 'package.json')!;
  expect(f.replace?.length).toBeGreaterThan(0);
  expect(f.formatted).toBeUndefined();
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() })).toBe(0);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(hand);
});

test('a custom results_dir is left alone', async () => {
  const root = await installed();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8').replace(`results_dir: ${NEW}`, 'results_dir: build/results'));
  commitAll(root);
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(readFileSync(p, 'utf8')).toContain('results_dir: build/results\n');
  expect(r.out).not.toContain(`update ${CONFIG}`);
});

test('a custom results_dir inside .harness/state stops update with the config error', async () => {
  const root = await installed();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8').replace(`results_dir: ${NEW}`, 'results_dir: .harness/state/x'));
  commitAll(root);
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(1);
  expect(r.out).toContain('tdd.results_dir: must not be inside .harness/state');
});

test('a hand-set Jest path in jest.config.js is migrated with recorded hunks and uninstall restores it', async () => {
  const pkg = JSON.stringify({ name: 'app', scripts: { test: 'jest' }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n';
  const root = await installed({ 'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n', 'jest.config.js': "module.exports = { reporters: ['default'] };\n" });
  const hand = `module.exports = { reporters: ['default', './.harness/hooks/jest-results.cjs'], outputFile: '${OLD}/root.json' };\n`;
  writeFileSync(join(root, 'jest.config.js'), hand);
  commitAll(root);
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, 'jest.config.js'), 'utf8')).toBe(hand.replace(OLD, NEW));
  expect(readManifest(root)!.files.find((x) => x.rel === 'jest.config.js')!.replace?.length).toBeGreaterThan(0);
  expect(await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() })).toBe(0);
  expect(readFileSync(join(root, 'jest.config.js'), 'utf8')).toBe(hand);
});

test('with TDD off, update still migrates the old results_dir and a hand-set Vitest path', async () => {
  const root = await installed();
  const cfg = join(root, CONFIG);
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('tdd: true', 'tdd: false').replace(`results_dir: ${NEW}`, `results_dir: ${OLD}`));
  const hand = `export default { test: { outputFile: { json: '${OLD}/root.json' } } };\n`;
  writeFileSync(join(root, 'vitest.config.ts'), hand);
  commitAll(root);
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readFileSync(cfg, 'utf8')).toContain(`results_dir: ${NEW}\n`);
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toBe(hand.replace(OLD, NEW));
});

test('init does not migrate an old results path', async () => {
  const vitest = `export default { test: { outputFile: { json: '${OLD}/root.json' } } };\n`;
  const root = await installed({ ...REPO, 'vitest.config.ts': vitest });
  expect(readFileSync(join(root, 'vitest.config.ts'), 'utf8')).toBe(vitest);
  expect(readManifest(root)!.files.some((x) => x.rel === 'vitest.config.ts')).toBe(false);
});

test('an uncommitted config stops update when a migration is due', async () => {
  const root = await oldResultsInstall();
  const p = join(root, CONFIG);
  writeFileSync(p, readFileSync(p, 'utf8') + '# mine\n');
  const before = readFileSync(p, 'utf8');
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`Commit or stash these files first, so the update can be undone cleanly: ${CONFIG}`);
  expect(readFileSync(p, 'utf8')).toBe(before);
});

test('an install with the old compact group is updated in place to the new group, with one group and no note', async () => {
  const root = await installed();
  const sp = join(root, SETTINGS);
  const s = JSON.parse(readFileSync(sp, 'utf8'));
  const oldGroup = { matcher: 'compact', hooks: s.hooks.SessionStart[0].hooks };
  s.hooks.SessionStart = [oldGroup];
  const text = JSON.stringify(s, null, 2) + '\n';
  writeFileSync(sp, text);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === SETTINGS);
  f.blocks = f.blocks.map((b: string) => (JSON.parse(b).event === 'SessionStart' ? JSON.stringify({ event: 'SessionStart', group: oldGroup }) : b));
  f.hash = sha256(text);
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('left as is');
  const g = JSON.parse(readFileSync(sp, 'utf8')).hooks.SessionStart;
  expect(g).toHaveLength(1);
  expect(g[0]).not.toHaveProperty('matcher');
});

test('update replaces the beta hook groups, and uninstall removes the settings file init created', async () => {
  const root = await installed();
  const fresh = settingsBlocks(root);
  const beta = betaInstall(root, {});
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  const after = readFileSync(join(root, SETTINGS), 'utf8');
  const blocks = settingsBlocks(root);
  expect(blocks.filter((b) => beta.includes(b) && JSON.parse(b).event)).toEqual([]);
  expect(new Set(blocks)).toEqual(new Set(fresh));
  expect(JSON.parse(after).hooks.Stop).toHaveLength(1);
  expect((await un(root)).code).toBe(0);
  expect(realFs.existsSync(join(root, SETTINGS))).toBe(false);
});

test('a foreign node exec hook survives init, update and uninstall', async () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['tools/lint-hook.mjs'] }] };
  const pre = JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2) + '\n';
  const root = await installed({ ...REPO, [SETTINGS]: pre });
  expect(JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')).hooks.PreToolUse[0]).toEqual(foreign);
  betaInstall(root, JSON.parse(pre));
  expect((await up(root, ['--yes'])).code).toBe(0);
  const s = JSON.parse(readFileSync(join(root, SETTINGS), 'utf8'));
  expect(s.hooks.PreToolUse).toHaveLength(3); // the person's, harness's, and harness's AskUserQuestion group
  expect(s.hooks.PreToolUse[0]).toEqual(foreign);
  expect(s.hooks.PreToolUse[1].hooks[0].args).toEqual(['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs']);
  // An edit after update makes uninstall remove the recorded blocks one by one instead of restoring the backup.
  writeFileSync(join(root, SETTINGS), JSON.stringify({ ...s, model: 'x' }, null, 2) + '\n');
  commitAll(root);
  const u = await un(root);
  expect(u.code).toBe(0);
  expect(u.out).not.toContain('was not found');
  expect(readFileSync(join(root, SETTINGS), 'utf8')).toBe(JSON.stringify({ ...JSON.parse(pre), model: 'x' }, null, 2) + '\n'); // exact bytes
});

test('existing settings: init, beta rewrite, update and uninstall restore the pre-init bytes exactly', async () => {
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['tools/lint-hook.mjs'] }] };
  const pre = JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [foreign] } }, null, 2) + '\n';
  const root = await installed({ ...REPO, [SETTINGS]: pre });
  betaInstall(root, JSON.parse(pre));
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(JSON.parse(readFileSync(join(root, SETTINGS), 'utf8')).hooks.PreToolUse[0]).toEqual(foreign);
  expect((await un(root)).code).toBe(0);
  expect(readFileSync(join(root, SETTINGS), 'utf8')).toBe(pre);
});

test('switching to always and back leaves the settings as before', async () => {
  const root = await installed();
  const p = join(root, '.claude/settings.json');
  const cfg = join(root, '.harness/config.yaml');
  const afterInit = readFileSync(p, 'utf8');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^sandbox: unattended$/m, 'sandbox: always'));
  commitAll(root);
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(JSON.parse(readFileSync(p, 'utf8')).sandbox).toEqual({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, filesystem: { denyWrite: denyWritePaths() } });
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^sandbox: always$/m, 'sandbox: unattended'));
  commitAll(root);
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(readFileSync(p, 'utf8')).toBe(afterInit);
  expect(readManifest(root)!.files.find((f) => f.rel === '.claude/settings.json')!.blocks!.some((b) => b.startsWith('{"set"'))).toBe(false);
});

test('leaving always with only a changed key left drops the set blocks from the manifest', async () => {
  const root = await installed();
  const p = join(root, '.claude/settings.json');
  const cfg = join(root, '.harness/config.yaml');
  const setMode = (from: string, to: string) => (writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(new RegExp(`^sandbox: ${from}$`, 'm'), `sandbox: ${to}`)), commitAll(root));
  setMode('unattended', 'always');
  expect((await up(root, ['--yes'])).code).toBe(0);
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.sandbox = { enabled: false, filesystem: s.sandbox.filesystem }; // only the one changed key left, and the denyWrite paths
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  setMode('always', 'unattended');
  const first = await up(root, ['--yes']);
  expect(first.code).toBe(0);
  expect(first.out).toContain('was changed');
  expect(first.out).toContain('Only the manifest changes.');
  expect(first.out).not.toMatch(/^Update /m);
  const sets = () => (readManifest(root)!.files.find((f) => f.rel === '.claude/settings.json')!.blocks ?? []).filter((b) => b.startsWith('{"set"'));
  expect(sets()).toEqual([]);
  commitAll(root);
  const second = await up(root, ['--yes']);
  expect(second.code).toBe(0);
  expect(second.out).toMatch(/is up to date\.$/m);
  expect(second.out).not.toContain('was changed');
  s.sandbox = { enabled: true };
  writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
  await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() });
  expect(JSON.parse(readFileSync(p, 'utf8')).sandbox).toEqual({ enabled: true });
});

test('an AI-path install, update and uninstall give the pre-init bytes', async () => {
  const files = { ...REPO, [SETTINGS]: JSON.stringify({ model: 'sonnet' }, null, 2) + '\n', '.mcp.json': JSON.stringify({ mcpServers: { mine: { command: 'm' } } }, null, 2) + '\n' };
  const root = aiInstalled(files, [...OWN_IDS, 'impeccable', 'shadcn', 'mobile-mcp']);
  expect(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers).toHaveProperty('mobile-mcp');
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  const m = readManifest(root)!;
  expect(m.files.find((f) => f.rel === '.mcp.json')!.blocks!.length).toBeGreaterThan(0); // structural blocks survive the update
  expect(m.files.find((f) => f.rel === '.claude/agents/staff-reviewer.md')!.item).toBe('staff-reviewer');
  expect((await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() }))).toBe(0);
  for (const [rel, text] of Object.entries(files)) expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(text);
  for (const rel of ['.claude/agents/staff-reviewer.md', '.harness/facts.json', '.harness/report.md']) expect(realFs.existsSync(join(root, rel)), rel).toBe(false);
});

test('update applies the config change on the AI path and drops it on the plain path', async () => {
  const root = aiInstalled(REPO, OWN_IDS);
  const p = join(root, CONFIG);
  const oldHash = readManifest(root)!.files.find((f) => f.rel === CONFIG)!.hash;
  const off = readFileSync(p, 'utf8').replace(/(- id: staff-reviewer\n(?:.*\n)*?\s+selected: )true/, '$1false') + '# mine\n';
  expect(off).toContain('selected: false');
  writeFileSync(p, off);
  commitAll(root);
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readFileSync(p, 'utf8')).toContain('# mine'); // the person's comment survives
  expect(realFs.existsSync(join(root, '.claude/agents'))).toBe(false); // the emptied dir goes too
  expect(readManifest(root)!.files.find((f) => f.rel === CONFIG)!.hash).toBe(oldHash); // hand-edited text: the old hash stays
  expect(realFs.existsSync(join(root, '.claude/agents/staff-reviewer.md'))).toBe(false);
  expect(readManifest(root)!.files.some((f) => f.rel === '.claude/agents/staff-reviewer.md')).toBe(false);

  const plain = await installed();
  const q = join(plain, CONFIG);
  writeFileSync(q, readFileSync(q, 'utf8') + '# mine\n');
  commitAll(plain);
  expect((await up(plain, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readFileSync(q, 'utf8')).toContain('# mine\n');
});

test('a restored file is the person\'s again: edit it, reselect, uninstall gives their bytes back', async () => {
  const SR = '.claude/agents/staff-reviewer.md';
  const root = aiInstalled({ ...REPO, [SR]: 'mine\n' }, OWN_IDS);
  expect(readFileSync(join(root, SR), 'utf8')).not.toBe('mine\n');
  const p = join(root, CONFIG);
  const flip = (from: string, to: string) => writeFileSync(p, readFileSync(p, 'utf8').replace(new RegExp(`(- id: staff-reviewer\\n(?:.*\\n)*?\\s+selected: )${from}`), `$1${to}`));
  flip('true', 'false');
  commitAll(root);
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('mine\n');
  expect(readManifest(root)!.files.some((f) => f.rel === SR)).toBe(false);
  writeFileSync(join(root, SR), 'mine, edited\n');
  flip('false', 'true');
  commitAll(root);
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).not.toBe('mine, edited\n'); // reselected: the template is written again
  expect((await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() }))).toBe(0);
  expect(readFileSync(join(root, SR), 'utf8')).toBe('mine, edited\n');
});

test('a restored backup is deleted only inside .harness/backup/', async () => {
  const { isBackupPath } = await import('../../src/cli/update.js');
  expect(isBackupPath('.harness/backup/2026-11-04T00-00-00.000Z/AGENTS.md')).toBe(true);
  expect(isBackupPath('.harness/backup/../../README.md')).toBe(false);
  expect(isBackupPath('README.md')).toBe(false);
  expect(isBackupPath('.harness/backup\\..\\x')).toBe(false);
});
