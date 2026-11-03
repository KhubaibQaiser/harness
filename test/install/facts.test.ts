import { readFileSync as realRead } from 'node:fs';
import { relative } from 'node:path';
import picomatch from 'picomatch';
import { beforeEach, expect, test, vi } from 'vitest';
import { detect } from '../../src/install/detect.js';
import { factsJson, READ_ALLOWLIST } from '../../src/install/facts.js';
import { makeRepo } from './helpers.js';

const reads: string[] = [];
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>();
  return { ...m, readFileSync: ((p: any, ...a: any[]) => (reads.push(String(p)), (m.readFileSync as any)(p, ...a))) as typeof m.readFileSync };
});
beforeEach(() => void (reads.length = 0));

const pj = (o: object) => JSON.stringify(o);
const dev = (...names: string[]) => pj({ devDependencies: Object.fromEntries(names.map((n) => [n, '1'])) });
const facts = (files: Record<string, string>) => detect(makeRepo(files, { git: false }));

test('deps are the sorted union over packages', () => {
  const f = facts({ 'package.json': pj({ workspaces: ['apps/*'], dependencies: { zod: '1' } }), 'apps/a/package.json': dev('next', 'zod'), 'apps/b/package.json': dev('hono') });
  expect(f.deps).toEqual(['hono', 'next', 'zod']);
});

test.each([
  ['frameworks', ['next', 'react', 'vue', 'svelte', 'astro', '@remix-run/react', '@tanstack/react-start', 'expo', 'react-native', 'hono', 'express', 'fastify', '@nestjs/core', 'three', 'gsap']],
  ['dbClients', ['prisma', '@prisma/client', 'drizzle-orm', '@supabase/supabase-js', 'pg', 'mongoose', '@neondatabase/serverless']],
  ['authSdks', ['next-auth', '@auth/core', 'better-auth', '@workos-inc/node', '@workos-inc/authkit-nextjs', '@clerk/nextjs', '@auth0/auth0-react']],
  ['routers', ['expo-router', '@tanstack/react-router', 'react-router']],
  ['testRunners', ['vitest', 'jest', '@playwright/test', 'cypress']],
] as const)('%s table', (key, names) => {
  for (const n of names) expect((facts({ 'package.json': dev(n) }) as any)[key], n).toContain(n);
  expect((facts({ 'package.json': dev('left-pad') }) as any)[key]).toEqual([]);
});

test('routers next-app and next-pages need the next dep and the directory', () => {
  expect(facts({ 'package.json': dev('next'), 'app/page.tsx': '' }).routers).toEqual(['next-app']);
  expect(facts({ 'package.json': dev('next'), 'src/app/page.tsx': '' }).routers).toEqual(['next-app']);
  expect(facts({ 'package.json': dev('next'), 'pages/index.tsx': '' }).routers).toEqual(['next-pages']);
  expect(facts({ 'package.json': dev('react'), 'app/x.ts': '' }).routers).toEqual([]);
});

test('pytest from the python facts is a test runner', () => {
  expect(facts({ 'requirements.txt': 'pytest\n' }).testRunners).toEqual(['pytest']);
});

test('ciFiles', () => {
  const f = facts({ '.github/workflows/ci.yml': '', '.github/workflows/b.yaml': '', '.github/workflows/readme.md': '', '.gitlab-ci.yml': '', '.circleci/config.yml': '' });
  expect(f.ciFiles).toEqual(['.circleci/config.yml', '.github/workflows/b.yaml', '.github/workflows/ci.yml', '.gitlab-ci.yml']);
  expect(facts({ a: '1' }).ciFiles).toEqual([]);
});

test.each(['Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml'])('docker via %s', (file) => {
  expect(facts({ [file]: '' }).docker).toBe(true);
  expect(facts({ a: '1' }).docker).toBe(false);
});

test('iac', () => {
  expect(facts({ 'cdk.json': '{}' }).iac).toEqual(['cdk']);
  expect(facts({ 'main.tf': '' }).iac).toEqual(['terraform']);
  expect(facts({ 'infra/main.tf': '' }).iac).toEqual(['terraform']);
  expect(facts({ 'Pulumi.yaml': '', 'serverless.yml': '', 'sst.config.ts': '' }).iac).toEqual(['pulumi', 'serverless', 'sst']);
  expect(facts({ 'deep/main.tf': '' }).iac).toEqual([]);
});

test('expo from app.json with an expo key, or eas.json', () => {
  expect(facts({ 'app.json': pj({ expo: { name: 'x' } }) }).expo).toBe(true);
  expect(facts({ 'eas.json': '{}' }).expo).toBe(true);
  expect(facts({ 'app.json': pj({ name: 'x' }) }).expo).toBe(false);
  expect(facts({ 'apps/m/app.json': pj({ expo: {} }), 'package.json': pj({ workspaces: ['apps/*'] }), 'apps/m/package.json': '{}' }).expo).toBe(true);
});

test('deploy', () => {
  const f = facts({ 'vercel.json': '', 'netlify.toml': '', 'fly.toml': '', 'render.yaml': '', 'railway.json': '', 'wrangler.toml': '', 'amplify.yml': '' });
  expect(f.deploy).toEqual(['amplify', 'fly', 'netlify', 'railway', 'render', 'vercel', 'wrangler']);
  expect(facts({ a: '1' }).deploy).toEqual([]);
});

test('gitHooks', () => {
  expect(facts({ 'lefthook.yml': '' }).gitHooks).toBe('lefthook');
  expect(facts({ 'package.json': dev('lefthook', 'husky') }).gitHooks).toBe('lefthook');
  expect(facts({ '.husky/pre-commit': '' }).gitHooks).toBe('husky');
  expect(facts({ 'package.json': dev('husky') }).gitHooks).toBe('husky');
  expect(facts({ a: '1' }).gitHooks).toBe('none');
});

test('existing.claudeDir', () => {
  expect(facts({ '.claude/x.md': '' }).existing.claudeDir).toBe(true);
  expect(facts({ a: '1' }).existing.claudeDir).toBe(false);
});

test('app kinds: mobile beats web beats api', () => {
  const f = facts({ 'package.json': pj({ workspaces: ['apps/*'] }), 'apps/m/package.json': dev('expo', 'next'), 'apps/w/package.json': dev('astro', 'express'), 'apps/a/package.json': dev('fastify'), 'apps/l/package.json': dev('react') });
  expect(f.apps).toEqual([{ dir: 'apps/a', kind: 'api' }, { dir: 'apps/m', kind: 'mobile' }, { dir: 'apps/w', kind: 'web' }]);
});

test('monorepo with web, mobile and api apps', () => {
  const f = facts({
    'package.json': pj({ workspaces: ['apps/*'] }),
    'apps/web/package.json': dev('next'),
    'apps/mobile/package.json': dev('expo'),
    'apps/api/package.json': dev('hono'),
  });
  expect(f.apps).toEqual([{ dir: 'apps/api', kind: 'api' }, { dir: 'apps/mobile', kind: 'mobile' }, { dir: 'apps/web', kind: 'web' }]);
});

test('detect never opens .env files, harnessignored paths or .harness/', () => {
  const root = makeRepo(
    {
      'package.json': pj({ workspaces: ['apps/*', 'fixtures/*'] }),
      'apps/web/package.json': dev('next'),
      'apps/web/vitest.config.ts': 'export default {}',
      'fixtures/demo/package.json': dev('express'),
      '.env': 'SECRET=1',
      '.env.local': 'SECRET=2',
      'apps/web/.env': 'SECRET=3',
      '.harness/results/x.json': '{}',
      '.harnessignore': 'fixtures/**\n',
      '.claude/settings.json': '{}',
      'requirements.txt': 'pytest\n',
    },
    { git: false },
  );
  const f = detect(root);
  expect(f.deps).toEqual(['next']);
  expect(f.apps).toEqual([{ dir: 'apps/web', kind: 'web' }]);
  const rels = reads.filter((p) => p.startsWith(root)).map((p) => relative(root, p).split('\\').join('/'));
  expect(rels.length).toBeGreaterThan(3);
  const ok = picomatch(READ_ALLOWLIST, { dot: true });
  for (const r of rels) {
    expect(r, r).not.toMatch(/(^|\/)\.env/);
    expect(r, r).not.toMatch(/^(fixtures|\.harness)\//);
    expect(ok(r), r).toBe(true);
  }
});

test('facts json has no absolute paths and is stable', () => {
  const files = {
    'package.json': pj({ name: 'x', scripts: { z: 'echo /abs/z', build: 'tsc' }, devDependencies: { next: '1', vitest: '1' } }),
    '.claude/settings.local.json': pj({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '/Users/someone/bin/notify.sh' }] }] } }),
  };
  const a = makeRepo(files, { git: false, prefix: 'harness-aaa-' });
  const b = makeRepo(files, { git: false, prefix: 'harness-bbbbbb-' });
  const ja = factsJson(detect(a));
  expect(ja).not.toContain(a);
  expect(ja).not.toContain('/Users/someone');
  expect(ja).not.toContain('echo /abs');
  const p = JSON.parse(ja);
  expect(p.root).toBeUndefined();
  expect(p.warnings).toBeUndefined();
  expect(p.packages[0].scripts).toEqual(['build', 'z']);
  expect(p.existing.otherHooks).toBe(1);
  const keys = Object.keys(p);
  expect(keys).toEqual([...keys].sort());
  expect(p.deps).toEqual([...p.deps].sort());
  expect(factsJson(detect(b))).toBe(ja);
  expect(realRead).toBeTypeOf('function');
});
