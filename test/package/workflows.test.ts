import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const dir = '.github/workflows';
const raw = (f: string) => readFileSync(`${dir}/${f}`, 'utf8');
const load = (f: string) => parse(raw(f));

test('ci matrix covers three OSes and node 22/24', () => {
  const m = load('ci.yml').jobs.test.strategy.matrix;
  expect(m.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
  expect(m.node).toEqual([22, 24]);
});

test('ci is callable and has least-privilege permissions', () => {
  const ci = load('ci.yml');
  expect(ci.on).toHaveProperty('workflow_call');
  expect(ci.permissions).toEqual({ contents: 'read' });
});

test('release checks tag equals package.json version, calls ci, then publishes', () => {
  const rel = load('release.yml');
  const steps = Object.values<any>(rel.jobs).flatMap((j) => j.steps ?? []);
  const check = steps.find((s) => /tag equals/i.test(s.name ?? ''));
  expect(check.run).toContain('package.json');
  expect(check.run).toContain('GITHUB_REF_NAME');
  expect(rel.jobs.ci.uses).toBe('./.github/workflows/ci.yml');
  expect(rel.jobs.publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  expect(rel.jobs.publish.needs).toBe('ci');
});

test('release has no --provenance flag', () => {
  const lines = raw('release.yml').split('\n').filter((l) => !l.trim().startsWith('#'));
  expect(lines.join('\n')).not.toContain('--provenance');
});

test('every uses: is pinned to a 40-char SHA', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    for (const [, ref] of raw(f).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./')) continue;
      expect(ref, f).toMatch(/@[0-9a-f]{40}$/);
    }
  }
});

test('weekly workflow has a schedule trigger', () => {
  expect(load('claude-code-weekly.yml').on).toHaveProperty('schedule');
});
