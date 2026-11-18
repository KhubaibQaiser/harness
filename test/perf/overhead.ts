// Shared by the perf files: each dispatcher spawn is paired with an interleaved spawn of an empty script, and the median of
// the paired differences is what the harness costs (see latency.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DISPATCH = join(process.cwd(), 'dist/hooks/dispatch.mjs');
const RUNS = 21;
// Overhead ceilings are ratios: the harness overhead in units of the bare node spawn timed beside it in the same run, so a
// slow runner moves both and only a slower harness moves the ratio. Absolute ms ceilings failed on slow hosted runners:
// macOS overhead varied 0.24-0.31 (coefficient of variation) across runs, the ratio 0.10-0.18, and overhead and bare spawn
// correlate at 0.78-0.90 (Windows 0.85-0.98). CI logs of the last 100 ci.yml runs, 15-18 Nov 2026 (43734056767 to
// 44250315112), the [perf] lines below: 95 macos-latest and 78 windows-latest runs of each case. The 209.9 ms checkout that
// failed 150 ms was 3.50x a 60 ms bare spawn, a normal ratio.
// Each ratio is 1.25x the slowest the logs show, rounded up to 0.5, and at the median bare spawn (macOS about 35 ms,
// Windows about 46.5) it allows no more ms than the old absolute ceiling did, so it is never looser on a typical runner.
// A 200 ms slower hook adds about 5.8 (macOS) and 4.2 (Windows) to the ratio. Other platforms use the macOS numbers.
export const ratio = (r: { win32: number; darwin: number }) => (process.platform === 'win32' ? r.win32 : r.darwin);
// Plain cases (ungated, unattended Bash, git status, the non-check ledger cases): slowest 3.00 macOS, 2.86 Windows.
// About 140 and 186 ms at the median bare spawn, against the old 200 and 450.
export const OVERHEAD_RATIO = ratio({ darwin: 4, win32: 4 });
// A counted edit runs about 7 git calls on purpose (spec §14.2): slowest 5.97 macOS, 9.55 Windows (old 450 and 1000 ms).
export const COUNTED_EDIT_RATIO = ratio({ darwin: 7.5, win32: 12 });
// A matched ledger check hashes a 500-file tree: slowest 5.07 macOS, 20.15 Windows. 1.25x would be 25.5 on Windows, 1200 ms
// at the median bare spawn against the old 1000, so Windows stays at 21 (about 980 ms), above every logged run.
export const LEDGER_CHECK_RATIO = ratio({ darwin: 6.5, win32: 21 });
export const CEILING_MS = 1000; // gross-regression guard on the whole spawn
// Each median is printed so the next calibration reads measured numbers from the CI log.
export const report = (name: string, m: { overhead: number; total: number } & Partial<Measured>) => writeSync(2, `[perf] ${name} ${process.platform}: overhead ${m.overhead.toFixed(1)} ms, total ${m.total.toFixed(1)} ms${m.ratio === undefined ? '' : `, bare ${m.bare!.toFixed(1)} ms, ratio ${m.ratio.toFixed(2)}`}\n`); // straight to stderr: the reporter hides a passing test's console

export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/** One warm-up call (the regexes, the JIT, the file-system cache), then the median of `runs` timed calls, which drops a
 *  one-off slow sample on a hosted runner. Logged like `report`, so the next calibration reads CI numbers. */
export function medianOf<T>(name: string, fn: () => T, runs = 5, withReference = false): { ms: number; result: T } {
  let result = fn();
  if (withReference) referenceMs(); // its own warm-up
  const ms: number[] = [];
  const ref: number[] = [];
  for (let i = 0; i < runs; i++) {
    // Alternate which goes first, so a drift in load hits both alike.
    if (withReference && i % 2) ref.push(referenceMs());
    const t = performance.now();
    result = fn();
    ms.push(performance.now() - t);
    if (withReference && !(i % 2)) ref.push(referenceMs());
  }
  const m = median(ms);
  writeSync(2, `[perf] ${name} ${process.platform}: median ${m.toFixed(1)} ms (runs ${ms.map(Math.round).join(' ')})${withReference ? referenceNote(m, ref) : ''}\n`);
  return { ms: m, result };
}

// A fixed CPU workload in plain JS (no harness code), timed between the samples of an in-process perf case. Logged only,
// for now: after about a week of CI data, these cases can assert `ratio` (their median over this one's) instead of
// absolute ms, as the spawn cases do with the bare node spawn. Its shape (regex tokenizing of shell-like text) matches the
// guard's work, so a slow runner slows both alike. ponytail: logging only; the absolute ceilings still decide.
const REF_TEXT = Array.from({ length: 400 }, (_, i) => `echo ${i} "a b" | grep -E '(x|y)+' && ls *.ts; cat <<'E'\nline ${i}\nE`).join('\n');
export function referenceMs(): number {
  const t = performance.now();
  let n = 0;
  for (let k = 0; k < 10; k++) for (const m of REF_TEXT.matchAll(/'[^']*'|"[^"]*"|[|&;<>]+|[^\s|&;<>'"]+/g)) n += m[0].length;
  const ms = performance.now() - t;
  if (n !== 10 * REF_N) throw new Error(`reference workload changed: ${n}`); // uses the result, so the loop can't be dropped
  return ms;
}
const REF_N = [...REF_TEXT.matchAll(/'[^']*'|"[^"]*"|[|&;<>]+|[^\s|&;<>'"]+/g)].reduce((a, m) => a + m[0].length, 0);
/** The `[perf]` suffix: the reference median and the case's ratio to it. */
export const referenceNote = (ms: number, ref: number[]) => {
  const r = median(ref);
  return `, reference ${r.toFixed(2)} ms, ratio ${(ms / r).toFixed(2)}`;
};

// CI sets CI=true, which makes every hook unattended; an attended case drops the unattended signals.
const UNATTENDED_KEYS = ['CI', 'HARNESS_UNATTENDED', 'CLAUDE_CODE_REMOTE'];
export const attendedEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !UNATTENDED_KEYS.includes(k)));

export type Measured = { overhead: number; total: number; bare: number; ratio: number };
/** The harness overhead (median paired difference), the totals, the bare spawn's median, and `ratio`: the overhead in
 *  units of that bare spawn, measured in the same run. A slow runner slows both alike; a slower harness moves only the ratio. */
export function measure(input: string, check: (r: ReturnType<typeof spawnSync>) => void, attended = false): Measured {
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
  const bares: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    // Alternate which goes first, so a drift in load hits both sides alike.
    let hook, bare;
    if (i % 2) (hook = time([DISPATCH], input)), (bare = time([empty]));
    else (bare = time([empty])), (hook = time([DISPATCH], input));
    check(hook.r);
    diffs.push(hook.ms - bare.ms);
    totals.push(hook.ms);
    bares.push(bare.ms);
  }
  const overhead = median(diffs);
  const bare = median(bares);
  return { overhead, total: median(totals), bare, ratio: overhead / bare };
}
