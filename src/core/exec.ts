import { spawnSync } from 'node:child_process';
import { findOnPath, syncCommand } from '../checks/stop/runner.js';

// Not checks/stop's Exec (async, timeout, merged output): this one is a sync, argv-only call that reports a missing binary.
export type Exec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr?: string; missing?: true };

export const defaultExec: Exec = (cmd, args) => {
  if (!findOnPath(cmd, process.env, process.platform)) return { status: 127, stdout: '', missing: true };
  const [file, a, opts] = syncCommand(cmd, args);
  const r = spawnSync(file, a, { ...opts, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
};
