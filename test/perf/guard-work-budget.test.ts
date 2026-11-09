import { expect, it } from 'vitest';
import { guard } from '../../src/checks/guard.js';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import { WORK_BUDGET_WHY } from '../../src/core/shell-words.js';
import type { Ctx } from '../../src/hooks/dispatch.js';
import { MAX_COMMAND_BYTES, runChecks, TOO_LARGE_WHY } from '../../src/hooks/run-checks.js';

// Re-review 21, P1b: four nested shell bodies of 90 KB (`\` CR LF lines, or plain ones) took 3.5 to 11 s in the hook,
// guard then protect, against its 10 s timeout. Each check now has a fixed work budget (WORK_BUDGET_CHARS of text
// split into pieces, every reading at every level counted); past it the check throws WorkBudget and the dispatcher
// denies with its reason. So any input under 100 KB finishes, allowed or denied, within the same ceilings as the
// no-end-line heredoc test (guard and protect together, as the hook runs them).
const CEILING_MS = { win32: 4000, darwin: 1500 }[process.platform as string] ?? 1200;
const config = loadConfig('/nonexistent-harness-root').config;
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');
const nest = (d: number, inner: string) => { let s = inner; for (let i = 0; i < d; i++) s = `bash <<'E${i}'\n${s}\nE${i}`; return s; };
const hook = (command: string) => {
  const input = { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command } };
  return runChecks({ input, root: '/p', config, env: {}, unattended: false } as unknown as Ctx, [guard, protect], false, () => {});
};

it.each([
  ['four nested shell bodies of `\\` CR LF lines', nest(4, lines(7000, (i) => `echo ${i} \\\r`)), 'deny'],
  ['four nested shell bodies of `\\\\\\` CR LF lines', nest(4, lines(6500, (i) => `echo ${i} \\\\\\\r`)), 'deny'],
  ['four nested shell bodies of plain lines', nest(4, lines(9000, (i) => `echo ${i}`)), 'deny'],
  ['one shell body of `\\` CR LF lines', `bash <<'E'\n${lines(7700, (i) => `echo ${i} \\\r`)}\nE`, 'allow'],
  ['10,000 command lines', lines(10_000, (i) => `echo ${i}`), 'allow'],
] as const)('%s', async (_name, c, want) => {
  expect(c.length).toBeLessThan(100_000);
  await hook(c); // warm up the regexes and the JIT
  const t = performance.now();
  const ds = await hook(c);
  const ms = performance.now() - t;
  expect(ds.find((d) => d.kind === 'deny')?.kind ?? 'allow').toBe(want);
  if (want === 'deny') expect(ds[0]).toMatchObject({ kind: 'deny', reason: WORK_BUDGET_WHY, check: 'guard' });
  expect(ms).toBeLessThan(CEILING_MS);
});

// Re-review 22b, F4: `${` with no `}`, many times, in text that names harness, made the BUILDS regex quadratic (10 s at
// 250 KB, no budget charged). It is linear now; and any Bash command over MAX_COMMAND_BYTES is denied before a check runs.
it.each([95_000, 250_000])('%i bytes of unclosed ${ finish within the ceiling', async (n) => {
  const c = `echo harness ${'${a'.repeat(Math.ceil(n / 3))}\necho SENTINEL`;
  await hook(c);
  const t = performance.now();
  await hook(c);
  expect(performance.now() - t).toBeLessThan(CEILING_MS);
});
it('a Bash command over 256 KB is denied with its reason, before any check reads it', async () => {
  const ds = await hook(`echo ${'a'.repeat(MAX_COMMAND_BYTES)}`);
  expect(ds).toEqual([{ kind: 'deny', reason: TOO_LARGE_WHY, check: 'harness' }]);
  expect(await hook(`echo ${'a'.repeat(MAX_COMMAND_BYTES - 6)}`)).toEqual([]);
});
