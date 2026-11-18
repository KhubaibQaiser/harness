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
export function medianOf<T>(name: string, fn: () => T, runs = 5): { ms: number; result: T } {
  let result = fn();
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = fn();
    ms.push(performance.now() - t);
  }
  const m = median(ms);
  writeSync(2, `[perf] ${name} ${process.platform}: median ${m.toFixed(1)} ms (runs ${ms.map(Math.round).join(' ')})\n`);
  return { ms: m, result };
}

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
