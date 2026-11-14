// Done-contract costs, measured on a real temp repo. Runs in the `perf` project (no file parallelism). No retries: a slow result is real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { treeHash } from '../../src/done/tree.js';
import { commit, git } from '../review/repo.js';

const CEILING_MS = 1000; // gross-regression guard, same value as latency.test.ts
const report = (name: string, ms: number) => writeSync(2, `[perf] ${name} ${process.platform}: ${ms.toFixed(1)} ms\n`);

test('tree hash of a 500-file repo stays under the ceiling', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-perf-tree-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.com'], ['commit.gpgsign', 'false']]) git(root, 'config', k!, v!);
  const files: Record<string, string> = {};
  for (let i = 0; i < 500; i++) files[`src/d${i % 10}/f${i}.ts`] = `export const n${i} = ${i};\n`;
  commit(root, files);
  mkdirSync(join(root, 'src/new'), { recursive: true });
  writeFileSync(join(root, 'src/new/untracked.ts'), 'x');
  treeHash(root); // warm the file-system cache
  const t = performance.now();
  treeHash(root);
  const ms = performance.now() - t;
  report('tree hash (500 files)', ms);
  expect(ms).toBeLessThan(CEILING_MS);
});
