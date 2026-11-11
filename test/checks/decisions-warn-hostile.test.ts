// The parser rejects control and format characters in titles and globs; shown() is the second line of defence, so the
// decision set is injected here, past the parser.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { decisionWarnings } from '../../src/checks/decisions-warn.js';
import { loadConfig } from '../../src/core/config.js';
import type { Git } from '../../src/core/decisions-stale.js';
import { readState, type SessionState } from '../../src/core/state.js';
import type { Ctx } from '../../src/hooks/check.js';

const evil = 'x\n\u001b[31m‮​y';
vi.mock('../../src/core/decisions.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/decisions.js')>()),
  readDecisions: () => ({
    errors: [], others: [],
    decisions: [{ id: '2026-11-01-h', title: evil, status: 'active', paths: ['src/**', `gone${evil}/**`, 'also/gone/**'], verified_at: 'a'.repeat(40), verified_on: new Date().toISOString().slice(0, 10), body: 'b', rel: 'docs/decisions/2026-11-01-h.md' }],
  }),
}));

test('a hostile title and dead globs print without control or format characters; one sentence per dead glob', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-dwarn-'));
  const ctx = { input: { session_id: 's', cwd: root, hook_event_name: 'Stop' }, root, config: loadConfig(root).config, state: readState(root, 's'), unattended: false, env: {}, save(s: SessionState) { ctx.state = s; } } as Ctx;
  const git: Git = (args) => ({ ok: true, out: args[0] === 'ls-files' ? 'src/a.ts\0' : args[0] === 'log' ? 'abc\n' : '' });
  const [line] = decisionWarnings(ctx, ['src/a.ts'], git);
  expect(line).toBeDefined();
  expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  expect(line).toContain('Its path gone');
  expect(line).toContain(' Its path also/gone/** no longer matches any file.');
});
