import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const dir = '.github/workflows';
const raw = (f: string) => readFileSync(`${dir}/${f}`, 'utf8');
const load = (f: string) => parse(raw(f));

test('ci matrix runs macOS and Windows on node 22', () => {
  const m = load('ci.yml').jobs.test.strategy.matrix;
  expect(m.os).toEqual(['macos-latest', 'windows-latest']);
  expect(m.node).toEqual([22]);
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

test('a v* tag push publishes; there is no manual trigger', () => {
  const rel = load('release.yml');
  expect(rel.on).not.toHaveProperty('workflow_dispatch');
  expect(rel.on.push.tags).toEqual(['v*']);
  expect(rel.jobs.publish.if).toBeUndefined();
  expect(rel.jobs.publish.needs).toBe('ci');
  expect(rel.jobs['check-tag'].if).toBeUndefined();
  expect(rel.jobs.ci.if).toBeUndefined();
});

test('release runs one at a time and publishes only a commit on main', () => {
  const rel = load('release.yml');
  expect(rel.concurrency).toEqual({ group: 'release', 'cancel-in-progress': false });
  // The on-main check is in check-tag, so a bad tag fails before CI and before the approval gate.
  const steps = rel.jobs['check-tag'].steps;
  expect(steps[0].with['fetch-depth']).toBe(0);
  const i = steps.findIndex((s: any) => /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/.test(s.run ?? ''));
  expect(i).toBeGreaterThan(0);
  expect(steps[i].run).toContain('exit 1');
  expect(rel.jobs.publish.steps.some((s: any) => /merge-base/.test(s.run ?? ''))).toBe(false);
});

test('the publish job waits on the npm-release environment', () => {
  expect(load('release.yml').jobs.publish.environment).toBe('npm-release');
});

test('release pins npm 11.5.1 before publishing and fails when npm is older', () => {
  const steps = load('release.yml').jobs.publish.steps;
  const i = steps.findIndex((s: any) => s.run === 'npm install -g npm@11.5.1');
  const chk = steps.findIndex((s: any) => /older than 11\.5\.1/.test(s.run ?? ''));
  expect(i).toBeGreaterThan(-1);
  expect(chk).toBeGreaterThan(i);
  expect(chk).toBeLessThan(steps.findIndex((s: any) => /npm publish/.test(s.run ?? '')));
});

test('release publishes with --provenance', () => {
  const pub = allSteps('release.yml').find((s) => /npm publish/.test(s.run ?? ''));
  expect(pub.run).toContain('--provenance');
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

test('publish uses trusted publishing: OIDC permission, no npm token', () => {
  const rel = load('release.yml');
  expect(rel.jobs.publish.permissions['id-token']).toBe('write');
  for (const f of ['release.yml', 'ci.yml']) expect(raw(f)).not.toMatch(/NPM_TOKEN/);
  expect(raw('ci.yml')).not.toMatch(/NODE_AUTH_TOKEN/);
  // The only auth token is GitHub's own, and only on the GitHub Packages step.
  const withToken = allSteps('release.yml').filter((s) => s.env && 'NODE_AUTH_TOKEN' in s.env);
  expect(withToken).toHaveLength(1);
  expect(withToken[0].env.NODE_AUTH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
  expect(rel.jobs['github-packages'].steps.filter((s: any) => s.env && 'NODE_AUTH_TOKEN' in s.env)).toHaveLength(1);
  // Nothing sets it at workflow or job level, where every step would see it.
  expect(rel.env).toBeUndefined();
  for (const j of Object.values<any>(rel.jobs)) expect(j.env).toBeUndefined();
  expect(raw('release.yml').match(/NODE_AUTH_TOKEN/g)).toHaveLength(1);
});

test('check-tag fails before CI when the release notes for the version are missing', () => {
  const steps = load('release.yml').jobs['check-tag'].steps;
  const s = steps.find((x: any) => /release notes/i.test(x.name ?? ''));
  expect(s.run).toContain('docs/release-notes/$v.md');
  expect(s.run).toContain('exit 1');
});

test('after npm, the same version goes to GitHub Packages with only packages: write', () => {
  const job = load('release.yml').jobs['github-packages'];
  expect(job.needs).toBe('publish');
  expect(job.permissions).toEqual({ contents: 'read', packages: 'write' });
  const node = job.steps.find((s: any) => /setup-node@/.test(s.uses ?? ''));
  expect(node.with['registry-url']).toBe('https://npm.pkg.github.com');
  expect(node.with.scope).toBe('@khubaibqaiser');
  const pub = job.steps.find((s: any) => /npm publish/.test(s.run ?? ''));
  expect(pub.run).toContain('--registry https://npm.pkg.github.com');
  expect(pub.run).toContain('--tag "$tag"');
  // GitHub's registry takes no npm provenance, and this job has no id-token.
  expect(pub.run).not.toContain('--provenance');
  expect(job.permissions).not.toHaveProperty('id-token');
});

test('after npm, a GitHub release is made from the release notes, marked prerelease for beta versions', () => {
  const job = load('release.yml').jobs['github-release'];
  expect(job.needs).toBe('publish');
  expect(job.permissions).toEqual({ contents: 'write' });
  const s = job.steps.find((x: any) => /gh release create/.test(x.run ?? ''));
  expect(s.run).toContain('--verify-tag');
  expect(s.run).toContain('--notes-file "docs/release-notes/$v.md"');
  // $pre is unquoted, so it may only ever be empty or the one fixed flag.
  expect(s.run.match(/pre=\S*/g)).toEqual(['pre=""', 'pre="--prerelease"']);
  expect(s.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
});

test('prerelease versions publish with --tag beta, others latest', () => {
  const pub = allSteps('release.yml').find((s) => /npm publish/.test(s.run ?? ''));
  expect(pub.run).toContain('*-*) tag=beta');
  expect(pub.run).toContain('tag=latest');
  expect(pub.run).toContain('--tag "$tag"');
});

test('ci validates the plugin on every push and PR, on ubuntu, with Claude Code pinned to the minimum version', async () => {
  const ci = load('ci.yml');
  expect(ci.on.push).toEqual({ branches: ['main'] });
  expect(ci.on).toHaveProperty('pull_request');
  const job = ci.jobs['plugin-validate'];
  expect(job['runs-on']).toBe('ubuntu-latest');
  const { MIN_CLAUDE_CODE } = await import('../../src/core/min-claude.js');
  const runs = job.steps.map((s: any) => s.run).filter(Boolean);
  expect(runs).toEqual([`npm install -g @anthropic-ai/claude-code@${MIN_CLAUDE_CODE}`, 'claude plugin validate .']);
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

test('ci runs the offline catalog check after pnpm build', () => {
  const runs = load('ci.yml').jobs.catalog.steps.map((s: any) => s.run).filter(Boolean);
  expect(runs).toEqual(['pnpm install --frozen-lockfile', 'pnpm build', 'node dist/cli.mjs catalog check']);
});

test('test steps set HARNESS_PLAIN_INIT so the Claude-Code-only gate does not block them', () => {
  for (const f of ['ci.yml', 'claude-code-weekly.yml'])
    expect(allSteps(f).find((s: any) => s.run === 'pnpm test').env).toEqual({ HARNESS_PLAIN_INIT: '1' });
});

test('catalog-pins runs weekly and on catalog changes with --resolve', () => {
  const w = load('catalog-pins.yml');
  expect(w.on.schedule).toEqual([{ cron: '0 6 * * 1' }]);
  expect(w.on.push.paths).toEqual(['catalog/**', 'src/catalog/**']);
  expect(w.on).toHaveProperty('workflow_dispatch');
  expect(w.permissions).toEqual({ contents: 'read' });
  const steps = allSteps('catalog-pins.yml');
  const runs = steps.map((s: any) => s.run).filter(Boolean);
  expect(runs.indexOf('pnpm build')).toBeGreaterThan(-1);
  expect(runs.indexOf('node dist/cli.mjs catalog check --resolve')).toBeGreaterThan(runs.indexOf('pnpm build'));
  expect(steps.find((s: any) => s.run === 'node dist/cli.mjs catalog check --resolve').env).toEqual({ GH_TOKEN: '${{ github.token }}' });
});
