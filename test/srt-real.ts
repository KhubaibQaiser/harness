import { spawnSync } from 'node:child_process';
import { SRT_MIN } from '../src/checks/stop/srt.js';
import { olderThan } from '../src/core/min-claude.js';

// Shared by the real-srt e2e and perf files. Both run only with HARNESS_E2E_SRT=1 (the stop-srt CI job).
export const SRT_ON = process.env.HARNESS_E2E_SRT === '1';

/** The installed srt version. Throws, so the importing file fails, when srt is missing, unreadable or older than SRT_MIN. Spawns only; touches no disk. */
export function realSrtVersion(): string {
  const r = spawnSync('srt', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  const line = (r.stdout ?? '').trim().split('\n').at(-1) ?? '';
  const v = /^v?(\d+\.\d+\.\d+)$/.exec(line)?.[1];
  const fix = `Install @anthropic-ai/sandbox-runtime@${SRT_MIN} globally.`;
  if (r.error || r.status !== 0 || !v) throw new Error(`HARNESS_E2E_SRT=1 needs srt ${SRT_MIN} or newer on PATH: \`srt --version\` gave ${r.error ? r.error.message : `status ${r.status}, "${line}"`}. ${fix}`);
  if (olderThan(v, SRT_MIN)) throw new Error(`HARNESS_E2E_SRT=1 needs srt ${SRT_MIN} or newer, found ${v}. ${fix}`);
  return v;
}
