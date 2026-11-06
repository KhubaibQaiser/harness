// Hook overhead, measured apart from Node start-up and machine load: each dispatcher spawn is paired with an interleaved
// spawn of an empty script, and the median of the paired differences is what the harness costs. Runs in the `perf`
// project (no file parallelism) as its own CI step, never inside the parallel unit run. No retries: a slow result is real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const DISPATCH = join(process.cwd(), 'dist/hooks/dispatch.mjs');
const RUNS = 21;
const OVERHEAD_MS = { win32: 450, darwin: 150 }[process.platform as string] ?? 100; // harness cost on top of a bare node spawn; hosted runners vary (Windows 402–407 ms at 250, macOS 105–108 ms at 100)
// A counted edit runs about 7 git calls on purpose (spec §14.2), so it gets its own ceiling. macOS runners measured 154–166 ms in Nov 2026; Windows stayed under 450.
const COUNTED_EDIT_OVERHEAD_MS = { win32: 450, darwin: 300 }[process.platform as string] ?? 200;
const CEILING_MS = 1000; // gross-regression guard on the whole spawn

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function measure(input: string, check: (r: ReturnType<typeof spawnSync>) => void): { overhead: number; total: number } {
  const home = mkdtempSync(join(tmpdir(), 'h-lat-empty-')); // also the spawns' home: the hook never reads the real ~/.claude
  const empty = join(home, 'empty.mjs');
  writeFileSync(empty, '');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CONFIG_DIR; // the hook reads its own home only
  delete env.HARNESS_SANDBOX;
  const time = (args: string[], stdin?: string) => {
    const t = performance.now();
    const r = spawnSync(process.execPath, args, { input: stdin, encoding: 'utf8', env });
    return { ms: performance.now() - t, r };
  };
  const diffs: number[] = [];
  const totals: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    // Alternate which goes first, so a drift in load hits both sides alike.
    let hook, bare;
    if (i % 2) (hook = time([DISPATCH], input)), (bare = time([empty]));
    else (bare = time([empty])), (hook = time([DISPATCH], input));
    check(hook.r);
    diffs.push(hook.ms - bare.ms);
    totals.push(hook.ms);
  }
  return { overhead: median(diffs), total: median(totals) };
}

test('ungated PreToolUse: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.harness'));
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  guard: true\n  protect: true\n  depVerify: true\n  multiFile: true\n  tdd: true\n  stop: true\n');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/a.ts'), old_string: 'a', new_string: 'b' } });
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
  expect(m.overhead, `overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);

test('unattended Bash (sandbox-required reads managed settings): harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat3-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.harness'));
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  guard: true\n  protect: true\n');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    // No sandbox: the check ran to its end. Native Windows has none to require (D2), so there it allows.
    if (process.platform === 'win32') expect(r.stdout).toBe('');
    else expect(JSON.parse(String(r.stdout)).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  expect(m.overhead, `unattended overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `unattended total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);

test('gated PreToolUse with 40 result files: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat2-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.harness/results'), { recursive: true });
  mkdirSync(join(repo, '.harness/state'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  multiFile: true\n  tdd: true\ntdd:\n  paths: ["packages/**"]\n');
  writeFileSync(join(repo, '.harness/state/lat.json'), JSON.stringify({ startedAt: Date.now() - 60000, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 }));
  const base = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/results/vitest.json'), 'utf8'));
  const tpl = base.testResults[0];
  for (let i = 0; i < 40; i++) {
    const file = i === 7 ? 'packages/core/src/a.test.ts' : `packages/core/src/f${i}.test.ts`;
    const assertionResults = Array.from({ length: 50 }, (_, k) => ({ ...tpl.assertionResults[0], fullName: `t${k}`, title: `t${k}`, status: i === 7 && k === 0 ? 'failed' : 'passed' }));
    const status = i === 7 ? 'failed' : 'passed';
    writeFileSync(join(repo, `.harness/results/r${i}.json`), JSON.stringify({ ...base, testResults: [{ ...tpl, name: join(repo, file), status, assertionResults }] }));
  }
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'packages/core/src/a.ts'), old_string: 'a', new_string: 'b' } });
  // tmpdir is used as is (/var on macOS, /private/var for git): the code must handle the symlink.
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // allowed: fresh failing related result
  });
  expect(m.overhead, `gated overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `gated total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
  // Control: a passing related result must deny, proving the gate ran on this path.
  const failing = join(repo, '.harness/results/r7.json');
  writeFileSync(failing, readFileSync(failing, 'utf8').replaceAll('"failed"', '"passed"'));
  const c = spawnSync(process.execPath, [DISPATCH], { input, encoding: 'utf8' });
  expect(JSON.parse(c.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
}, 60000);

test('counted PostToolUse Edit in a 20-file repo with checks.prSize on: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat4-'));
  const g = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  for (let i = 0; i < 20; i++) (mkdirSync(join(repo, 'src'), { recursive: true }), writeFileSync(join(repo, `src/f${i}.ts`), 'x\n'.repeat(20)));
  mkdirSync(join(repo, '.harness'));
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  prSize: true\n'); // committed, as an install's is
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  g('checkout', '-q', '-b', 'feat');
  writeFileSync(join(repo, 'src/f0.ts'), 'y\n'.repeat(30));
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'lat', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/f0.ts'), old_string: 'x', new_string: 'y' }, tool_response: {} });
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // under the target: measured, nothing to say
  });
  // Control: the edit was measured, so the progress file holds this branch's size.
  expect(JSON.parse(readFileSync(join(repo, '.harness/state/pr-progress.json'), 'utf8')).feat).toMatchObject({ lines: 50, files: 1 });
  console.log(`pr-size counted edit: overhead median ${m.overhead.toFixed(1)} ms, total median ${m.total.toFixed(1)} ms`);
  expect(m.overhead, `counted edit overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(COUNTED_EDIT_OVERHEAD_MS);
  expect(m.total, `counted edit total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);
