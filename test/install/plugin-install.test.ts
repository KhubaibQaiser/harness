import { expect, test } from 'vitest';
import type { Exec } from '../../src/core/exec.js';
import { shq } from '../../src/cli/init.js';
import { installPlugins, pluginList } from '../../src/install/plugin-install.js';

const calls: string[][] = [];
const exec = (by: Record<string, ReturnType<Exec>>): Exec => (_cmd, args) => (calls.push(args), by[args[2]] ?? { status: 1, stdout: '', stderr: 'unknown' });

test('installPlugins reads the JSON result line', () => {
  calls.length = 0;
  const r = installPlugins(['a@harness-pins', 'b@harness-pins'], exec({
    'a@harness-pins': { status: 0, stdout: 'Fetching...\n{"command":"install","outcome":"ok","message":"done"}\n' },
    'b@harness-pins': { status: 1, stdout: 'Fetching...\n{"command":"install","outcome":"failed","message":"no such plugin"}\n' },
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
  const r = installPlugins(['a@harness-pins'], () => ({ status: 1, stdout: '{"command":"install","outcome":"failed","message":"Marketplace harness-pins not found"}' }));
  expect(r.failed[0].message).toBe("Claude Code hasn't registered `harness-pins` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.");
});

test('pluginList reads the JSON list, null on any failure', () => {
  const ok = pluginList(() => ({ status: 0, stdout: '[{"id":"a@harness-pins","version":"1.0.0","enabled":true},{"id":"x"}]' }));
  expect(ok).toEqual([{ id: 'a@harness-pins', version: '1.0.0', enabled: true }, { id: 'x', version: '', enabled: false }]);
  expect(pluginList(() => ({ status: 1, stdout: '' }))).toBeNull();
  expect(pluginList(() => ({ status: 0, stdout: 'nope' }))).toBeNull();
  expect(pluginList(() => ({ status: 127, stdout: '', missing: true }))).toBeNull();
});

test('outcome failed with exit 0 is a failure; no JSON line falls back to the exit status', () => {
  const r = installPlugins(['a@harness-pins', 'b@harness-pins', 'c@harness-pins'], exec({
    'a@harness-pins': { status: 0, stdout: '{"command":"install","outcome":"failed","message":"nope"}' },
    'b@harness-pins': { status: 0, stdout: 'plain text' },
    'c@harness-pins': { status: 2, stdout: '', stderr: 'bad\nmore' },
  }));
  expect(r.ok).toEqual(['b@harness-pins']);
  expect(r.failed).toEqual([{ id: 'a@harness-pins', message: 'nope' }, { id: 'c@harness-pins', message: 'bad' }]);
});

test('an unrelated failure that echoes the id is reported plainly', () => {
  const m = 'Plugin a@harness-pins requires a newer Claude Code';
  const r = installPlugins(['a@harness-pins'], () => ({ status: 1, stdout: JSON.stringify({ command: 'install', outcome: 'failed', message: m }) }));
  expect(r.failed[0].message).toBe(m);
});

test('pluginList accepts { plugins } and keeps scope', () => {
  expect(pluginList(() => ({ status: 0, stdout: '{"plugins":[{"id":"a","version":"1","enabled":true,"scope":"project"}]}' }))).toEqual([{ id: 'a', version: '1', enabled: true, scope: 'project' }]);
});

test('shq leaves plain words, single-quotes the rest, escapes quotes and control characters', () => {
  expect(shq('--yes')).toBe('--yes');
  expect(shq('a b')).toBe("'a b'");
  expect(shq("it's $HOME")).toBe("'it'\\''s $HOME'");
  expect(shq('a\u009bb')).toBe("'a\\u009bb'");
});
