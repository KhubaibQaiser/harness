import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

export const relatedTests = (_root: string, implRel: string, results: TestFileResult[]): TestFileResult[] =>
  results.filter((r) => pairKey(r.file) === pairKey(implRel));
