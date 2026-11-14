import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { done, DONE_USAGE } from '../../src/cli/done.js';
import { blockedReason } from '../../src/done/commands.js';
import { type Contract, setActiveTask, writeContract } from '../../src/done/contract.js';
import { LEDGER } from '../../src/done/ledger.js';
import { repoWith } from '../review/repo.js';

const contract: Contract = {
  id: 'add-login', title: 'Add login', base: 'a'.repeat(40), approved_by: 'person', approved_at: '2026-11-14T00:00:00Z', closed_at: null,
  criteria: [{ id: 'C1', text: 'it works', check: { test: 'test/a.test.ts::a works' } }, { id: 'C2', text: 'looks right', check: { person: 'open it' } }],
  checks: ['test'], review: { model: 'sonnet' }, sha256: null,
};

const HOOK = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'] };
const WIRED = { hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell|Edit', hooks: [HOOK] }] } };

function setup(o: { on?: boolean; active?: boolean; settings?: unknown; local?: unknown; user?: unknown; managed?: unknown; dropIn?: unknown; mirror?: boolean; rawLocal?: string } = {}) {
  const { root } = repoWith({ 'README.md': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) }, {});
  mkdirSync(join(root, '.harness'), { recursive: true });
  writeFileSync(join(root, '.harness/config.yaml'), `checks:\n  done: ${o.on ?? true}\n`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify(o.settings ?? WIRED));
  if (o.local) writeFileSync(join(root, '.claude/settings.local.json'), JSON.stringify(o.local));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  if (o.user) writeFileSync(join(home, 'settings.json'), JSON.stringify(o.user));
  const mdir = mkdtempSync(join(tmpdir(), 'mng-'));
  const managed = join(mdir, 'managed-settings.json');
  if (o.managed) writeFileSync(managed, JSON.stringify(o.managed));
  if (o.dropIn) (mkdirSync(join(mdir, 'managed-settings.d')), writeFileSync(join(mdir, 'managed-settings.d/10.json'), JSON.stringify(o.dropIn)));
  if (o.rawLocal !== undefined) writeFileSync(join(root, '.claude/settings.local.json'), o.rawLocal);
  const env: NodeJS.ProcessEnv = o.mirror ? { HARNESS_CLAUDE_CONFIG_DIR: home } : { CLAUDE_CONFIG_DIR: home };
  const c = writeContract(root, contract);
  if (o.active ?? true) setActiveTask(root, c.id);
  const lines: string[] = [];
  const call = (args: string[], cwd = root) => ({ code: done(args, { root, cwd, env, managed, home: mkdtempSync(join(tmpdir(), 'nohome-')), out: (l) => lines.push(l) }), text: lines.splice(0).join('\n') });
  return { root, call };
}

test('usage errors exit 2', () => {
  const { call } = setup();
  for (const args of [[], ['--blocked'], ['--blocked', 'a', 'b'], ['--nope', 'a'], ['--blocked', ''], ['--blocked', '  '], ['--blocked', 'a\nb'], ['--blocked', 'x'.repeat(501)]]) {
    const r = call(args);
    expect(r.code, JSON.stringify(args)).toBe(2);
    expect(r.text).toContain(DONE_USAGE);
  }
});

test('a reason the hook would not record exits 2 (round trip with the hook matcher)', () => {
  const { call } = setup();
  // Covers only the double-quoted form the hook's matcher reads; single-quote and cli.mjs invocations reach the same argv.
  const accepted = ['the API key is missing', "can't reach the db", 'x'.repeat(500), 'tests need network, which is off'];
  const rejected = ['a "quoted" word', '$HOME', 'a`b`', 'a;b', 'a&b', 'a|b', 'a>b', 'a<b', '*.ts', '~/x', 'see #12', 'a\\b', '(x)', '{x}', '[x]', 'what?', 'a\tb\nc'];
  for (const r of [...accepted, ...rejected]) {
    const hook = blockedReason(`harness done --blocked "${r}"`) === r;
    expect(call(['--blocked', r]).code === 0, JSON.stringify(r)).toBe(hook);
    expect(hook, JSON.stringify(r)).toBe(accepted.includes(r));
  }
});

test('outside the repo root exits 2, and a symlink to the root is the root', () => {
  const { root, call } = setup();
  mkdirSync(join(root, 'sub'));
  expect(call(['--blocked', 'x'], join(root, 'sub')).code).toBe(2);
  const link = join(mkdtempSync(join(tmpdir(), 'lnk-')), 'r');
  symlinkSync(root, link);
  expect(call(['--blocked', 'x'], link).code).toBe(0);
});

test('checks.done off, or no active contract, exits 1', () => {
  expect(setup({ on: false }).call(['--blocked', 'x']).code).toBe(1);
  expect(setup({ active: false }).call(['--blocked', 'x']).code).toBe(1);
});

test('an unwired or disabled evidence hook exits 1', () => {
  const msg = 'harness PostToolUse hook is not wired (or disableAllHooks is set); nothing would be recorded';
  const other = { type: 'command', command: 'node', args: ['other.mjs'] };
  const cases = [
    { settings: {} },
    { settings: { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [HOOK] }] } } },
    { settings: { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [other] }] } } },
    { local: { disableAllHooks: true } },
    { user: { disableAllHooks: true } },
    { settings: { ...WIRED, disableAllHooks: true } },
  ];
  for (const c of cases) {
    const r = setup(c).call(['--blocked', 'x']);
    expect(r.code, JSON.stringify(c)).toBe(1);
    expect(r.text).toContain(msg);
  }
  expect(setup({ user: WIRED, settings: {} }).call(['--blocked', 'x']).code).toBe(0); // a user-level hook counts
});

test('managed layers, unreadable layers, the repo mirror and match-all matchers', () => {
  const x = (o: Parameters<typeof setup>[0]) => setup(o).call(['--blocked', 'x']).code;
  expect(x({ managed: { disableAllHooks: true } }), 'managed disableAllHooks').toBe(1);
  expect(x({ dropIn: { disableAllHooks: true } }), 'managed drop-in disableAllHooks').toBe(1);
  expect(x({ managed: { allowManagedHooksOnly: true } }), 'managed-only, wiring not managed').toBe(1);
  expect(x({ managed: { allowManagedHooksOnly: true, ...WIRED } }), 'managed-only, wiring managed').toBe(0);
  expect(x({ managed: WIRED, settings: {} }), 'managed wiring counts').toBe(0);
  expect(x({ rawLocal: '{ nope' }), 'malformed local layer').toBe(1);
  // The repo's own settings name a wired dir as the user layer: Claude Code ignores that, so must the check.
  const m = setup({ mirror: true, user: WIRED, settings: { env: { HARNESS_CLAUDE_CONFIG_DIR: '/x' } } });
  expect(m.call(['--blocked', 'x']).code).toBe(1);
  for (const matcher of ['', '*']) expect(x({ settings: { hooks: { PostToolUse: [{ matcher, hooks: [HOOK] }] } } }), `matcher ${JSON.stringify(matcher)}`).toBe(0);
});

test('a valid call prints the failing criteria and the hook note, and writes no ledger', () => {
  const { root, call } = setup();
  const r = call(['--blocked', 'the API key is missing']);
  expect(r.code).toBe(0);
  expect(r.text).toContain('C1');
  expect(r.text).toContain('The harness hook records the blocked row when this Bash call completes (not for run_in_background or PowerShell). Confirm with harness verify: exit 3 means blocked, unless a tamper finding makes it not done.');
  expect(r.text).not.toContain('is recorded');
  expect(() => readFileSync(join(root, LEDGER))).toThrow();
});
