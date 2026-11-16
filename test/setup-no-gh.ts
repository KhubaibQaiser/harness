import { basename } from 'node:path';
import { vi } from 'vitest';

// Unit tests never reach GitHub or a model: a spawn of the real `gh` throws, and so does any `claude -p` (a paid call;
// on Windows a .cmd shim runs through cmd.exe, so its command line is checked too). Free calls such as
// `claude --version` still run. Doctor tests inject a fake `gh`; review tests inject a fake model or Exec.
const PRINT = /(^|[\s"^])(-p|--print)(?=[\s"^]|$)/;
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: ((cmd: string, ...rest: unknown[]) => {
    if (cmd === 'gh') throw new Error('the test spawned the real gh; pass a fake gh to doctor');
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const line = [cmd, ...args].join(' ');
    if ((/^claude(\.(cmd|exe|bat))?$/i.test(basename(cmd)) && args.some((a) => a === '-p' || a === '--print')) || (/claude/i.test(line) && /cmd(\.exe)?$/i.test(basename(cmd)) && PRINT.test(line)))
      throw new Error('the test spawned claude -p (a paid model call); inject a fake ReviewModel or Exec');
    return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.spawnSync };
});
