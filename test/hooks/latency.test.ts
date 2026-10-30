import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
