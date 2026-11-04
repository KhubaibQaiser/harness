import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { findOnPath, syncCommand } from '../checks/stop/runner.js';

// Not checks/stop's Exec (async, timeout, merged output): this one is a sync, argv-only call that reports a missing binary.
export type Exec = (cmd: string, args: string[]) => { status: number; stdout: string; stderr?: string; missing?: true };

export const defaultExec: Exec = (cmd, args) => {
  if (!findOnPath(cmd, process.env, process.platform)) return { status: 127, stdout: '', missing: true };
  const [file, a, opts] = syncCommand(cmd, args);
  const r = spawnSync(file, a, { ...opts, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
};

export type ExecBytes = (cmd: string, args: string[], maxBytes: number) => { status: number; stdout: Buffer; stderr?: string; missing?: true; tooBig?: true };

/** Like defaultExec but stdout stays binary and is capped at maxBytes (for tarballs). */
export const defaultExecBytes: ExecBytes = (cmd, args, maxBytes) => {
  if (!isAbsolute(cmd) && !findOnPath(cmd, process.env, process.platform)) return { status: 127, stdout: Buffer.alloc(0), missing: true };
  const [file, a, opts] = syncCommand(cmd, args);
  const r = spawnSync(file, a, { ...opts, encoding: 'buffer', maxBuffer: maxBytes, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return { status: 127, stdout: Buffer.alloc(0), missing: true };
  const tooBig = code === 'ENOBUFS';
  return { status: r.status ?? 1, stdout: tooBig ? Buffer.alloc(0) : (r.stdout ?? Buffer.alloc(0)), stderr: r.stderr?.toString() || r.error?.message || '', ...(tooBig ? { tooBig: true as const } : {}) };
};
