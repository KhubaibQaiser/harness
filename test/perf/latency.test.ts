// Hook overhead, measured apart from Node start-up and machine load: each dispatcher spawn is paired with an interleaved
// spawn of an empty script, and the median of the paired differences is what the harness costs. Runs in the `perf`
// project (no file parallelism) as its own CI step, never inside the parallel unit run. No retries: a slow result is real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const DISPATCH = join(process.cwd(), 'dist/hooks/dispatch.mjs');
const RUNS = 21;
const OVERHEAD_MS = { win32: 450, darwin: 150 }[process.platform as string] ?? 100; // harness cost on top of a bare node spawn; hosted runners vary (Windows 402–407 ms at 250, macOS 105–108 ms at 100)
// A counted edit runs about 7 git calls on purpose (spec §14.2), so it gets its own ceiling. Hosted runners measured macOS 154–166 ms and Windows 490 ms (Nov 2026); about 2x headroom.
const COUNTED_EDIT_OVERHEAD_MS = { win32: 1000, darwin: 300 }[process.platform as string] ?? 200;
const CEILING_MS = 1000; // gross-regression guard on the whole spawn

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// CI sets CI=true, which makes every hook unattended; an attended case drops the unattended signals.
const UNATTENDED_KEYS = ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE'];
const attendedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !UNATTENDED_KEYS.includes(k)));

function measure(input: string, check: (r: ReturnType<typeof spawnSync>) => void, attended = false): { overhead: number; total: number } {
  const home = mkdtempSync(join(tmpdir(), 'h-lat-empty-')); // also the spawns' home: the hook never reads the real ~/.claude
  const empty = join(home, 'empty.mjs');
  writeFileSync(empty, '');
  const env: NodeJS.ProcessEnv = { ...(attended ? attendedEnv(process.env) : process.env), HOME: home, USERPROFILE: home };
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

// Team-decision nudge: with no stored hit, an attended Stop with no last_assistant_message reads the transcript's
// last 1 MiB for the A signals. A 50 MB transcript must stay inside the plain ceilings.
test('attended Stop with a 50 MB transcript and no stored hit: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-stop-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } }) + '\n';
  const t = join(repo, 't.jsonl');
  writeFileSync(t, line.repeat(Math.ceil((50 * 1024 * 1024) / line.length)));
  const input = (session: string, path: string) => JSON.stringify({ hook_event_name: 'Stop', session_id: session, cwd: repo, transcript_path: path });
  const m = measure(input('lat', t), (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, true);
  // Control: the tail is read, so an A signal at the end shows the nudge.
  const hit = join(repo, 'hit.jsonl');
  writeFileSync(hit, readFileSync(t, 'utf8') + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: "I'll remember that." }] } }) + '\n');
  const ctl = spawnSync(process.execPath, [DISPATCH], { input: input('ctl', hit), encoding: 'utf8', env: { ...attendedEnv(process.env), HOME: repo, USERPROFILE: repo } });
  expect(ctl.stdout).toContain('team decision');
  expect(m.overhead, `stop overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS);
  expect(m.total, `stop total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 120000);

// Team-decision warning: 500 decisions all linked to the changed file. The Stop names at most 10 and stays inside the ceilings.
test('attended Stop with 500 team decisions covering the changed file: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-warn-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, 'docs/decisions'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/a.ts'), 'x\n'); // untracked: the session's changed file
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < 500; i++) {
    const id = `2026-11-01-d${String(i).padStart(3, '0')}`;
    writeFileSync(join(repo, `docs/decisions/${id}.md`), `---\nschema: harness-decision/1\nid: ${id}\ntitle: Decision ${i}\nstatus: active\npaths:\n  - "src/**"\nverified_at: ${'a'.repeat(40)}\nverified_on: ${today}\n---\n**Rule:** Do it.\n`);
  }
  const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 'lat', cwd: repo });
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('team decision `2026-11-01-d000`');
    rmSync(join(repo, '.harness/state/lat.json'), { force: true }); // every run is the session's first warning
  }, true);
  expect(m.overhead, `warning overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(OVERHEAD_MS * 3);
  expect(m.total, `warning total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 120000);

// Final review I3: links back into .claude/rules once took 22 s at 3 links and never finished at 4. Each folder is now
// searched once, so 6 self-links and a loop through a parent finish in about a plain run's time.
test.skipIf(process.platform === 'win32')('harness context with symlink loops under .claude/rules stays fast', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-loop-'));
  mkdirSync(join(repo, '.claude/rules/sub'), { recursive: true });
  writeFileSync(join(repo, '.claude/rules/a.md'), 'A\n');
  for (let i = 1; i <= 6; i++) symlinkSync('.', join(repo, `.claude/rules/l${i}`), 'dir');
  symlinkSync('..', join(repo, '.claude/rules/sub/up'), 'dir');
  const t = performance.now();
  const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/cli.mjs'), 'context', '--offline'], { cwd: repo, encoding: 'utf8', timeout: 10_000 });
  const ms = performance.now() - t;
  expect(r.stdout).toContain('.claude/rules/l1: already searched (symlink)');
  expect(ms, `context with loops took ${ms.toFixed(0)} ms`).toBeLessThan(CEILING_MS * 2);
}, 30000);
