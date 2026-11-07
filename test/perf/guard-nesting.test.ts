import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { protect } from '../../src/checks/protect.js';
import { loadConfig } from '../../src/core/config.js';
import type { Ctx } from '../../src/hooks/dispatch.js';

// Re-review 19, N8: every level of nested shells was read again inside the one around it, so a 477-character command
// took 12 s, past the 10 s hook timeout, where a hook fails open. Nesting past the cap is denied at once, and long
// inputs stay linear. Ceiling: 200 ms each.
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const R = 'rm -rf ~';
const nest = (d: number, inner: string) => { let s = inner; for (let i = 0; i < d; i++) s = `bash <<'E${i}'\n${s}\nE${i}`; return s; };
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n');

const time = (c: string) => {
  decideCommand(c, ctx); // warm up the regexes and the JIT
  const t = performance.now();
  const d = decideCommand(c, ctx);
  return { kind: d.kind, ms: performance.now() - t };
};

it.each([
  ['a depth-20 nest before an ask payload', nest(20, 'echo x \\\ny') + '\ngit reset --hard', 'deny'],
  ['a depth-26 nest before a quoted-delimiter body', nest(26, 'echo x \\\ny') + `\ncat > docs/x.md <<'EOF'\nx \\\nEOF\n${R}\nEOF`, 'deny'],
  ['1000 nested heredocs', nest(1000, 'echo hi'), 'deny'],
  ['1000 chained heredocs', lines(1000, (i) => `cat > docs/x${i}.md <<'E${i}'\nline ${i}\nE${i}`), 'allow'],
  ['1000 chained shell heredocs', lines(1000, (i) => `bash <<'E${i}'\necho ${i}\nE${i}`), 'allow'],
  ['10,000 command lines', lines(10_000, (i) => `echo ${i}`), 'allow'],
  ['a 10,000-line heredoc', `cat > docs/x.md <<'EOF'\n${lines(10_000, (i) => `line ${i}`)}\nEOF`, 'allow'],
] as const)('%s', (_name, c, want) => {
  const { kind, ms } = time(c);
  expect(kind).toBe(want);
  expect(ms).toBeLessThan(200);
});

// protect runs in the same hook and read every nested program again for each level around it (55 s at depth 20).
const prot = (command: string) => protect.run({ ...ctx, input: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/p', tool_name: 'Bash', tool_input: { command } } } as unknown as Ctx);
it.each([
  ['protect: a depth-20 nest', nest(20, 'echo x \\\ny'), 'deny'],
  ['protect: 1000 nested heredocs', nest(1000, 'echo hi'), 'deny'],
  ['protect: 1000 chained shell heredocs', lines(1000, (i) => `bash <<'E${i}'\necho ${i}\nE${i}`), 'allow'],
] as const)('%s', (_name, c, want) => {
  prot(c);
  const t = performance.now();
  expect((prot(c) as { kind: string }).kind).toBe(want);
  expect(performance.now() - t).toBeLessThan(200);
});
