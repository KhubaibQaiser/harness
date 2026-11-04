import * as realFs from 'node:fs';
import type { FsLike } from '../../src/install/apply.js';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { init, type Prompt } from '../../src/cli/init.js';
import { update } from '../../src/cli/update.js';
import { uninstall } from '../../src/cli/uninstall.js';
import { latestVersion } from '../../src/core/registry.js';
import { applyChanges, readManifest } from '../../src/install/apply.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { detect } from '../../src/install/detect.js';
import { planChanges } from '../../src/install/plan.js';
import { preset } from '../../src/install/preset.js';
import { sha256 } from '../../src/install/text.js';
import { betaSettings, makeRepo } from '../install/helpers.js';
import { execFileSync } from 'node:child_process';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const templatesDir = join(pkgDir, 'templates');
const REPO = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) + '\n',
  'package-lock.json': '{}\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n",
  '.gitignore': 'node_modules\n',
  'AGENTS.md': '# Mine\n',
};
const fake = (answers: boolean[] = []): Prompt & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, async confirm(q) { asked.push(q); return answers.length ? answers.shift()! : false; }, async edit(_l, v) { return v; } };
};
/** A copy of dist whose dispatcher differs, standing in for the next release. */
const newDist = () => {
  const d = mkdtempSync(join(tmpdir(), 'harness-dist-'));
  cpSync(join(pkgDir, 'dist'), d, { recursive: true });
  const p = join(d, 'hooks', 'dispatch.mjs');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n// v2\n');
  return d;
};
/** Commits everything, as a user does before update (update refuses uncommitted changes to files it touches). */
const commitAll = (root: string) => {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
};
const installed = async (files: Record<string, string> = REPO) => {
  const root = makeRepo(files);
  await init(['--yes'], { env: {}, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') });
  commitAll(root);
  return root;
};

const up = async (root: string, args: string[], over: { distDir?: string; version?: string; prompt?: Prompt; fetchImpl?: typeof fetch; fs?: FsLike } = {}) => {
  let out = '';
  const code = await update(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: over.prompt ?? fake(), version: over.version ?? '1.1.0', templatesDir, distDir: over.distDir ?? join(pkgDir, 'dist'), fetchImpl: over.fetchImpl, fs: over.fs });
  return { code, out };
};
const DISPATCH = '.harness/hooks/dispatch.mjs';

test('update re-renders the dispatcher and rewrites the manifest version', async () => {
  const root = await installed();
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(readFileSync(join(root, DISPATCH), 'utf8')).toContain('// v2');
  const m = readManifest(root)!;
  expect(m.version).toBe('1.1.0');
  const f = m.files.find((x) => x.rel === DISPATCH)!;
  expect(f.kind).toBe('create');
  expect(f.hash).toBe(sha256(readFileSync(join(root, DISPATCH), 'utf8')));
  expect(m.files.map((x) => x.rel)).toContain('.claude/settings.json'); // untouched entries carried over
  // uninstall still removes everything and restores merged files
  const u = await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() });
  expect(u).toBe(0);
  expect(() => readFileSync(join(root, DISPATCH))).toThrow();
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(REPO['AGENTS.md']);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(REPO['.gitignore']);
});

const manifestFails = (): FsLike => { let n = 0; return ({ ...realFs, renameSync: (a: any, b: any) => { if (/[\\/]\.harness[\\/]manifest\.json$/.test(String(b)) && !n++) throw new Error('boom'); realFs.renameSync(a, b); } }) as FsLike; };
const snapshot = (root: string) => [DISPATCH, '.harness/manifest.json', 'AGENTS.md', '.claude/settings.json'].map((r) => readFileSync(join(root, r), 'utf8'));

test('manifest write failure in update rolls back every file', async () => {
  const root = await installed();
  const before = snapshot(root);
  const r = await up(root, ['--yes'], { distDir: newDist(), fs: manifestFails() });
  expect(r.code).toBe(1);
  expect(r.out).toContain('rolled back');
  expect(snapshot(root)).toEqual(before);
});

test('a write failure in uninstall rolls back every file and keeps the manifest', async () => {
  const root = await installed();
  const p = join(root, DISPATCH);
  writeFileSync(p, readFileSync(p, 'utf8') + '// mine\n'); // edited created file -> kept
  const before = snapshot(root);
  let out = '';
  const agentsFails = (): FsLike => ({ ...realFs, renameSync: (a: any, b: any) => { if (/[\\/]AGENTS\.md$/.test(String(b))) throw new Error('boom'); realFs.renameSync(a, b); } }) as FsLike;
  const code = await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s), prompt: fake(), fs: agentsFails() });
  expect(code).toBe(1);
  expect(snapshot(root)).toEqual(before);
});

test('edited-files copy differs for merged files', async () => {
  const root = await installed();
  writeFileSync(join(root, DISPATCH), 'x\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Mine\nedit\n');
  commitAll(root);
  // a changed template makes the merged AGENTS.md block update too
  const t = mkdtempSync(join(tmpdir(), 'harness-tpl-'));
  cpSync(templatesDir, t, { recursive: true });
  writeFileSync(join(t, 'agents-block.md'), readFileSync(join(t, 'agents-block.md'), 'utf8') + '\nNew line.\n');
  let out = '';
  await update(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir: t, distDir: newDist() });
  expect(out).toContain(`You edited these harness files; update replaces them: \`${DISPATCH}\`.`);
  expect(out).toMatch(/You edited these files; update changes only the harness parts: `AGENTS.md`\./);
});

test('update keeps user config', async () => {
  const root = await installed();
  const p = join(root, '.harness/config.yaml');
  writeFileSync(p, readFileSync(p, 'utf8') + '# my comment\n');
  const before = readFileSync(p, 'utf8');
  const entry = readManifest(root)!.files.find((x) => x.rel === '.harness/config.yaml')!;
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(readFileSync(p, 'utf8')).toBe(before);
  expect(readManifest(root)!.files.find((x) => x.rel === '.harness/config.yaml')).toEqual(entry);
});

test('lists user-edited harness files, even with --yes, and asks once', async () => {
  const root = await installed();
  const p = join(root, DISPATCH);
  writeFileSync(p, readFileSync(p, 'utf8') + '// mine\n');
  commitAll(root);
  const pr = fake([true]);
  const r = await up(root, [], { distDir: newDist(), prompt: pr });
  expect(r.out).toContain(`You edited these harness files; update replaces them: \`${DISPATCH}\`.`);
  expect(pr.asked).toHaveLength(1);
  const y = await up(await (async () => { const x = await installed(); writeFileSync(join(x, DISPATCH), 'x\n'); commitAll(x); return x; })(), ['--yes'], { distDir: newDist() });
  expect(y.out).toContain('You edited these harness files');
});

test('declining writes nothing', async () => {
  const root = await installed();
  const r = await up(root, [], { distDir: newDist(), prompt: fake([false]) });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Cancelled. Nothing was written.');
  expect(readFileSync(join(root, DISPATCH), 'utf8')).not.toContain('// v2');
});

test('no-op when current', async () => {
  const root = await installed();
  const m = readFileSync(join(root, '.harness/manifest.json'), 'utf8');
  const r = await up(root, ['--yes'], { version: '1.0.0' });
  expect(r.code).toBe(0);
  expect(r.out).toContain('Harness 1.0.0 is up to date.');
  expect(readFileSync(join(root, '.harness/manifest.json'), 'utf8')).toBe(m);
});

test('same files, newer version: manifest version is bumped', async () => {
  const root = await installed();
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  expect(readManifest(root)!.version).toBe('1.1.0');
});

test('refuses when not installed, bad flag, or invalid config', async () => {
  expect((await up(makeRepo(REPO), [])).out).toContain('harness init');
  expect((await up(makeRepo(REPO), ['--bogus'])).code).toBe(2);
  const root = await installed();
  writeFileSync(join(root, '.harness/config.yaml'), 'bogus_key: 1\n');
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(1);
  expect(r.out).toContain('bogus_key');
  expect(r.out).toContain('harness doctor');
});

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
test('--check with a fake fetch: newer, same, unreachable', async () => {
  const root = await installed();
  const n = await up(root, ['--check'], { version: '1.0.0', fetchImpl: reply(200, { version: '2.0.0' }) });
  expect(n.out).toContain('Harness 2.0.0 is available (you have 1.0.0). Plugin users: update the plugin, then run /harness:update. CLI users: npx @khubaibqaiser/harness@latest update.');
  const s = await up(root, ['--check'], { version: '2.0.0', fetchImpl: reply(200, { version: '2.0.0' }) });
  expect(s.out).toContain('Harness 2.0.0 is the latest.');
  const u = await up(root, ['--check'], { fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
  expect(u.out).toContain('Could not reach npm');
  expect(u.code).toBe(1);
});

test('latestVersion: URL-encoded scope, null on bad status or body', async () => {
  let url = '';
  const f = (async (u: string) => ((url = u), new Response('{"version":"3.1.0"}'))) as unknown as typeof fetch;
  expect(await latestVersion('@khubaibqaiser/harness', f)).toBe('3.1.0');
  expect(url).toBe('https://registry.npmjs.org/@khubaibqaiser%2fharness/latest');
  expect(await latestVersion('x', reply(404, {}))).toBeNull();
  expect(await latestVersion('x', reply(200, { version: 3 }))).toBeNull();
  expect(await latestVersion('x', (async () => new Response('not json')) as unknown as typeof fetch)).toBeNull();
});

test('update --dry-run prints the plan and writes nothing', async () => {
  const root = await installed();
  const before = snapshot(root);
  const r = await up(root, ['--dry-run'], { distDir: newDist(), prompt: { async confirm() { throw new Error('prompted'); }, async edit(_l, v) { return v; } } });
  expect(r.code).toBe(0);
  expect(r.out).toContain(`  update ${DISPATCH}`);
  expect(r.out).toContain('Dry run: nothing was written.');
  expect(snapshot(root)).toEqual(before);
});

test('CRLF checkout: update with the same version finds nothing edited and nothing to change', async () => {
  const root = await installed();
  const m = readManifest(root)!;
  for (const f of m.files) writeFileSync(join(root, f.rel), readFileSync(join(root, f.rel), 'utf8').replace(/\r?\n/g, '\r\n'));
  const r = await up(root, ['--dry-run'], { version: '1.0.0' });
  expect(r.out).not.toContain('You edited');
  expect(r.out).toContain('Harness 1.0.0 is up to date.');
});

test('CRLF checkout: a real update does not call the files edited, and records LF-normalized hashes', async () => {
  const root = await installed();
  for (const f of readManifest(root)!.files) writeFileSync(join(root, f.rel), readFileSync(join(root, f.rel), 'utf8').replace(/\r?\n/g, '\r\n'));
  commitAll(root);
  const r = await up(root, ['--yes'], { distDir: newDist() });
  expect(r.code).toBe(0);
  expect(r.out).not.toContain('You edited');
  const agents = readManifest(root)!.files.find((x) => x.rel === DISPATCH)!;
  expect(agents.hash).toBe(sha256(readFileSync(join(root, DISPATCH), 'utf8').replace(/\r\n/g, '\n')));
});

test('update keeps the packages init left out of TDD in the manifest', async () => {
  const root = await installed({ ...REPO, 'vitest.config.ts': "export default { test: { root: './src' } };\n" });
  expect(readManifest(root)!.tddOff).toEqual(['.']);
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readManifest(root)!.tddOff).toEqual(['.']);
});

// A Jest install from before the reporter: `--json --outputFile=...` appended to the test script.
const oldJestInstall = async () => {
  const pkg = JSON.stringify({ name: 'app', scripts: { test: 'jest --silent' }, devDependencies: { jest: '^30.0.0' } }, null, 2) + '\n';
  const root = makeRepo({ 'package.json': pkg, 'package-lock.json': '{}\n', '.gitignore': 'node_modules\n' });
  await init(['--yes'], { env: {}, root, out: () => {}, prompt: fake(), version: '1.0.0', templatesDir, distDir: join(pkgDir, 'dist') });
  const oldBlock = ' --json --outputFile=.harness/results/root.json --coverage';
  const oldPkg = pkg.replace('"jest --silent"', `"jest --silent${oldBlock}"`);
  writeFileSync(join(root, 'package.json'), oldPkg);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === 'package.json');
  f.blocks = [oldBlock];
  f.hash = sha256(oldPkg);
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
  return { root, pkg };
};

test('update migrates the old Jest --json script to the reporter form, and uninstall restores the original', async () => {
  const { root, pkg } = await oldJestInstall();
  const r = await up(root, ['--yes']);
  expect(r.code).toBe(0);
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  expect(script).toBe('jest --silent --reporters=default --reporters=./.harness/hooks/jest-results.cjs "--modulePathIgnorePatterns=<rootDir>/.harness" --outputFile=.harness/results/root.json --coverage');
  expect(r.out).not.toContain('You edited');
  expect((await uninstall(['--yes'], { env: {}, root, out: () => {}, prompt: fake() }))).toBe(0);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkg);
});

test('migrated Jest script: uninstall without a backup (teammate clone) removes the block cleanly', async () => {
  const { root, pkg } = await oldJestInstall();
  expect((await up(root, ['--yes'])).code).toBe(0);
  realFs.rmSync(join(root, '.harness/backup'), { recursive: true, force: true });
  let out = '';
  expect(await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake() })).toBe(0);
  expect(out).not.toContain('was not found');
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(pkg);
});

test('CRLF checkout: a multi-line block still in the file stays in the manifest after update', async () => {
  const root = await installed();
  // AGENTS.md lost the harness block (so update changes it) but still holds another recorded block, now with CRLF.
  writeFileSync(join(root, 'AGENTS.md'), '# Mine\r\nkept line 1\r\nkept line 2\r\n');
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === 'AGENTS.md');
  f.blocks = [...f.blocks, 'kept line 1\nkept line 2\n'];
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
  expect((await up(root, ['--yes'], { distDir: newDist() })).code).toBe(0);
  expect(readManifest(root)!.files.find((x) => x.rel === 'AGENTS.md')!.blocks).toContain('kept line 1\nkept line 2\n');
});

test('update refuses uncommitted changes to a file it would touch; --dry-run only warns', async () => {
  const root = await installed();
  oldAgentsBlock(root);
  writeFileSync(join(root, 'AGENTS.md'), readFileSync(join(root, 'AGENTS.md'), 'utf8') + 'uncommitted\n');
  const dist = newDist();
  let out = '';
  const run = (args: string[]) => update(args, { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake(), version: '1.1.0', templatesDir, distDir: dist });
  expect(await run(['--yes'])).toBe(1);
  expect(out).toContain('Commit or stash these files first, so the update can be undone cleanly: AGENTS.md.');
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('uncommitted');
  expect(readFileSync(join(root, DISPATCH), 'utf8')).not.toContain('// v2');
  out = '';
  expect(await run(['--dry-run'])).toBe(0);
  expect(out).toContain('These files have uncommitted changes; commit or stash them before applying: AGENTS.md.');
});

const un = async (root: string) => {
  let out = '';
  const code = await uninstall(['--yes'], { env: {}, root, out: (s) => (out += s + '\n'), prompt: fake() });
  return { code, out };
};
/** Makes the installed AGENTS.md block look like an older release's, so update rewrites it. */
const oldAgentsBlock = (root: string) => {
  const old = (t: string) => t.replace('<!-- harness:end -->', 'Old line.\n<!-- harness:end -->');
  const p = join(root, 'AGENTS.md');
  writeFileSync(p, old(readFileSync(p, 'utf8')));
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === 'AGENTS.md');
  f.blocks = f.blocks.map(old);
  f.hash = sha256(readFileSync(p, 'utf8'));
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
};
const updateBlock = async (root: string) => {
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).not.toContain('Old line.');
};

test('update then uninstall keeps a user edit to a merged file that existed before init', async () => {
  const root = await installed();
  oldAgentsBlock(root);
  const p = join(root, 'AGENTS.md');
  writeFileSync(p, readFileSync(p, 'utf8') + 'my rule\n');
  commitAll(root);
  await updateBlock(root);
  expect((await un(root)).code).toBe(0);
  const now = readFileSync(p, 'utf8');
  expect(now).toContain('# Mine');
  expect(now).toContain('my rule');
  expect(now).not.toContain('harness:start');
  expect(now).not.toContain('Old line.');
});

test('update then uninstall keeps a user edit to a file init created (AGENTS.md)', async () => {
  const { 'AGENTS.md': _, ...noAgents } = REPO;
  const root = await installed(noAgents);
  expect(readManifest(root)!.files.find((f) => f.rel === 'AGENTS.md')!.kind).toBe('create');
  oldAgentsBlock(root);
  const p = join(root, 'AGENTS.md');
  writeFileSync(p, readFileSync(p, 'utf8') + 'my rule\n');
  commitAll(root);
  await updateBlock(root);
  const r = await un(root);
  expect(r.code).toBe(0);
  const now = readFileSync(p, 'utf8');
  expect(now).toContain('my rule');
  expect(now).not.toContain('harness:start');
  expect(now).not.toContain('Old line.');
  // CLAUDE.md, also created by init and never edited, is still removed whole
  expect(realFs.existsSync(join(root, 'CLAUDE.md'))).toBe(false);
});

test('migrated Jest script: uninstall keeps a user edit to package.json made before the update', async () => {
  const { root, pkg } = await oldJestInstall();
  const p = join(root, 'package.json');
  const edited = readFileSync(p, 'utf8').replace('"name": "app",', '"name": "app",\n  "private": true,');
  writeFileSync(p, edited);
  commitAll(root);
  expect((await up(root, ['--yes'])).code).toBe(0);
  expect((await un(root)).code).toBe(0);
  expect(readFileSync(p, 'utf8')).toBe(pkg.replace('"name": "app",', '"name": "app",\n  "private": true,'));
});

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

/** Makes the installed settings.json and its manifest blocks the beta release's, as an install from that release left them. */
const betaInstall = (root: string, pre: object) => {
  const { s, blocks } = betaSettings(pre);
  const text = JSON.stringify(s, null, 2) + '\n';
  writeFileSync(join(root, '.claude/settings.json'), text);
  const mp = join(root, '.harness/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  const f = m.files.find((x: { rel: string }) => x.rel === '.claude/settings.json');
  f.blocks = blocks;
  f.hash = sha256(text);
  writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  commitAll(root);
  return blocks;
};
const SETTINGS = '.claude/settings.json';
const settingsBlocks = (root: string) => readManifest(root)!.files.find((f) => f.rel === SETTINGS)!.blocks!;

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
  expect(s.hooks.PreToolUse).toHaveLength(2);
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
  expect(JSON.parse(readFileSync(p, 'utf8')).sandbox).toEqual({ enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
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
  s.sandbox = { enabled: false };
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

// The recommend flow's install: the plan carries the selected items, and update and uninstall follow the manifest.
const OWN_IDS = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'agents-md'];
const aiInstalled = (files: Record<string, string>, ids: string[]) => {
  const root = makeRepo(files);
  const facts = detect(root);
  const config = preset(facts).config;
  config.items = ids.map((id) => ({ id, include: 'recommended' as const, selected: true, reason: 'r', addresses: [], pin: '' }));
  const ai = { picks: '{}\n', report: '# R\n\n## Limits\n\nx\n', product: '# P\n' };
  const plan = planChanges(root, config, facts, { version: '1.0.0', distDir: join(pkgDir, 'dist'), templatesDir, catalog: loadCatalog().catalog, ai });
  applyChanges(root, plan.changes, '1.0.0');
  commitAll(root);
  return root;
};

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
