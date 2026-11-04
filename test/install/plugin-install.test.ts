import { expect, test } from 'vitest';
import type { Exec } from '../../src/core/exec.js';
import { installPlugins, pluginList } from '../../src/install/plugin-install.js';

const calls: string[][] = [];
const exec = (by: Record<string, ReturnType<Exec>>): Exec => (_cmd, args) => (calls.push(args), by[args[2]] ?? { status: 1, stdout: '', stderr: 'unknown' });

test('installPlugins reads the JSON result line', () => {
  calls.length = 0;
  const r = installPlugins(['a@harness-pins', 'b@harness-pins'], exec({
    'a@harness-pins': { status: 0, stdout: 'Fetching...\n{"ok":true}\n' },
    'b@harness-pins': { status: 1, stdout: 'Fetching...\n{"ok":false,"error":"no such plugin"}\n' },
  }));
  expect(r.ok).toEqual(['a@harness-pins']);
  expect(r.failed).toEqual([{ id: 'b@harness-pins', message: 'no such plugin' }]);
  expect(calls[0]).toEqual(['plugin', 'install', 'a@harness-pins', '--scope', 'project', '--json']);
});

test('installPlugins without claude reports every id', () => {
  const r = installPlugins(['a@harness-pins', 'b@harness-pins'], () => ({ status: 127, stdout: '', missing: true }));
  expect(r.ok).toEqual([]);
  expect(r.failed.map((f) => f.message)).toEqual(['Claude Code CLI not found on PATH', 'Claude Code CLI not found on PATH']);
});

test('marketplace not registered gives the restart message', () => {
  const r = installPlugins(['a@harness-pins'], () => ({ status: 1, stdout: '{"ok":false,"error":"Marketplace harness-pins not found"}' }));
  expect(r.failed[0].message).toBe("Claude Code hasn't registered `harness-pins` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.");
});

test('pluginList reads the JSON list, null on any failure', () => {
  const ok = pluginList(() => ({ status: 0, stdout: '[{"id":"a@harness-pins","version":"1.0.0","enabled":true},{"id":"x"}]' }));
  expect(ok).toEqual([{ id: 'a@harness-pins', version: '1.0.0', enabled: true }, { id: 'x', version: '', enabled: false }]);
  expect(pluginList(() => ({ status: 1, stdout: '' }))).toBeNull();
  expect(pluginList(() => ({ status: 0, stdout: 'nope' }))).toBeNull();
  expect(pluginList(() => ({ status: 127, stdout: '', missing: true }))).toBeNull();
});
