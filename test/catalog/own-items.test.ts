import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { checkCatalog } from '../../src/catalog/check.js';
import { loadCatalog } from '../../src/catalog/load.js';
import { defaults } from '../../src/core/config.js';
import { packageDir } from '../../src/core/package-dir.js';

const NOT_BUILT = ['post-edit-format', 'gitleaks-commit', 'session-context', 'researcher', 'ui-verify', 'seo-audit', 'webgl-landing', 'rn-a11y', 'perf-budget', 'adr', 'session-structure', 'ci-tdd', 'harness-integrity', 'lefthook-baseline', 'claude-code-action', 'harness-devdep'];
const CORE = ['config-change-guard', 'sandbox-settings'];
const REVIEWER = ['harness-review', 'ui-verifier'];
const REPLACED = ['pr-create-trigger'];

test('every own item maps to an existing check, template or merge', () => {
  const { catalog, excluded, errors } = loadCatalog();
  expect(errors).toEqual([]);
  expect(checkCatalog(catalog)).toEqual([]);
  const own = catalog.items.filter((i) => i.source.type === 'own');
  expect(own.map((i) => i.id).sort()).toEqual(['agent-guard', 'agents-md', 'multi-file-gate', 'permissions-baseline', 'pr-ship', 'review-rubric', 'staff-reviewer', 'stop-gate', 'tdd-gate']);
  const checks = new Set<string>();
  for (const i of own) {
    expect(i.license).toBe('Apache-2.0');
    expect(i.min_claude_code).toBe('2.1.314');
    const s = i.source as Extract<typeof i.source, { type: 'own' }>;
    for (const c of s.checks ?? []) { expect(Object.keys(defaults().checks)).toContain(c); checks.add(c); }
    for (const f of s.files ?? []) expect(existsSync(join(packageDir('templates'), f.from))).toBe(true);
    expect(s.merge ?? []).not.toContain('permissions');
  }
  expect([...checks].sort()).toEqual(Object.keys(defaults().checks).sort());
  const ownIds = new Set([...NOT_BUILT, ...CORE, ...REVIEWER, ...REPLACED]);
  const reasons = new Map(excluded.filter((e) => ownIds.has(e.id)).map((e) => [e.id, e.reason]));
  expect(reasons.size).toBe(21);
  for (const id of NOT_BUILT) expect(reasons.get(id)).toBe('not built yet (this release ships existing own items only)');
  for (const id of CORE) expect(reasons.get(id)).toBe('in the core install since platform enforcement; not a selectable item');
  for (const id of REVIEWER) expect(reasons.get(id)).toBe('part of the PR reviewer (M2)');
  for (const id of REPLACED) expect(reasons.get(id)).toBe('replaced by the pr-size check (pr-ship item)');
});
