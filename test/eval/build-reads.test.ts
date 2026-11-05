import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { mergeAgents } from '../../src/install/merge.js';

const reads: string[] = [];
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  const read = ((p: string, ...a: unknown[]) => {
    reads.push(String(p));
    return (fs.readFileSync as (...x: unknown[]) => unknown)(p, ...a);
  }) as typeof fs.readFileSync;
  return { ...fs, readFileSync: read };
});

test('the repo config is read once per build, not once per case', async () => {
  const { buildEvalPlugin } = await import('../../src/eval/build.js');
  const root = mkdtempSync(join(tmpdir(), 'ev-root-'));
  mkdirSync(join(root, '.harness'));
  writeFileSync(join(root, '.harness/config.yaml'), 'preset:\n  git:\n    branch_prefixes: [team/]\n');
  writeFileSync(join(root, 'AGENTS.md'), mergeAgents(null).after);
  reads.length = 0;
  const r = buildEvalPlugin(root, { kinds: ['rules'], tmp: mkdtempSync(join(tmpdir(), 'ev-tmp-')), dispatch: '/x' });
  expect(r.cases.length).toBeGreaterThan(1);
  expect(reads.filter((p) => p.replace(/\\/g, '/').endsWith('.harness/config.yaml'))).toHaveLength(1);
});
