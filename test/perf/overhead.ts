// Shared by the perf files: each dispatcher spawn is paired with an interleaved spawn of an empty script, and the median of
// the paired differences is what the harness costs (see latency.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DISPATCH = join(process.cwd(), 'dist/hooks/dispatch.mjs');
const RUNS = 21;
export const OVERHEAD_MS = { win32: 450, darwin: 150 }[process.platform as string] ?? 100; // harness cost on top of a bare node spawn; hosted runners vary (Windows 402–407 ms at 250, macOS 105–108 ms at 100)
// A counted edit runs about 7 git calls on purpose (spec §14.2), so it gets its own ceiling. Hosted runners measured macOS 154–166 ms and Windows 490 ms (Nov 2026); about 2x headroom.
export const COUNTED_EDIT_OVERHEAD_MS = { win32: 1000, darwin: 300 }[process.platform as string] ?? 200;
export const CEILING_MS = 1000; // gross-regression guard on the whole spawn
// Each median is printed so the next calibration reads measured numbers from the CI log.
export const report = (name: string, m: { overhead: number; total: number }) => writeSync(2, `[perf] ${name} ${process.platform}: overhead ${m.overhead.toFixed(1)} ms, total ${m.total.toFixed(1)} ms\n`); // straight to stderr: the reporter hides a passing test's console

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

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
