import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Facts } from './detect.js';

/** Every file `detect` may open (repo-relative, picomatch). Everything else is looked at by name only. */
export const READ_ALLOWLIST = [
  'package.json',
  '**/package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements*.txt',
  '**/vitest.config.*',
  '**/vite.config.*',
  '**/jest.config.*',
  '**/app.json',
  '**/eas.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.harnessignore',
];

const FRAMEWORKS = ['next', 'react', 'vue', 'svelte', 'astro', '@remix-run/react', '@tanstack/react-start', 'expo', 'react-native', 'hono', 'express', 'fastify', '@nestjs/core', 'three', 'gsap'];
const ROUTERS = ['expo-router', '@tanstack/react-router', 'react-router'];
const RUNNERS = ['vitest', 'jest', '@playwright/test', 'cypress'];
const DB = ['prisma', '@prisma/client', 'drizzle-orm', '@supabase/supabase-js', 'pg', 'mongoose', '@neondatabase/serverless'];
const AUTH = /^(next-auth|@auth\/core|better-auth|@workos-inc\/node|@workos-inc\/authkit-nextjs|@clerk\/.+|@auth0\/.+)$/;
const WEB = ['next', 'astro', '@remix-run/react', '@tanstack/react-start', 'vue', 'svelte'];
const API = ['hono', 'express', 'fastify', '@nestjs/core'];
const DEPLOY: Record<string, string> = { 'vercel.json': 'vercel', 'netlify.toml': 'netlify', 'fly.toml': 'fly', 'render.yaml': 'render', 'railway.json': 'railway', 'wrangler.toml': 'wrangler', 'amplify.yml': 'amplify' };
const IAC: Record<string, string> = { 'cdk.json': 'cdk', 'Pulumi.yaml': 'pulumi', 'serverless.yml': 'serverless', 'sst.config.ts': 'sst' };

type Derived = Pick<Facts, 'deps' | 'apps' | 'frameworks' | 'routers' | 'testRunners' | 'ciFiles' | 'docker' | 'iac' | 'dbClients' | 'authSdks' | 'expo' | 'deploy' | 'gitHooks'>;

/** Project facts from dependency names and file names; `pkgs` carry each package's deps, `has` is the ignore-aware existence check, `appJson` reads a package's app.json. */
export function deriveFacts(
  root: string,
  pkgs: { dir: string; deps: Set<string> }[],
  python: Facts['python'],
  has: (rel: string) => boolean,
  appJson: (rel: string) => Record<string, any> | null,
): Derived {
  const deps = [...new Set(pkgs.flatMap((p) => [...p.deps]))].sort();
  const some = (names: string[]) => names.filter((n) => deps.includes(n)).sort();
  const at = (dir: string, f: string) => (dir === '.' ? f : `${dir}/${f}`);
  const names = (rel: string) => {
    try {
      return has(rel) || rel === '' ? readdirSync(join(root, rel)).filter((n) => has(rel ? `${rel}/${n}` : n)) : [];
    } catch {
      return [];
    }
  };

  const routers = new Set(some(ROUTERS));
  const apps: Derived['apps'] = [];
  let expo = false;
  for (const { dir, deps: d } of pkgs) {
    const hasAny = (l: string[]) => l.some((n) => d.has(n));
    if (d.has('next')) {
      if (['app', 'src/app'].some((x) => has(at(dir, x)))) routers.add('next-app');
      if (['pages', 'src/pages'].some((x) => has(at(dir, x)))) routers.add('next-pages');
    }
    const kind = hasAny(['expo', 'react-native']) ? 'mobile' : hasAny(WEB) ? 'web' : hasAny(API) ? 'api' : null;
    if (kind) apps.push({ dir, kind });
  }
  for (const dir of new Set(['.', ...pkgs.map((p) => p.dir)])) {
    if (has(at(dir, 'eas.json')) || (has(at(dir, 'app.json')) && appJson(at(dir, 'app.json'))?.expo !== undefined)) expo = true;
  }

  const ciFiles = [
    ...names('.github/workflows').filter((n) => /\.ya?ml$/.test(n)).map((n) => `.github/workflows/${n}`),
    ...['.gitlab-ci.yml', '.circleci/config.yml'].filter(has),
  ].sort();
  const tf = ['', 'infra'].some((d) => names(d).some((n) => n.endsWith('.tf')));
  const iac = [...Object.keys(IAC).filter(has).map((f) => IAC[f]), ...(tf ? ['terraform'] : [])].sort();
  const lefthook = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'].some(has) || deps.includes('lefthook');
  const husky = has('.husky') || deps.includes('husky');

  return {
    deps,
    apps: apps.sort((a, b) => a.dir.localeCompare(b.dir)),
    frameworks: some(FRAMEWORKS),
    routers: [...routers].sort(),
    testRunners: [...some(RUNNERS), ...(python.tools.includes('pytest') ? ['pytest'] : [])].sort(),
    ciFiles,
    docker: ['Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yml'].some(has),
    iac,
    dbClients: some(DB),
    authSdks: deps.filter((n) => AUTH.test(n)),
    expo,
    deploy: Object.keys(DEPLOY).filter(has).map((f) => DEPLOY[f]).sort(),
    gitHooks: lefthook ? 'lefthook' : husky ? 'husky' : 'none',
  };
}

const sortDeep = (v: unknown): unknown =>
  Array.isArray(v)
    ? (v.every((x) => typeof x === 'string') ? [...v].sort() : v).map(sortDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortDeep(x)]))
      : v;

/** Machine-independent facts: no root, no warnings, script names only, hook paths reduced to a count. Keys and string arrays sorted. */
export function factsJson(f: Facts): string {
  const { root: _root, warnings: _warnings, ...rest } = f;
  const out = {
    ...rest,
    packages: f.packages.map((p) => ({ ...p, scripts: Object.keys(p.scripts) })),
    existing: { ...f.existing, otherHooks: f.existing.otherHooks.length },
  };
  return JSON.stringify(sortDeep(out), null, 2);
}
