import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Every fs entry point that reads, recorded with its path argument.
const seen: string[] = [];
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const spy = <K extends keyof typeof real>(k: K) => ((...a: unknown[]) => { seen.push(String(a[0])); return (real[k] as (...x: unknown[]) => unknown)(...a); }) as (typeof real)[K];
  const m = { ...real };
  for (const k of ['readFileSync', 'readdirSync', 'opendirSync', 'openSync', 'lstatSync', 'statSync', 'existsSync', 'realpathSync'] as const) (m as Record<string, unknown>)[k] = spy(k);
  return { ...m, default: m };
});

it('never reads the real home: only the injected one, and nothing under HOME', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-home-'));
  const poison = join(dir, 'poison'), home = join(dir, 'home'), root = join(dir, 'repo');
  mkdirSync(join(poison, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(poison, '.claude', 'CLAUDE.md'), 'x');
  mkdirSync(join(root, '.claude', 'skills', 'a'), { recursive: true });
  writeFileSync(join(root, '.claude', 'skills', 'a', 'SKILL.md'), '---\nname: a\n---\n');
  mkdirSync(home, { recursive: true });
  const old = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = poison; process.env.USERPROFILE = poison;
  try {
    const { report } = await import('../../src/cli/report.js');
    const lines: string[] = [];
    const code = await report([], { root, env: {}, out: (s) => lines.push(s), home, git: () => ({ status: 1, stdout: '' }), now: () => Date.parse('2026-11-05T12:00:00Z') });
    expect(code).toBe(0);
  } finally {
    process.env.HOME = old.HOME; process.env.USERPROFILE = old.USERPROFILE;
  }
  const reads = [...seen]; // before the test's own realpath call below
  expect(reads.length).toBeGreaterThan(0);
  const p = realpathSync(poison);
  expect(reads.filter((x) => x.startsWith(poison) || x.startsWith(p))).toEqual([]);
});
