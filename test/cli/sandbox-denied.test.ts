// With sandbox.filesystem.denyWrite on harness's files, a harness command the agent runs in Bash (remember, tdd on, …)
// can hit EPERM. Every command then prints the person's own `!` command, as init and update already do.
import { expect, test } from 'vitest';
import { deniedHint } from '../../src/cli/own-command.js';

const err = (code: string) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test('an EPERM or EACCES from any command gives the `!` line with that command', () => {
  for (const code of ['EPERM', 'EACCES']) {
    const h = deniedHint(['remember', 'add', '--title', 'x y'], err(code));
    expect(h).toMatch(/^Claude Code's sandbox blocks harness's own files\. Run this yourself with Claude Code's `!` prefix/);
    expect(h).toMatch(/ remember add --title 'x y'$/);
  }
  expect(deniedHint(['tdd', 'on'], { cause: err('EPERM') })).toMatch(/ tdd on$/);
});

test('any other error is not a sandbox denial', () => {
  expect(deniedHint(['status'], err('ENOENT'))).toBeNull();
  expect(deniedHint(['status'], new Error('boom'))).toBeNull();
});
