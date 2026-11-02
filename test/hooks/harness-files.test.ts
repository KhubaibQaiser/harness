import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { status } from '../../src/cli/status.js';
import { doctor } from '../../src/cli/doctor.js';
import { readEvents } from '../../src/core/events.js';
import { snapshotHarnessFiles, stampHarnessFiles } from '../../src/core/harness-files.js';
import { dispatch } from '../../src/hooks/dispatch.js';

// Change detection (owner decision 2026-11-03): the backstop for every route the path checks can't see.
const repo = (config = 'checks:\n  guard: true\n') => {
  const root = mkdtempSync(join(tmpdir(), 'h-hf-'));
  mkdirSync(join(root, '.harness/hooks'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.harness/config.yaml'), config);
  writeFileSync(join(root, '.harness/manifest.json'), JSON.stringify({ version: '1', createdAt: 'x', files: [] }));
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v1\n');
  writeFileSync(join(root, '.claude/settings.json'), '{}\n');
  return root;
};
const hook = (root: string, event: string, env: NodeJS.ProcessEnv = {}, session = 's') =>
  dispatch(JSON.stringify({ hook_event_name: event, session_id: session, cwd: root, prompt: 'go', tool_name: 'Read', tool_input: { file_path: join(root, 'a') } }), [], env);
const parsed = (s: string) => (s ? JSON.parse(s) : null);

test('snapshot covers config, manifest, every hooks file and the Claude settings files that exist', () => {
  const root = repo();
  writeFileSync(join(root, '.harness/hooks/jest-results.cjs'), 'x');
  expect(Object.keys(snapshotHarnessFiles(root)).sort()).toEqual(['.claude/settings.json', '.harness/config.yaml', '.harness/hooks/dispatch.mjs', '.harness/hooks/jest-results.cjs', '.harness/manifest.json']);
  writeFileSync(join(root, '.claude/settings.local.json'), '{}');
  expect(Object.keys(snapshotHarnessFiles(root))).toContain('.claude/settings.local.json');
});

test('a harness file changed mid-session: Stop blocks once naming it, logs it, and does not loop', async () => {
  const root = repo();
  expect(await hook(root, 'PreToolUse')).toBe(''); // first hook: snapshot
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: false\n');
  const out = parsed(await hook(root, 'Stop'));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('`.harness/config.yaml`');
  expect(out.reason).toContain('git diff -- .harness .claude/settings.json');
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed').map((e) => e.reason)).toEqual(['.harness/config.yaml']);
  expect(await hook(root, 'Stop')).toBe(''); // re-snapshotted: blocked once per change set
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// tampered\n');
  expect(parsed(await hook(root, 'Stop')).reason).toContain('`.harness/hooks/dispatch.mjs`'); // a new change set blocks again
});

test('a removed or added file counts; unattended runs block the same way', async () => {
  const root = repo();
  await hook(root, 'PreToolUse', { CI: 'true' });
  writeFileSync(join(root, '.claude/settings.local.json'), '{"x":1}');
  const out = parsed(await hook(root, 'Stop', { CI: 'true' }));
  expect(out.decision).toBe('block');
  expect(out.reason).toContain('`.claude/settings.local.json`');
});

test('UserPromptSubmit shows the person a systemMessage and gives the model the same context', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.claude/settings.json'), '{"hooks":{}}\n');
  const out = parsed(await hook(root, 'UserPromptSubmit'));
  expect(out.systemMessage).toContain('`.claude/settings.json`');
  expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'UserPromptSubmit' });
  expect(out.hookSpecificOutput.additionalContext).toContain('`.claude/settings.json`');
  expect(await hook(root, 'UserPromptSubmit')).toBe(''); // said once
});

test('changes written by the harness CLI (it stamps the new snapshot) do not trigger', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// v2\n');
  stampHarnessFiles(root); // what init, update and uninstall do after writing
  expect(await hook(root, 'Stop')).toBe('');
  expect(await hook(root, 'UserPromptSubmit')).toBe('');
});

test('the change block counts within stop.max_attempts, so the session can always end', async () => {
  const root = repo('stop:\n  max_attempts: 1\n');
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/manifest.json'), '{"version":"2","createdAt":"x","files":[]}');
  expect(parsed(await hook(root, 'Stop')).decision).toBe('block');
  writeFileSync(join(root, '.harness/hooks/dispatch.mjs'), '// again\n');
  expect(await hook(root, 'Stop')).toBe(''); // attempts used up: allowed, still logged
  expect(readEvents(root).filter((e) => e.decision === 'harness-files-changed')).toHaveLength(2);
});

test('status and doctor show the last change event', async () => {
  const root = repo();
  await hook(root, 'PreToolUse');
  writeFileSync(join(root, '.harness/config.yaml'), 'checks:\n  guard: true\n# edit\n');
  await hook(root, 'Stop');
  let s = '';
  status([], { root, env: {}, out: (l) => (s += l + '\n') });
  expect(s).toMatch(/Harness files last changed during a session: .* \(`\.harness\/config\.yaml`\)/);
  let d = '';
  doctor([], { root, env: {}, out: (l) => (d += l + '\n') });
  expect(d).toMatch(/^note harness files changed during a session at .*: `\.harness\/config\.yaml`/m);
});
