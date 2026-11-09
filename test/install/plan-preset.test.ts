import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadPreset } from '../../src/catalog/presets.js';
import { mergePresetSettings } from '../../src/install/merge.js';
import { mergeSettingsPreset } from '../../src/install/plan-preset.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'presets', 'stacks.yaml');
const PARENT = '{"set":["skillOverrides"],"value":{}}';
const LEAF = '{"set":["skillOverrides","pr-ship"],"value":"name-only"}';
const before = JSON.stringify({ skillOverrides: { 'pr-ship': 'name-only' } }, null, 2) + '\n';

test('context apply\'s skillOverrides blocks are not the preset\'s: no preset leaves them alone', () => {
  expect(mergeSettingsPreset(before, { selected: [], recorded: [PARENT, LEAF] })).toBeUndefined();
});

test('a preset merge keeps the skillOverrides blocks and their key', () => {
  const got = loadPreset(fixture);
  if (!got.ok) throw new Error(got.errors.join('\n'));
  const r = mergeSettingsPreset(before, { preset: got.loaded, selected: [], recorded: [PARENT, LEAF] })!;
  expect(r.dropped).toEqual([]);
  expect(JSON.parse(r.after).skillOverrides).toEqual({ 'pr-ship': 'name-only' });
});

test('mergePresetSettings drops a recorded preset key it no longer wants, but never a skillOverrides one', () => {
  const s = JSON.stringify({ attribution: false, skillOverrides: { 'pr-ship': 'name-only' } });
  const r = mergePresetSettings(s, [], ['{"set":["attribution"],"value":false}', PARENT, LEAF]);
  expect(r.dropped).toEqual(['{"set":["attribution"],"value":false}']);
  expect(JSON.parse(r.after)).toEqual({ skillOverrides: { 'pr-ship': 'name-only' } });
});

test('the writer named in a kept-value note', () => {
  const r = mergePresetSettings(JSON.stringify({ skillOverrides: { a: 'on' } }), [{ set: ['skillOverrides', 'a'], value: 'name-only' }], [], undefined, 'harness');
  expect(r.notes).toEqual(['`.claude/settings.json`: `skillOverrides.a` is already "on"; left as is (harness would set "name-only").']);
});
