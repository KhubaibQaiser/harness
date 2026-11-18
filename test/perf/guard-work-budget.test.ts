import { writeSync } from 'node:fs';
import { expect, it } from 'vitest';
import { guard } from '../../src/checks/guard.js';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { WORK_BUDGET_WHY } from '../../src/core/shell-words.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { MAX_COMMAND_BYTES, runChecks, TOO_LARGE_WHY } from '../../src/hooks/run-checks.js';
import { referenceMs, referenceNote } from './overhead.js';

// Re-review 21, P1b: four nested shell bodies of 90 KB (`\` CR LF lines, or plain ones) took 3.5 to 11 s in the hook,
// guard then protect, against its 10 s timeout. Each check now has a fixed work budget (WORK_BUDGET_CHARS of text
// split into pieces, every reading at every level counted); past it the check throws WorkBudget and the dispatcher
// denies with its reason. So any input under 100 KB finishes, allowed or denied, within a fixed ceiling (guard and
// protect together, as the hook runs them).
// The time is in-process CPU work, no spawn or I/O, bounded by the budget, so on hosted runners it moves with the
// machine. macos-latest, 210 runs from 10 to 16 Nov 2026: one timed hook a case failed 1500 ms in 10 of them, and the
// failing main run 43800440843 has the same tree as its passing PR run 43798525457. A failure was one slow sample
// (1510 ms after an 870 ms warm-up) or a slow runner (both samples 1650-1730 ms, plain lines, on 129c406 and 8f76fab).
// So each case takes the median of RUNS hooks, which drops a one-off slow sample, and macOS gets 2500 ms: about 1.45x
// the slowest runner seen, well under the 3.5 to 11 s the unbudgeted input took. Six hooks fit the 30 s test timeout.
// windows-latest, 174 runs: none failed; the slowest case logged 2857 ms for warm-up plus timed hook, about 1430 each.
const CEILING_MS = { win32: 4000, darwin: 2500 }[process.platform as string] ?? 1200;
const RUNS = 5;
const config = loadConfig('/nonexistent-harness-root').config;
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const nest = (d: number, inner: string) => { let s = inner; for (let i = 0; i < d; i++) s = `bash <<'E${i}'\n${s}\nE${i}`; return s; };
const hook = (command: string) => {
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command } };
  return runChecks({ input, root: '/p', config, env: {}, unattended: false } as unknown as Ctx, [guard, protect], false, () => {});
};
/** The median time of RUNS hooks on `command`, after one warm-up (the regexes and the JIT), and the last decisions. Logged
 *  straight to stderr, so the next calibration reads measured numbers from the CI log. */
const timed = async (name: string, command: string) => {
  let ds = await hook(command);
  referenceMs(); // its own warm-up
  const ms: number[] = [];
  const ref: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    if (i % 2) ref.push(referenceMs()); // alternate which goes first
    const t = performance.now();
    ds = await hook(command);
    ms.push(performance.now() - t);
    if (!(i % 2)) ref.push(referenceMs());
  }
  const median = [...ms].sort((a, b) => a - b)[RUNS >> 1]!;
  writeSync(2, `[perf] guard-work-budget ${name} ${process.platform}: median ${median.toFixed(0)} ms (runs ${ms.map(Math.round).join(' ')}), ceiling ${CEILING_MS}${referenceNote(median, ref)}\n`);
  return { ds, median };
};

it.each([
  ['four nested shell bodies of `\\` CR LF lines', nest(4, lines(7000, (i) => `echo ${i} \\\r`)), 'deny'],
  ['four nested shell bodies of `\\\\\\` CR LF lines', nest(4, lines(6500, (i) => `echo ${i} \\\\\\\r`)), 'deny'],
  ['four nested shell bodies of plain lines', nest(4, lines(9000, (i) => `echo ${i}`)), 'deny'],
  ['one shell body of `\\` CR LF lines', `bash <<'E'\n${lines(7700, (i) => `echo ${i} \\\r`)}\nE`, 'allow'],
  ['10,000 command lines', lines(10_000, (i) => `echo ${i}`), 'allow'],
] as const)('%s', async (name, c, want) => {
  expect(c.length).toBeLessThan(100_000);
  const { ds, median } = await timed(name, c);
  expect(ds.find((d) => d.kind === 'deny')?.kind ?? 'allow').toBe(want);
  if (want === 'deny') expect(ds[0]).toMatchObject({ kind: 'deny', reason: WORK_BUDGET_WHY, check: 'guard' });
  expect(median).toBeLessThan(CEILING_MS);
});

// Re-review 22b, F4: `${` with no `}`, many times, in text that names harness, made the BUILDS regex quadratic (10 s at
// 250 KB, no budget charged). It is linear now; and any Bash command over MAX_COMMAND_BYTES is denied before a check runs.
it.each([95_000, 250_000])('%i bytes of unclosed ${ finish within the ceiling', async (n) => {
  const c = `echo harness ${'${a'.repeat(Math.ceil(n / 3))}\necho SENTINEL`;
  expect((await timed(`${n} bytes of unclosed \${`, c)).median).toBeLessThan(CEILING_MS);
});
it('a Bash command over 256 KB is denied with its reason, before any check reads it', async () => {
  const ds = await hook(`echo ${'a'.repeat(MAX_COMMAND_BYTES)}`);
  expect(ds).toEqual([{ kind: 'deny', reason: TOO_LARGE_WHY, check: 'harness' }]);
  expect(await hook(`echo ${'a'.repeat(MAX_COMMAND_BYTES - 6)}`)).toEqual([]);
});
// Re-review 23b, N3: the cap measures the text the checks read, String(command), whatever its type.
it('a non-string Bash command over 256 KB is denied before any check reads it', async () => {
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command: ['x'.repeat(MAX_COMMAND_BYTES + 1)] } };
  const ds = await runChecks({ input, root: '/p', config, env: {}, unattended: false } as unknown as Ctx, [guard, protect], false, () => {});
  expect(ds).toEqual([{ kind: 'deny', reason: TOO_LARGE_WHY, check: 'harness' }]);
});
// Re-review 23b, N2: an open `$(cat <<EOF` before a newline run made protect's commit-body regex quadratic (15 s at 80 KB).
it.each([80_000, 256 * 1024 - 64])('%i bytes of newlines after an open commit body finish within the ceiling', async (n) => {
  const c = 'git commit -m "$(cat <<EOF\n' + '\n'.repeat(n) + '"';
  expect((await timed(`${n} bytes of newlines after an open commit body`, c)).median).toBeLessThan(CEILING_MS);
});
