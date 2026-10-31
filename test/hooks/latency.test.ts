import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('PreToolUse median wall time is under 150 ms', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.harness'));
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  guard: true\n  protect: true\n  depVerify: true\n  multiFile: true\n  tdd: true\n  stop: true\n');
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'src/a.ts'), old_string: 'a', new_string: 'b' } });
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { input, encoding: 'utf8' });
    times.push(performance.now() - t);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }
  times.sort((a, b) => a - b);
  expect(times[10]).toBeLessThan(150);
}, 30000);

test('gated PreToolUse with 40 result files stays under 150 ms median', () => {
  const repo = mkdtempSync(join(tmpdir(), 'h-lat2-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  mkdirSync(join(repo, '.harness/state/test-results'), { recursive: true });
  writeFileSync(join(repo, '.harness/config.yaml'), 'checks:\n  multiFile: true\n  tdd: true\ntdd:\n  paths: ["packages/**"]\n');
  writeFileSync(join(repo, '.harness/state/lat.json'), JSON.stringify({ startedAt: Date.now() - 60000, files: [], approved: false, redTests: [], lockedTests: [], stopAttempts: 0 }));
  const base = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/results/vitest.json'), 'utf8'));
  const tpl = base.testResults[0];
  for (let i = 0; i < 40; i++) {
    const file = i === 7 ? 'packages/core/src/a.test.ts' : `packages/core/src/f${i}.test.ts`;
    const assertionResults = Array.from({ length: 50 }, (_, k) => ({ ...tpl.assertionResults[0], fullName: `t${k}`, title: `t${k}`, status: i === 7 && k === 0 ? 'failed' : 'passed' }));
    const status = i === 7 ? 'failed' : 'passed';
    writeFileSync(join(repo, `.harness/state/test-results/r${i}.json`), JSON.stringify({ ...base, testResults: [{ ...tpl, name: join(repo, file), status, assertionResults }] }));
  }
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'lat', cwd: repo, tool_name: 'Edit', tool_input: { file_path: join(repo, 'packages/core/src/a.ts'), old_string: 'a', new_string: 'b' } });
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    const r = spawnSync(process.execPath, [join(process.cwd(), 'dist/hooks/dispatch.mjs')], { input, encoding: 'utf8' });
    times.push(performance.now() - t);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // allowed: fresh failing related result
  }
  times.sort((a, b) => a - b);
  console.log(`gated median ms: ${times[10]!.toFixed(1)}`);
  expect(times[10]).toBeLessThan(150);
}, 30000);
