// Owner ruling 2026-11-13: init turns Claude Code's sandbox on by default where the platform supports it, and leaves it
// off on native Windows (and on Linux without bwrap/socat) with a stated reason.
import { expect, test } from 'vitest';
import { detect } from '../../src/install/detect.js';
import { preset } from '../../src/install/preset.js';
import { makeRepo } from './helpers.js';

const facts = () => detect(makeRepo({ 'package.json': JSON.stringify({ name: 'app' }) + '\n' }));
const ALL = (cmd: string) => `/bin/${cmd}`;
const NONE = () => null;

test('macOS, and Linux/WSL2 with bwrap and socat: sandbox always', () => {
  expect(preset(facts(), ALL, 'darwin').config.sandbox).toBe('always');
  expect(preset(facts(), ALL, 'linux').config.sandbox).toBe('always');
  expect(preset(facts(), ALL, 'darwin').reasons.sandbox).toMatch(/on in every session/);
});

test('native Windows, and Linux without bwrap/socat: required for unattended runs only, with the reason', () => {
  const win = preset(facts(), ALL, 'win32');
  expect(win.config.sandbox).toBe('unattended');
  expect(win.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/native Windows has no Claude Code sandbox/) });
  const lin = preset(facts(), NONE, 'linux');
  expect(lin.config.sandbox).toBe('unattended');
  expect(lin.off).toContainEqual({ gate: 'sandbox', why: expect.stringMatching(/bwrap and socat/) });
});
