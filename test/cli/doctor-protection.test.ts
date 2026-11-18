import { realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { doctor } from '../../src/cli/doctor.js';
import { contextSet } from '../../src/budget/summary.js';
import { esc, loadConfig } from '../../src/core/config.js';
import { contextDirs } from '../../src/cli/doctor-context.js';
import { MIN_CLAUDE_CODE } from '../../src/core/min-claude.js';
import { installed, withNode, bin, SRT_STUB, hermetic, run, setConfig } from './doctor-helpers.js';

// The Stop sandbox section never looks for a real srt or bwrap: an existing .mjs stands in for srt, and every tool is found.
// Doctor's Stop sandbox section asks getconf for the macOS token folder; a stub keeps the darwin cases off the host (no getconf on Windows).
vi.mock('../../src/core/token-base.js', async (orig) => {
  const m = await orig<typeof import('../../src/core/token-base.js')>();
  return { ...m, tokenBase: (p: NodeJS.Platform, e: NodeJS.ProcessEnv) => m.tokenBase(p, e, () => '/var/folders/zz/test/T/\n') };
});

// Branch protection: a fake gh, never the real GitHub (test/setup-no-gh.ts makes a real spawn throw).
const VIEW = { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } }) };

const CI = 'name: ci\njobs:\n  ci:\n    name: test\n    steps:\n      - run: pnpm test\n';

const protectionRun = async (api: { status: number | null; stdout: string }, workflow = CI, files: Record<string, string> = {}) => {
  const root = await installed();
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), workflow);
  for (const [f, t] of Object.entries(files)) writeFileSync(join(root, '.github/workflows', f), t);
  const calls: string[][] = [];
  const gh = (a: string[]) => (calls.push(a), a[0] === 'repo' ? VIEW : api);
  let out = '';
  const code = doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic(), gh });
  return { out, code, calls };
};

const prot = (required: object) => ({ status: 0, stdout: JSON.stringify({ required_status_checks: required }) });

test('doctor: a required check matching a CI job is ok', async () => {
  const r = await protectionRun(prot({ contexts: [], checks: [{ context: 'ci / test' }] }));
  expect(r.out).toContain('ok main is protected and requires `ci / test`');
  expect(r.calls[1]).toEqual(['api', 'repos/o/r/branches/main/protection']);
  expect(r.code).toBe(0);
});

test('doctor: legacy contexts also count', async () => {
  expect((await protectionRun(prot({ contexts: ['test'] }))).out).toContain('ok main is protected and requires `test`');
});

test('doctor: a 404 says the branch is not protected, exit code unchanged', async () => {
  const r = await protectionRun({ status: 1, stdout: '{"message":"Branch not protected","status":"404"}' });
  expect(r.out).toMatch(/note main is not protected: .*require the CI checks/);
  expect(r.code).toBe(0);
});

test.each([
  ['a 403', '{"message":"Resource not accessible","status":"403"}'],
  ['a Not Found without a 404 status', 'gh: Not Found'],
])('doctor: %s is unknown, not "not protected"', async (_n, stdout) => {
  const r = await protectionRun({ status: 1, stdout });
  expect(r.out).not.toContain('is not protected');
  expect(r.out).toContain('note branch protection unknown');
});

test('doctor: protected with no matching required checks is a note', async () => {
  const r = await protectionRun(prot({ contexts: ['deploy'] }));
  expect(r.out).toMatch(/note main is protected but no required check matches/);
  expect(r.code).toBe(0);
});

test('doctor: a required check can match a job of a local reusable workflow', async () => {
  const caller = 'jobs:\n  ci:\n    uses: ./.github/workflows/callee.yml\n';
  const callee = 'jobs:\n  lint-job:\n    name: lint\n    steps:\n      - run: pnpm lint\n';
  const r = await protectionRun(prot({ contexts: ['ci / lint'] }), caller, { 'callee.yml': callee });
  expect(r.out).toContain('ok main is protected and requires `ci / lint`');
});

test('doctor: malformed workflow YAML is a note, not a crash', async () => {
  const r = await protectionRun(prot({ contexts: ['test'] }), 'jobs: [unclosed\n  : :');
  expect(r.out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: only the first 100 required contexts are read', async () => {
  const contexts = [...Array.from({ length: 100 }, (_v, i) => `other-${i}`), 'test'];
  expect((await protectionRun(prot({ contexts }))).out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: gh failing without a status is "not available"; a signed-out gh is not', async () => {
  const root = await installed();
  const go = (gh: () => { status: number | null; stdout: string }) => {
    let out = '';
    doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: (s) => (out += s + '\n') }, { claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic(), gh });
    return out;
  };
  expect(go(() => ({ status: null, stdout: '' }))).toContain('note branch protection unknown (gh not available)');
  expect(go(() => ({ status: 1, stdout: 'HTTP 503: unavailable\nsecond line' }))).toContain('note branch protection unknown (gh could not read it: HTTP 503: unavailable)');
  const hostile = go(() => ({ status: 1, stdout: `\x1b[31m\x07evil${'x'.repeat(200)}` }));
  const line = hostile.split('\n').find((l) => l.startsWith('note branch protection unknown'))!;
  expect(line).toMatch(/^note branch protection unknown \(gh could not read it: \[31mevilx+\)$/);
  expect(line).not.toMatch(/[\x00-\x1f]/);
  expect(line.length).toBeLessThan(200);
  expect(go(() => ({ status: 4, stdout: '' }))).toContain('note branch protection unknown (gh could not read it: exit 4)');
  expect(go(() => ({ status: 1, stdout: 'bad\u202e\u200bname' }))).toContain('(gh could not read it: badname)');
});

test('doctor: a workflow file over 1 MB is skipped', async () => {
  const big = CI + '# ' + 'x'.repeat(1 << 20) + '\n';
  expect((await protectionRun(prot({ contexts: ['test'] }), big)).out).toMatch(/note main is protected but no required check matches/);
});

test('doctor: an unsafe branch name from gh is not used in the api path', async () => {
  const root = await installed();
  const calls: string[][] = [];
  const gh = (a: string[]) => (calls.push(a), { status: 0, stdout: JSON.stringify({ nameWithOwner: 'o/r', defaultBranchRef: { name: 'x; echo hi' } }) });
  doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: () => {} }, { claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic(), gh });
  expect(calls).toHaveLength(1);
});

test('doctor: the test setup stops a real gh from being spawned', async () => {
  const root = await installed();
  expect(() => doctor([], { root, env: { PATH: withNode(bin('npm')) }, out: () => {} }, { claudeVersion: () => MIN_CLAUDE_CODE, ...hermetic() })).toThrow(/real gh/);
});

const withBudget = (root: string, n: number) => setConfig(root, (t) => `${t.replace(/^context:\n(?:[ \t].*\n?)*/m, '')}\ncontext:\n  budget_tokens: ${n}\n`);

const sets = (root: string) => contextSet(root, loadConfig(root).config, contextDirs());

test('doctor prints the always-loaded context: ok within budget, note over it, fix when harness alone is over; offline', async () => {
  const root = await installed();
  const real = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('no network'); }) as typeof fetch;
  try {
    const s = sets(root);
    let r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`ok always-loaded context ~${s.total.toLocaleString('en-US')} of 2,000 tokens (best estimate); harness ~${s.harness.toLocaleString('en-US')}. Run harness context for details.\n`); // a literal comma pins the format
    expect(r.out.match(/always-loaded context/g)).toHaveLength(1);
    // Repo text beyond harness's own pushes the total over a budget harness fits in.
    writeFileSync(join(root, 'CLAUDE.md'), 'x'.repeat(40000));
    const s2 = sets(root);
    expect(s2.total).toBeGreaterThan(s2.harness);
    withBudget(root, s2.harness);
    r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`note always-loaded context ~${s2.total.toLocaleString('en-US')} tokens is over the budget of ${s2.harness.toLocaleString('en-US')}: run /harness:context-optimize\n`);
    expect(r.code).toBe(0);
    withBudget(root, 100);
    r = run(root, { path: bin('npm') });
    expect(r.out).toContain(`fix harness's own always-loaded text (~${s2.harness.toLocaleString('en-US')} tokens) is over the budget of 100: report this as a harness bug, or raise context.budget_tokens\n`);
    expect(r.code).toBe(1);
  } finally { globalThis.fetch = real; }
});

test('doctor context line does not throw without .git', async () => {
  const root = await installed();
  rmSync(join(root, '.git'), { recursive: true, force: true });
  expect(run(root, { path: bin('npm') }).out).toMatch(/^ok always-loaded context ~/m);
});

test('an invalid decision makes doctor exit 1', async () => {
  const root = await installed();
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  writeFileSync(join(root, 'docs/decisions/2026-11-03-bad.md'), '---\nschema: harness-decision/1\nid: 2026-11-03-bad\n---\n');
  const r = run(root);
  expect(r.out).toMatch(/^fix docs\/decisions\/2026-11-03-bad\.md: /m);
  expect(r.code).toBe(1);
});

test('no decisions folder: doctor prints the ok line', async () => {
  expect(run(await installed()).out).toContain('ok no team decisions yet');
});

test('doctor: an unreadable managed file is a note, a missing one is not', async () => {
  const root = await installed();
  const home = mkdtempSync(join(tmpdir(), 'h-home-'));
  const managed = join(home, 'managed-settings.json');
  const go = () => run(root, { path: bin('npm'), platform: 'darwin', home, managed });
  expect(go().out).not.toMatch(/can't be read/);
  writeFileSync(managed, 'not json');
  const r = go();
  expect(r.out).toContain(`note managed settings ${managed.replace(/\\/g, "/")} exists but can't be read or parsed; Claude Code skips it, so its policy is not applied. Ask your admin to fix it.`);
  expect(r.code).toBe(0);
  writeFileSync(managed, '{}');
  const dropin = join(home, 'managed-settings.d', '10-x.json');
  mkdirSync(join(home, 'managed-settings.d'));
  writeFileSync(dropin, '{oops');
  expect(go().out).toContain(`managed settings ${dropin.replace(/\\/g, "/")} exists but can't be read or parsed`);
});

test('doctor: allowManagedHooksOnly without harness hooks in managed settings is a fix', async () => {
  const root = await installed();
  const home = mkdtempSync(join(tmpdir(), 'h-home-'));
  const managed = join(home, 'managed-settings.json');
  const go = () => run(root, { path: bin('npm'), platform: 'darwin', home, managed });
  writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: false }));
  expect(go().out).not.toMatch(/allowManagedHooksOnly/);
  writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }));
  const r = go();
  expect(r.out).toContain('fix managed settings set allowManagedHooksOnly, so the harness hooks for PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart, SessionEnd, ConfigChange (guards, ledger, Stop gate) are dropped: ask your admin to add the harness hooks to managed settings, or unset allowManagedHooksOnly');
  expect(r.code).toBe(1);
  // The same hooks the project carries, now in a managed layer (a drop-in here), keep it healthy.
  const hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks;
  mkdirSync(join(home, 'managed-settings.d'));
  writeFileSync(join(home, 'managed-settings.d', '10-h.json'), JSON.stringify({ hooks }));
  expect(go().out).not.toMatch(/allowManagedHooksOnly/);
});

test('doctor: allowManagedHooksOnly follows precedence, names the missing events, and shows with an invalid config', async () => {
  const root = await installed();
  const home = mkdtempSync(join(tmpdir(), 'h-home-'));
  const managed = join(home, 'managed-settings.json');
  const dir = join(home, 'managed-settings.d');
  mkdirSync(dir);
  const go = () => run(root, { path: bin('npm'), platform: 'darwin', home, managed });
  writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }));
  writeFileSync(join(dir, '10-off.json'), JSON.stringify({ allowManagedHooksOnly: false })); // the drop-in wins
  expect(go().out).not.toMatch(/allowManagedHooksOnly/);
  // One event missing from managed settings: only it is named.
  const hooks = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks;
  delete hooks.Stop;
  writeFileSync(join(dir, '10-off.json'), JSON.stringify({ allowManagedHooksOnly: true, hooks }));
  expect(go().out).toMatch(/^fix managed settings set allowManagedHooksOnly, so the harness hooks for Stop \(guards/m);
  // Not behind the invalid-config return.
  setConfig(root, (t) => t + '\nbogus_key: 1\n');
  const r = go();
  expect(r.out).toMatch(/is invalid/);
  expect(r.out).toMatch(/^fix managed settings set allowManagedHooksOnly/m);
  writeFileSync(managed, '[]');
  expect(go().out).toContain(`note managed settings ${managed.replace(/\\/g, "/")} exists but can't be read or parsed`);
});

test('Stop sandbox section: srt from deps, and gone when checks.stop is off', async () => {
  const root = await installed();
  const on = run(root, { path: bin('npm'), platform: 'darwin' });
  expect(on.out).toContain(`ok Stop sandbox: srt 0.0.83 (${esc(realpathSync(SRT_STUB))})`); // esc doubles a win32 path's backslashes
  setConfig(root, (t) => t.replace(/^(\s*)stop: true/m, '$1stop: false'));
  expect(run(root, { path: bin('npm'), platform: 'darwin' }).out).not.toMatch(/Stop sandbox/);
});
