import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('../../src/core/config.js', async (orig) => ({ ...(await orig<typeof import('../../src/core/config.js')>()), loadConfig: () => { throw new Error('no config'); } }));
const { dispatch, registry } = await import('../../src/hooks/dispatch.js');

test('a degraded dispatcher (no config, no state) prints no card (owner decision 6)', async () => {
  const r = mkdtempSync(join(tmpdir(), 'h-card-deg-'));
  mkdirSync(join(r, '.harness'));
  writeFileSync(join(r, '.harness/config.yaml'), 'checks:\n  tdd: true\n');
  const raw = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'ds', cwd: r, source: 'compact' });
  expect(await dispatch(raw, registry, {})).toBe('');
});
