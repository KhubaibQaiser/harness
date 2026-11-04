import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { run } from '../../src/cli/index.js';
import { makeRepo } from '../install/helpers.js';

const go = (args: string[], root: string, env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  return { code: run(args, { root, env, out: (l) => lines.push(l) }), lines };
};
const file = (name: string, text: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'h-validate-')), name);
  writeFileSync(p, text);
  return p;
};
const root = makeRepo({ 'package.json': '{}' }, { git: false });

test('validate answers prints every error and exits 2', () => {
  const f = file('answers.json', JSON.stringify({ scope: { paths: ['../x', '/etc/passwd'] }, project: { type: 'nope' } }));
  const r = go(['validate', 'answers', f], root);
  expect(r.code).toBe(2);
  expect(r.lines.length).toBeGreaterThan(2);
  expect(r.lines.some((l) => l.includes('../x'))).toBe(true);
  expect(r.lines.some((l) => l.includes('/etc/passwd'))).toBe(true);
});

test('validate works without CLAUDECODE and with it', () => {
  const sections = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'].map((s) => `## ${s}\nx`).join('\n');
  const f = file('product.md', sections);
  for (const env of [{}, { CLAUDECODE: '1' }]) expect(go(['validate', 'product', f], root, env)).toEqual({ code: 0, lines: ['ok'] });
});

test('validate product reports errors; bad usage and unreadable or non-JSON files exit 2', () => {
  expect(go(['validate', 'product', file('p.md', 'x')], root).code).toBe(2);
  expect(go(['validate'], root).code).toBe(2);
  expect(go(['validate', 'answers'], root).code).toBe(2);
  expect(go(['validate', 'answers', '/nonexistent/a.json'], root).code).toBe(2);
  expect(go(['validate', 'answers', file('a.json', '{nope')], root).code).toBe(2);
});

test('an unreadable file name is escaped in the error', () => {
  const r = go(['validate', 'answers', '/nonexistent/a\u001b[31m.json'], root);
  expect(r.lines.join()).not.toContain('\u001b');
});
