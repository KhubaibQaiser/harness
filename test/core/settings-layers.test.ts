import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { effective, managedSettingsPath, readSettingsLayers } from '../../src/core/settings-layers.js';

const put = (f: string, text: string) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text);
};

test('managed settings path per platform', () => {
  expect(managedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
  expect(managedSettingsPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
  expect(managedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json');
});

test('readSettingsLayers reads the injected home, in precedence order, and gives null for non-JSON or missing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'h-sl-root-'));
  const home = mkdtempSync(join(tmpdir(), 'h-sl-home-'));
  const managed = join(root, 'managed.json');
  put(join(home, '.claude/settings.json'), '{"sandbox":{"enabled":true}}');
  put(join(root, '.claude/settings.json'), 'not json');
  put(managed, '{"a":1}');
  const layers = readSettingsLayers(root, home, 'darwin', managed);
  expect(layers).toEqual([
    { name: 'managed', json: { a: 1 } },
    { name: 'local', json: null },
    { name: 'project', json: null },
    { name: 'user', json: { sandbox: { enabled: true } } },
  ]);
  expect(effective(layers, ['sandbox', 'enabled'])).toBe(true);
});

test('effective takes the first layer that defines the path, even a false one', () => {
  const layers = [
    { name: 'managed' as const, json: null },
    { name: 'local' as const, json: { sandbox: { enabled: false } } },
    { name: 'project' as const, json: { sandbox: { enabled: true } } },
    { name: 'user' as const, json: { sandbox: 'x' } },
  ];
  expect(effective(layers, ['sandbox', 'enabled'])).toBe(false);
  expect(effective(layers, ['sandbox', 'allowUnsandboxedCommands'])).toBeUndefined();
});
