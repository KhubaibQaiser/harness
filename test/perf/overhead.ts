// Shared by the perf files: each dispatcher spawn is paired with an interleaved spawn of an empty script, and the median of
// the paired differences is what the harness costs (see latency.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DISPATCH = join(process.cwd(), 'dist/hooks/dispatch.mjs');
const RUNS = 21;
// Ceilings are about 1.25x the slowest median the CI logs show, rounded up to 50 (13-16 Nov 2026: 126 macos-latest and 97
// windows-latest runs of each latency case, the [perf] lines below). Hosted macOS runners vary: a median of 21 pairs still
// moved 2x between runs of the same code.
// Harness cost on top of a bare node spawn. macOS plain cases: medians 54-71 ms, slowest 147 (unattended Bash), so 150
// had no margin. Windows: slowest 152 ms.
export const OVERHEAD_MS = { win32: 450, darwin: 200 }[process.platform as string] ?? 100;
// A counted edit runs about 7 git calls on purpose (spec §14.2), so it gets its own ceiling. macOS: median 141 ms, slowest
// 324 (failed 300 on ab4ccc6), matched ledger check slowest 259. Windows: counted edit slowest 480, matched check 717.
export const COUNTED_EDIT_OVERHEAD_MS = { win32: 1000, darwin: 450 }[process.platform as string] ?? 200;
export const CEILING_MS = 1000; // gross-regression guard on the whole spawn
// Each median is printed so the next calibration reads measured numbers from the CI log.
export const report = (name: string, m: { overhead: number; total: number }) => writeSync(2, `[perf] ${name} ${process.platform}: overhead ${m.overhead.toFixed(1)} ms, total ${m.total.toFixed(1)} ms\n`); // straight to stderr: the reporter hides a passing test's console

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

export function measure(input: string, check: (r: ReturnType<typeof spawnSync>) => void, attended = false): { overhead: number; total: number } {
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
