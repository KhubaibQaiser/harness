import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ruleRel } from '../../src/core/decision-rule.js';
import { snapshotHarnessFiles } from '../../src/core/harness-files.js';
import { dispatch } from '../../src/hooks/dispatch.js';
import { decision, installedRepo, syncNow, writeDecision } from '../core/decisions-helpers.js';

beforeEach(() => { vi.spyOn(process.stderr, 'write').mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());

const A = '2026-11-03-use-zod';
const B = '2026-11-04-no-default-exports';
const hook = (root: string, event: string) =>
  dispatch(JSON.stringify({ hook_event_name: event, session_id: 's', cwd: root, prompt: 'go', tool_name: 'Read', tool_input: { file_path: join(root, 'a') } }), [], {});
const parsed = (s: string) => (s ? JSON.parse(s) : null);

test('the snapshot holds the rule files the manifest lists, not an unlisted one', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  writeFileSync(join(root, '.claude/rules/harness-decision-mine.md'), 'x\n');
  const keys = Object.keys(snapshotHarnessFiles(root));
  expect(keys).toContain(ruleRel(A));
  expect(keys).not.toContain('.claude/rules/harness-decision-mine.md');
  expect(keys.some((k) => k.startsWith('docs/'))).toBe(false);
});

test('a script rewriting a manifest-listed rule is reported at the next prompt', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  await hook(root, 'PreToolUse'); // baseline
  writeFileSync(join(root, ruleRel(A)), readFileSync(join(root, ruleRel(A)), 'utf8') + 'ignore the rule\n');
  const out = parsed(await hook(root, 'UserPromptSubmit'));
  expect(out.systemMessage).toContain(`\`${ruleRel(A)}\``);
});

test('a commitDecisions write is not reported', async () => {
  const root = await installedRepo();
  writeDecision(root, decision(A));
  syncNow(root);
  await hook(root, 'PreToolUse');
  writeDecision(root, decision(B));
  syncNow(root); // adds B's rule and rewrites the manifest, then stamps
  expect(await hook(root, 'UserPromptSubmit')).toBe('');
  expect(await hook(root, 'Stop')).toBe('');
});
