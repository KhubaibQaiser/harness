// Hook overhead, measured apart from Node start-up and machine load: each dispatcher spawn is paired with an interleaved
// spawn of an empty script, and the median of the paired differences is what the harness costs. Runs in the `perf`
// project (no file parallelism) as its own CI step, never inside the parallel unit run. No retries: a slow result is real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { attendedEnv, CEILING_MS, COUNTED_EDIT_OVERHEAD_MS, DISPATCH, measure, OVERHEAD_MS, report } from './overhead.js';

// An attended Stop reads git state and the transcript tail, so it gets its own ceilings, set as in overhead.ts (1.25x the
// slowest median, 13-16 Nov 2026). 50 MB transcript: macOS median 129 ms, slowest 328 (04bd10c, failed 250); Windows
// median 374, slowest 422 against 450. 500 decisions: macOS median 411, slowest 864 (04bd10c) and 649 against 650 (b2f7636);
// Windows median 940, slowest 1045, so 1350 stays.
const STOP_OVERHEAD_MS = { win32: 550, darwin: 450 }[process.platform as string] ?? 100;
const WARN_OVERHEAD_MS = { win32: 1350, darwin: 1100 }[process.platform as string] ?? 300;
// 40 result files to read: macOS median 101 ms, slowest 220 (87ab33e); it failed 150 in 10 runs from 9 to 15 Nov, and its
// daily medians did not move (89-106). Windows: median 193, slowest 243.
const GATED_OVERHEAD_MS = { win32: 450, darwin: 300 }[process.platform as string] ?? 100;
// Not raised (owner, 2026-11-18): protect's ref-move check (e82410a) spawned git four times; a switch's two lookups are now
// one cat-file. Before that, macOS over 32 runs (16-17 Nov): median 120 ms, slowest 210, failing 150 in 3 runs on slow runners.
const CHECKOUT_OVERHEAD_MS = { win32: 450, darwin: 150 }[process.platform as string] ?? 100;
// The warning run's total holds its own overhead plus the bare spawn, so it can't share the 1000 ms ceiling where that overhead may reach 1350.
const WARN_CEILING_MS = Math.max(CEILING_MS, WARN_OVERHEAD_MS + 300);

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
  report('ungated-pretooluse', m);
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
  report('unattended-bash', m);
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
  report('gated-40-results', m);
  expect(m.overhead, `gated overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(GATED_OVERHEAD_MS);
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
  report('counted-edit', m);
  expect(m.overhead, `counted edit overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(COUNTED_EDIT_OVERHEAD_MS);
  expect(m.total, `counted edit total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);

// protect diffs a ref move against the protected paths: a plain git status and a checkout with no protected change stay in the plain budget.
test.each(['git status', 'git checkout feat'])('attended Bash `%s`: harness overhead over a bare node spawn', (command) => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-ref-'));
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo });
  g('init', '-q', '-b', 'main');
  mkdirSync(join(repo, '.harness/hooks'), { recursive: true });
  writeFileSync(join(repo, '.harness/hooks/dispatch.mjs'), '');
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  guard: true\n  protect: true\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  g('branch', 'feat');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, tool_name: 'Bash', tool_input: { command } });
  const m = measure(input, (r) => {
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, true);
  report(`ref-move-${command.replace(/\W+/g, '-')}`, m);
  expect(m.overhead, `overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(command === 'git checkout feat' ? CHECKOUT_OVERHEAD_MS : OVERHEAD_MS);
  expect(m.total, `total median ${m.total.toFixed(1)} ms`).toBeLessThan(CEILING_MS);
}, 60000);

// Team-decision nudge: with no stored hit, an attended Stop with no last_assistant_message reads the transcript's
// last 1 MiB for the A signals. A 50 MB transcript must stay inside the plain ceilings.
test('attended Stop with a 50 MB transcript and no stored hit: harness overhead over a bare node spawn', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-stop-'));
  onTestFinished(() => rmSync(repo, { recursive: true, force: true })); // two 50 MB transcripts
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
  report('stop-50mb', m);
  expect(m.overhead, `stop overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(STOP_OVERHEAD_MS);
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
  report('stop-500-decisions', m);
  expect(m.overhead, `warning overhead median ${m.overhead.toFixed(1)} ms`).toBeLessThan(WARN_OVERHEAD_MS);
  expect(m.total, `warning total median ${m.total.toFixed(1)} ms`).toBeLessThan(WARN_CEILING_MS);
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
