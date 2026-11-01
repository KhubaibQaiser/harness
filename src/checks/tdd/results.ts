import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pairKey, toRepoPath } from '../../core/paths.js';

export interface TestFileResult {
  file: string;
  status: 'passed' | 'failed';
  tests: { fullName: string; status: string }[];
  writtenAt: number;
}

export function readResults(root: string, dir: string): TestFileResult[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: TestFileResult[] = [];
  for (const n of names) {
    try {
      const p = join(dir, n);
      const json = JSON.parse(readFileSync(p, 'utf8'));
      const writtenAt = statSync(p).mtimeMs;
      const parsed: TestFileResult[] = [];
      for (const r of json.testResults) {
        const file = toRepoPath(root, r.name);
        if (!file) continue;
        const tests = r.assertionResults.map((a: { fullName: string; status: string }) => ({ fullName: a.fullName, status: a.status }));
        // red only on a real failed test, or a load failure (failed file, zero tests)
        const red = r.status === 'failed' && (tests.length === 0 || tests.some((t: { status: string }) => t.status === 'failed'));
        parsed.push({ file, status: red ? 'failed' : 'passed', tests, writtenAt });
      }
      out.push(...parsed);
    } catch {
      // malformed or unreadable result file: skip
    }
  }
  return out;
}

export const relatedTests = (implRel: string, results: TestFileResult[]): TestFileResult[] =>
  results.filter((r) => pairKey(r.file) === pairKey(implRel));

// Newest result per test file (key = repo path), keeping only results written since the session started.
export function newestFresh(results: TestFileResult[], startedAt: number): Map<string, TestFileResult> {
  const newest = new Map<string, TestFileResult>();
  for (const r of results) {
    const cur = newest.get(r.file);
    if (!cur || r.writtenAt > cur.writtenAt) newest.set(r.file, r);
  }
  for (const [k, r] of newest) if (r.writtenAt < startedAt) newest.delete(k);
  return newest;
}

// results_dir may be relative to the repo root or absolute.
export const resultsDir = (root: string, config: { tdd: { results_dir: string } }): string => resolve(root, config.tdd.results_dir);
