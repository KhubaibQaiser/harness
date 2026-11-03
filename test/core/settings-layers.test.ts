import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { sandboxVerdict } from '../../src/checks/sandbox-required.js';
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

const CONFIRMED = '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}';
const withDropIns = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'h-sl-root-'));
  const home = mkdtempSync(join(tmpdir(), 'h-sl-home-'));
  const managed = join(root, 'sys/managed-settings.json');
  put(join(root, '.claude/settings.json'), CONFIRMED);
  for (const [f, t] of Object.entries(files)) put(join(root, 'sys/managed-settings.d', f), t);
  return readSettingsLayers(root, home, 'darwin', managed);
};

test('a managed-settings.d drop-in with enabled false beats a confirmed project layer (deny)', () => {
  const layers = withDropIns({ '10-off.json': '{"sandbox":{"enabled":false}}', '.hidden.json': '{"sandbox":{"enabled":true}}', 'notes.txt': 'x' });
  expect(layers.map((l) => l.name)).toEqual(['managed', 'managed', 'local', 'project', 'user']);
  expect(sandboxVerdict({ mode: 'unattended', unattended: true, platform: 'darwin', env: {}, layers })).toBe('deny');
});

test('a later drop-in overrides an earlier one', () => {
  const layers = withDropIns({ '10-a.json': '{"sandbox":{"enabled":true}}', '20-b.json': '{"sandbox":{"enabled":false}}' });
  expect(effective(layers, ['sandbox', 'enabled'])).toBe(false);
});
