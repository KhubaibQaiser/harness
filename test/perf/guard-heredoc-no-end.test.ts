import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import type { Ctx } from '../../src/hooks/dispatch.js';

// Re-review 20, P1: each heredoc operator with no end line searched to the end of the text again, and built its body,
// so 19,000 `:<<A` lines (95 KB) took 20 s in the hook (guard, then protect), past its 10 s timeout. Now each end line
// is found in one step and a body is built only for a program something reads; protect checks a stdin program that
// lies inside one it already checked once. The ceiling is for guard and protect together, as the hook runs them, on
// inputs under 100 KB: linear but large, so it sits above the nesting test's and far under the timeout.
const CEILING_MS = { win32: 4000, darwin: 1500 }[process.platform as string] ?? 1200;
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const R = `${String.fromCharCode(114, 109)} -rf ~`;
const lines = (n: number, line: string) => Array(n).fill(line).join('\n');
const prot = (command: string) =>
  (protect.run({ ...ctx, input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command } } } as unknown as Ctx) as { kind: string }).kind;

it.each([
  ['19,000 heredocs with no end line', lines(19_000, ':<<A'), 'allow', 'allow'],
  ['12,000 cat heredocs with no end line', lines(12_000, 'cat <<A'), 'allow', 'allow'],
  ['a payload before 19,000 heredocs with no end line', `${R}\n${lines(19_000, ':<<A')}`, 'deny', 'allow'],
  ['9,000 shell heredocs with no end line', lines(9_000, 'bash <<A'), 'deny', 'deny'],
  ['8,000 node heredocs with no end line', lines(8_000, 'node <<A'), 'allow', 'allow'],
  ['9,000 python heredocs with no end line', lines(9_000, 'python <<A'), 'allow', 'allow'],
] as const)('%s', (_name, c, guardWants, protectWants) => {
  expect(c.length).toBeLessThan(100_000);
  decideCommand(c, ctx); // warm up the regexes and the JIT
  prot(c);
  const t = performance.now();
  expect(decideCommand(c, ctx).kind).toBe(guardWants);
  expect(prot(c)).toBe(protectWants);
  expect(performance.now() - t).toBeLessThan(CEILING_MS);
});
