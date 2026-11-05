import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';

// Each batch task appends its ids here.
const BATCHES: Record<number, string[]> = {
  1: [
    'frontend-design', 'impeccable', 'ui-ux-pro-max', 'taste-skill', 'superdesign', 'design',
    'web-design-guidelines', 'react-best-practices', 'vercel-react-native-skills', 'modern-web-guidance', 'emilkowalski-skills', 'web-quality-skills', 'shadcn', 'shadcn-mcp', 'figma',
    'gsap-skills', 'threejs-skills', 'motion-ai-kit', 'spline-mcp', 'mcp-for-blender',
  ],
  2: [
    'superpowers', 'mattpocock-skills', 'addyosmani-agent-skills', 'ponytail', 'caveman', 'spec-kit', 'code-review', 'code-simplifier', 'ralph-loop', 'remember', 'wshobson-agents',
    'claude-code-setup', 'claude-md-management', 'skill-creator', 'hookify', 'session-report', 'dash0',
    'feature-dev', 'pr-review-toolkit',
  ],
  3: [
    'typescript-lsp', 'swift-lsp', 'kotlin-lsp', 'context7', 'graphify', 'serena', 'sourcegraph', 'mintlify', 'engineering',
    'playwright', 'chrome-devtools-mcp', 'webapp-testing',
    'expo', 'react-native-best-practices', 'maestro-mcp', 'mobile-mcp', 'revenuecat',
  ],
  4: [
    'postman', '42crunch-api-security-testing', 'supabase', 'supabase-agent-skills', 'prisma', 'neon', 'databases-on-aws', 'auth0', 'workos', 'stripe',
    'aws-core', 'aws-serverless', 'deploy-on-aws', 'pulumi', 'terraform', 'vercel', 'cloudflare', 'render', 'railway',
    'mergify',
    'jfrog', 'sonatype-guide',
  ],
  5: [
    'security-guidance', 'claude-security', 'semgrep', 'trailofbits-insecure-defaults', 'trailofbits-supply-chain-risk-auditor', 'stackhawk-hawkscan', 'aikido', 'probity', 'tdd-guard', 'sonarqube',
    'sentry', 'getsentry-skills', 'posthog', 'growthbook', 'datadog',
    'evals-skills', 'langfuse', 'deepeval', 'agent-sdk-dev', 'mcp-server-dev',
    'marketingskills',
  ],
};

test.each(Object.entries(BATCHES))('batch %s ids are all in items/ or excluded.yaml', (_n, ids) => {
  const { catalog, excluded, errors } = loadCatalog();
  expect(errors).toEqual([]);
  const items = new Set(catalog.items.map((i) => i.id));
  const out = new Set(excluded.map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect([id, items.has(id) || out.has(id), items.has(id) && out.has(id)]).toEqual([id, true, false]);
});

// Stances from the brief table; every other batch item is optional.
const STANCES: Record<number, Record<string, { stance: string; reason?: string }>> = {
  1: { 'frontend-design': { stance: 'default' }, superdesign: { stance: 'discouraged', reason: 'duplicates Figma' } },
  2: {
    superpowers: { stance: 'default' },
    caveman: { stance: 'discouraged', reason: 'overlaps ponytail' },
    'code-review': { stance: 'discouraged', reason: 'built-in /code-review' },
    'ralph-loop': { stance: 'discouraged', reason: 'use /goal' },
    'feature-dev': { stance: 'discouraged', reason: 'overlaps superpowers; use one process pack.' },
    'pr-review-toolkit': { stance: 'discouraged', reason: 'overlaps the built-in /code-review and the harness reviewer.' },
  },
  3: {
  },
  5: {
    aikido: { stance: 'discouraged', reason: 'duplicates semgrep' },
    'tdd-guard': { stance: 'discouraged', reason: 'superseded by probity' },
  },
};

test.each(Object.entries(BATCHES))('batch %s stances and reasons match the brief', (n, ids) => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  const want = STANCES[Number(n)] ?? {};
  for (const item of ids.map((id) => by.get(id)).filter((i) => i !== undefined)) {
    const w = want[item.id] ?? { stance: 'optional' };
    expect([item.id, item.stance, item.stance_reason]).toEqual([item.id, w.stance, w.reason ?? '']);
  }
});

test('impeccable side effects and mcp config shapes', () => {
  const items = loadCatalog().catalog.items;
  expect(items.find((i) => i.id === 'impeccable')?.side_effects).toEqual(['installs-hook', 'downloads-binary', 'telemetry-on-by-default']);
  for (const i of items.filter((x) => x.kind === 'mcp')) {
    const c = i.mcp!.config;
    expect(c.command !== undefined || (c.type === 'http' && typeof c.url === 'string'), i.id).toBe(true);
  }
});

test('LSP plugins carry the marketplace lspServers map', () => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  const servers = { 'typescript-lsp': 'typescript', 'swift-lsp': 'sourcekit-lsp', 'kotlin-lsp': 'kotlin-lsp' } as const;
  for (const [id, name] of Object.entries(servers)) expect([id, Object.keys(by.get(id)?.lsp_servers ?? {})]).toEqual([id, [name]]);
  expect((by.get('kotlin-lsp')?.lsp_servers as any)['kotlin-lsp'].startupTimeout).toBe(120000);
});

// Batch 4 hook-bearing items (read from each pinned hooks.json) must say so; medium context is only for hooks that inject text.
test('batch 4 hook-bearing items carry installs-hook and only injectors are medium', () => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  const hooked = ['postman', 'stripe', 'vercel', 'databases-on-aws', 'aws-serverless', 'deploy-on-aws', 'render', 'railway', 'jfrog', 'aws-core'];
  for (const id of hooked) expect([id, by.get(id)?.side_effects.includes('installs-hook')]).toEqual([id, true]);
  const medium = BATCHES[4].filter((id) => by.get(id)?.cost.context === 'medium').sort();
  expect(medium).toEqual(['jfrog', 'postman', 'stripe', 'vercel']);
});

// Batch 5 hook-bearing ids, listed from each pinned hooks.json (security-guidance, stackhawk-hawkscan, probity, tdd-guard, posthog, datadog);
// the catalog's side_effects must match this independent list in both directions.
test('batch 5 hook-bearing items carry installs-hook and context cost follows the rules', () => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  const hooked = ['security-guidance', 'stackhawk-hawkscan', 'probity', 'tdd-guard', 'posthog', 'datadog'];
  for (const id of hooked) expect([id, by.get(id)?.side_effects.includes('installs-hook')]).toEqual([id, true]);
  const withHook = BATCHES[5].filter((id) => by.get(id)?.side_effects.includes('installs-hook')).sort();
  expect(withHook).toEqual([...hooked].sort());
  const level = (l: string) => BATCHES[5].filter((id) => by.get(id)?.cost.context === l).sort();
  expect(level('medium')).toEqual(['datadog', 'security-guidance', 'stackhawk-hawkscan']);
  expect(level('high')).toEqual(['posthog']);
  expect(by.get('datadog')?.side_effects).toContain('telemetry-on-by-default');
  expect(by.get('security-guidance')?.side_effects).toContain('telemetry-on-by-default');
});

// Items that fetch or run code unpinned at launch must say so in their evidence (owner precedent).
test('batch 5 unpinned-launch items say unpinned in evidence', () => {
  const by = new Map(loadCatalog().catalog.items.map((i) => [i.id, i]));
  for (const id of ['probity', 'tdd-guard', 'security-guidance']) expect([id, by.get(id)?.evidence.some((e) => /unpinned/i.test(e))]).toEqual([id, true]);
});

test('probity conflicts with tdd-gate and tdd-guard, and no other batch 5 item declares a conflict', () => {
  const items = loadCatalog().catalog.items;
  const by = new Map(items.map((i) => [i.id, i]));
  expect(by.get('probity')?.conflicts_with).toEqual(['tdd-gate', 'tdd-guard']);
  for (const id of ['tdd-gate', 'tdd-guard']) expect(by.has(id)).toBe(true);
  expect(BATCHES[5].filter((id) => id !== 'probity' && (by.get(id)?.conflicts_with.length ?? 0) > 0)).toEqual([]);
});

// Spec §5: one lead design skill per repo. frontend-design is light and may sit beside the lead.
test('the four lead design skills conflict with each other, and frontend-design with none', async () => {
  const { conflictPairs } = await import('../../src/catalog/relations.js');
  const { catalog } = loadCatalog();
  const lead = ['impeccable', 'superdesign', 'taste-skill', 'ui-ux-pro-max'];
  expect(conflictPairs(lead, catalog)).toHaveLength(6);
  expect(conflictPairs([...lead, 'frontend-design'], catalog).filter((p) => p.includes('frontend-design'))).toEqual([]);
});

test('taste-skill applies to web and landing repos, not mobile', () => {
  const t = loadCatalog().catalog.items.find((i) => i.id === 'taste-skill');
  expect(t?.applies_when.project_types).toEqual(['web', 'landing']);
});
