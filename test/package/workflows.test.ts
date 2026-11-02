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

test('publish waits for a manual run on a tag; a tag push alone only checks', () => {
  const rel = load('release.yml');
  expect(rel.on).toHaveProperty('workflow_dispatch');
  expect(rel.on.push.tags).toEqual(['v*']);
  expect(rel.jobs.publish.if).toBe("github.event_name == 'workflow_dispatch' && github.ref_type == 'tag'");
  expect(rel.jobs['check-tag'].if).toBeUndefined();
  expect(rel.jobs.ci.if).toBeUndefined();
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

const allSteps = (f: string) => Object.values<any>(load(f).jobs).flatMap((j) => j.steps ?? []);

test('release tag check compares against package.json version and exits 1', () => {
  const check = allSteps('release.yml').find((s) => /tag equals/i.test(s.name ?? ''));
  expect(check.run).toMatch(/\[ "\$GITHUB_REF_NAME" != "\$v" \]/);
  expect(check.run).toContain('exit 1');
});

test('NPM_TOKEN appears only in the publish step env', () => {
  const withToken = allSteps('release.yml').filter((s) => JSON.stringify(s).includes('NPM_TOKEN'));
  expect(withToken).toHaveLength(1);
  expect(withToken[0].run).toContain('npm publish --access public');
  expect(raw('release.yml').match(/NPM_TOKEN/g)).toHaveLength(1);
  expect(raw('ci.yml')).not.toContain('NPM_TOKEN');
});

test('prerelease versions publish with --tag beta, others latest', () => {
  const pub = allSteps('release.yml').find((s) => /npm publish/.test(s.run ?? ''));
  expect(pub.run).toContain('*-*) tag=beta');
  expect(pub.run).toContain('tag=latest');
  expect(pub.run).toContain('--tag "$tag"');
});

test('weekly validate step is conditional on the plugin manifest', () => {
  const s = allSteps('claude-code-weekly.yml').find((x) => /plugin validate/.test(x.run ?? ''));
  expect(s.if).toBe("hashFiles('.claude-plugin/plugin.json') != ''");
});

test('weekly workflow sets up bun before running tests', () => {
  const uses = allSteps('claude-code-weekly.yml').map((s) => s.uses ?? s.run);
  const bun = uses.findIndex((u) => /oven-sh\/setup-bun@/.test(u));
  expect(bun).toBeGreaterThan(-1);
  expect(bun).toBeLessThan(uses.indexOf('pnpm test'));
});

test('gitleaks runs as a checksum-verified binary over full history', () => {
  const ci = load('ci.yml').jobs['security-and-pack'];
  const install = ci.steps.find((s: any) => /gitleaks/i.test(s.name ?? '') && s.run?.includes('sha256sum -c'));
  expect(install.run).toMatch(/v=\d+\.\d+\.\d+/);
  expect(install.run).toMatch(/[0-9a-f]{64}/);
  expect(ci.steps.some((s: any) => /gitleaks git --redact/.test(s.run ?? ''))).toBe(true);
  expect(ci.steps[0].with['fetch-depth']).toBe(0);
  expect(raw('ci.yml')).not.toContain('gitleaks-action');
});

test('every checkout sets persist-credentials: false', () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const cos = allSteps(f).filter((s) => /^actions\/checkout@/.test(s.uses ?? ''));
    expect(cos.length, f).toBeGreaterThan(0);
    for (const c of cos) expect(c.with['persist-credentials'], f).toBe(false);
  }
});

test('real-frameworks job runs the opt-in e2e on ubuntu with node 22', () => {
  const job = load('ci.yml').jobs['real-frameworks'];
  expect(job['runs-on']).toBe('ubuntu-latest');
  expect(job.steps.find((s: any) => s['actions/setup-node'] || /setup-node@/.test(s.uses ?? '')).with['node-version']).toBe(22);
  const run = job.steps.find((s: any) => /real-frameworks/.test(s.run ?? ''));
  expect(run.env.HARNESS_E2E_REAL).toBe('1');
});

test('hook latency runs as its own CI step after the parallel suite, in a project without file parallelism', async () => {
  const steps = load('ci.yml').jobs.test.steps.map((s: any) => s.run);
  expect(steps.indexOf('pnpm test:perf')).toBeGreaterThan(steps.indexOf('pnpm test'));
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.scripts.test).toMatch(/vitest run --project unit --project e2e$/); // perf is left out of the default run
  expect(pkg.scripts['test:perf']).toMatch(/vitest run --project perf$/);
  const cfg = (await import('../../vitest.config.js')).default as any;
  const perf = cfg.test.projects.find((p: any) => p.test.name === 'perf');
  expect(perf.test.fileParallelism).toBe(false);
  expect(cfg.test.projects.find((p: any) => p.test.name === 'unit').test.exclude).toContain('test/perf/**');
});

test('unit tests get one hang budget on every OS (process spawns make wall time load-dependent), and no retries', async () => {
  const cfg = (await import('../../vitest.config.js')).default as any;
  const unit = cfg.test.projects.find((p: any) => p.test.name === 'unit').test;
  expect(unit.testTimeout).toBe(30_000);
  expect(unit.hookTimeout).toBe(30_000);
  expect(unit.retry).toBeUndefined();
});
