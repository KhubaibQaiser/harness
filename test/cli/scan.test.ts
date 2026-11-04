import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { makeRepo } from '../install/helpers.js';

test('scan works without CLAUDECODE and prints valid JSON', () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ devDependencies: { next: '1' } }), 'Dockerfile': '' }, { git: false });
  const lines: string[] = [];
  expect(run(['scan'], { root, env: {}, out: (l) => lines.push(l) })).toBe(0);
  expect(lines).toHaveLength(1);
  const j = JSON.parse(lines[0]);
  expect(j.deps).toEqual(['next']);
  expect(j.docker).toBe(true);
  expect(j.root).toBeUndefined();
});

test('scan rejects extra arguments', () => {
  const lines: string[] = [];
  expect(run(['scan', 'x'], { root: '.', env: {}, out: (l) => lines.push(l) })).toBe(2);
});
