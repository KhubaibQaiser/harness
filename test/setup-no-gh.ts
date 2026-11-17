import { vi } from 'vitest';

// Unit tests never reach GitHub or a model: a spawn of the real `gh` throws, and so does any spawn that looks like a paid
// review call, whatever the binary (claudeModel runs the resolved file: npm's cli.js, the native installer's versions/<ver>):
// `--system-prompt-file`, or `-p`/`--print` with `--output-format`. A cmd.exe line is checked as one string. Free calls such as
// `claude --version` still run. Doctor tests inject a fake `gh`; review tests inject a fake model or Exec.
const PRINT = /(^|[\s"^])(-p|--print)(?=[\s"^]|$)/;
const paid = (line: string) => line.includes('--system-prompt-file') || (PRINT.test(line) && line.includes('--output-format'));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: ((cmd: string, ...rest: unknown[]) => {
    if (cmd === 'gh') throw new Error('the test spawned the real gh; pass a fake gh to doctor');
    const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
    const line = [cmd, ...args].join(' ');
    if (paid(line)) throw new Error('the test spawned claude -p (a paid model call); inject a fake ReviewModel or Exec');
    return (actual.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest);
  }) as typeof actual.spawnSync };
});
