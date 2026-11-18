// Hook overhead, measured apart from Node start-up and machine load: each dispatcher spawn is paired with an interleaved
// spawn of an empty script, and the median of the paired differences is what the harness costs. Runs in the `perf`
// project (no file parallelism) as its own CI step, never inside the parallel unit run. No retries: a slow result is real.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { attendedEnv, CEILING_MS, COUNTED_EDIT_RATIO, DISPATCH, measure, OVERHEAD_RATIO, ratio, report } from './overhead.js';

// Ratios to the paired bare spawn, set as in overhead.ts (1.25x the slowest the CI logs show, 15-18 Nov 2026; in ms at the
// median bare spawn, each is under the old absolute ceiling it replaces).
// An attended Stop reads git state and the transcript tail. 50 MB transcript: slowest 6.79 macOS, 8.27 Windows (old 450
// and 550 ms). 500 decisions: slowest 14.72 macOS, 21.36 Windows (old 1100 and 1350 ms).
const STOP_RATIO = ratio({ darwin: 8.5, win32: 10.5 });
const WARN_RATIO = ratio({ darwin: 18.5, win32: 27 });
// 40 result files to read: slowest 4.12 macOS, 4.94 Windows (old 300 and 450 ms).
const GATED_RATIO = ratio({ darwin: 5.5, win32: 6.5 });
// protect's ref-move check looks the ref and its hooks up in one git call: slowest 4.83 macOS, 6.41 Windows (old 300 and 450 ms).
const CHECKOUT_RATIO = ratio({ darwin: 6.5, win32: 8.5 });
// The warning run's total holds its own overhead plus the bare spawn, so it keeps the old totals above the 1000 ms ceiling.
const WARN_CEILING_MS = { win32: 1650, darwin: 1400 }[process.platform as string] ?? CEILING_MS;

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
  expect(m.ratio, `overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(OVERHEAD_RATIO);
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
  expect(m.ratio, `unattended overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(OVERHEAD_RATIO);
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
  expect(m.ratio, `gated overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(GATED_RATIO);
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
  expect(m.ratio, `counted edit overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(COUNTED_EDIT_RATIO);
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
  expect(m.ratio, `overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(command === 'git checkout feat' ? CHECKOUT_RATIO : OVERHEAD_RATIO);
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
  expect(m.ratio, `stop overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(STOP_RATIO);
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
  expect(m.ratio, `warning overhead ${m.overhead.toFixed(1)} ms, ${m.ratio.toFixed(2)}x the bare spawn`).toBeLessThan(WARN_RATIO);
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
