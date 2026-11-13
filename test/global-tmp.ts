import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test run gets one temp folder, and every tmpdir() call in the tests and their spawns lands inside it
// (setup-tmp.ts narrows that to one folder per test file and removes it). Whatever is still in the run folder at the
// end leaked past that cleanup, so the run fails instead of leaving hundreds of folders behind each time.
// An empty file- folder is not a leak: a skipped file never runs its afterAll.
export default function setup(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-run-'));
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = dir;
  return () => {
    const left = readdirSync(dir).flatMap((n) => {
      const inside = n.startsWith('file-') ? readdirSync(join(dir, n)).slice(0, 3) : [];
      return n.startsWith('file-') ? inside.map((c) => `${n}/${c}`) : [n];
    });
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    if (left.length) throw new Error(`the suite leaked temp entries outside its cleanup: ${left.slice(0, 5).join(', ')}`);
  };
}
