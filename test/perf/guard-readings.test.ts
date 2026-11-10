import { expect, it } from 'vitest';
import { decideCommand } from '../../src/checks/guard.js';
import { loadConfig } from '../../src/core/config.js';

// The extra glob and alternation readings must stay bounded: a big heredoc or a crafted command answers well inside the
// hook timeout. Targets are 50 ms (100 KB command) and 20 ms (25 KB heredoc); the ceilings leave 3x for slow CI machines.
const ctx = { config: loadConfig('/nonexistent-harness-root').config, env: {}, root: '/p' };
const KB = 1024;
const alt32 = 'x(' + Array.from({ length: 32 }, (_, i) => 'a' + i).join('|') + ')';
const pad = 'echo ' + 'y'.repeat(2000);
const block = (i: number) => `/**\n * Parses item ${i}.\n * Returns the value.\n */\nexport function f${i}(s: string) {\n  const re = /\\b(foo|bar)\\b/;\n  return re.test(s) ? s.length * 2 : 0;\n}\n`;
const heredoc = (size: number) => {
  let body = '';
  for (let i = 0; body.length < size; i++) body += block(i);
  return `cat > src/x.ts <<'EOF'\n${body}\nEOF`;
};
const big = `${alt32}; * a; s? b; ` + (pad + '; ').repeat(50); // about 100 KB, globs and an alternation in command position

const time = (c: string) => {
  decideCommand(c, ctx); // warm up the regexes and the JIT
  const t = performance.now();
  const d = decideCommand(c, ctx);
  return { kind: d.kind, ms: performance.now() - t };
};

it.each([
  ['a 100 KB command with command-position globs and an alternation', big, 150, 'ask'],
  ['a 25 KB heredoc of TypeScript', heredoc(25 * KB), 60, 'allow'],
  ['3000 glob segments', '* a; '.repeat(3000) + 'echo hi', 150, 'ask'],
  ['2000 wrapper globs before a force push', 's?do '.repeat(2000) + 'g?t push -f', 150, 'ask'],
  ['2000 alternations in one command word', 'x(a|b)'.repeat(2000), 150, 'ask'],
  ['nested sh -c with alternations, globs and padding', `${alt32}; * a; ${pad}; sh -c "${alt32}; * a; ${pad}; sh -c '${alt32}; * a; ${pad}'"`, 150, 'ask'],
] as const)('%s', (_name, c, ceiling, want) => {
  const { kind, ms } = time(c);
  if (want === 'allow') expect(kind).toBe('allow');
  else expect(kind).not.toBe('allow'); // at least ask once a bound is hit
  expect(ms).toBeLessThan(ceiling);
});
