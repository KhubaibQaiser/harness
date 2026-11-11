import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test run gets one temp folder, and every tmpdir() call in the tests and their spawns lands inside it, so the
// run removes all of it at the end instead of leaving hundreds of folders (and 50 MB transcripts) behind each time.
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-run-'));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
