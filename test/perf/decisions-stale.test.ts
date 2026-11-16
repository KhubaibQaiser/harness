import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import type { TeamDecision } from '../../src/core/decision-file.js';
import { staleness } from '../../src/core/decisions-stale.js';
import { medianOf } from './overhead.js';

// doctor and status run this on every call: git work must not grow with the number of decisions. Aim: under 1 s locally; the ceiling only catches per-decision git spawns.
// The median of 3 after a warm-up (it was one sample). Ceilings unchanged: the one CI failure (10 Nov) was vitest's 5 s
// test timeout on the setup, fixed in 12fd9d8; the timed part has no failure in 9-16 Nov.
const CEILING_MS = { win32: 6000, darwin: 2000 }[process.platform as string] ?? 3000;
const root = mkdtempSync(join(tmpdir(), 'stale-perf-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' }).trim();

test('500 decisions over 3000 tracked files stay fast', () => {
  git('init', '-q');
  mkdirSync(join(root, 'docs/decisions'), { recursive: true });
  for (let i = 0; i < 2500; i++) { mkdirSync(join(root, `src/d${i % 50}`), { recursive: true }); writeFileSync(join(root, `src/d${i % 50}/f${i}.ts`), 'x'); }
  const ds: TeamDecision[] = Array.from({ length: 500 }, (_, i) => {
    const id = `2026-11-01-d${i}`; const rel = `docs/decisions/${id}.md`;
    writeFileSync(join(root, rel), `${i}`);
    return { id, title: 't', status: 'active', paths: [`src/d${i % 50}/**`, `src/d${(i + 1) % 50}/**`], verified_at: '', verified_on: '2026-11-01', body: 'b', rel };
  });
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/d1/f1.ts'), 'y'); git('add', '-A'); git('commit', '-q', '-m', 'two');
  ds.forEach((d, i) => { d.verified_at = i % 20 ? sha : 'b'.repeat(40); });
  const { ms, result } = medianOf('decisions-stale 500 decisions', () => staleness(root, ds, { today: '2026-11-10', expiryDays: 90, cap: 20 }), 3);
  expect(result.note).toBeNull();
  expect(result.states).toHaveLength(500);
  expect(ms, `staleness median ${ms.toFixed(0)} ms`).toBeLessThan(CEILING_MS);
}, 120_000); // the timed part is only staleness() (4 calls); setting up 3000 files and two commits is slow on Windows runners
