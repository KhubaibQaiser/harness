import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { deriveFacts } from './facts.js';
import { harnessIgnore } from './harnessignore.js';
import { jestCoverageUnreadable } from './test-config.js';
import { SAFE_GIT } from '../core/git-safe.js';

export interface PackageFacts {
  dir: string;
  name?: string;
  scripts: Record<string, string>;
  test: 'vitest' | 'jest' | 'none';
  testConfig?: string;
  /** Vitest only: neither @vitest/coverage-v8 nor -istanbul is declared or installed, so coverage must stay off. */
  noCoverageProvider?: true;
  /** Jest only: why the coverage gate cannot read this package's coverage output (its config moves or drops coverage-final.json). */
  coverageUnreadable?: string;
}
export interface Facts {
  root: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';
  yarnBerry: boolean;
  packages: PackageFacts[];
  python: { present: boolean; tools: ('pytest' | 'ruff' | 'mypy' | 'black')[] };
  existing: { claudeMd: boolean; agentsMd: boolean; settings: boolean; settingsLocal: boolean; claudeDir: boolean; otherHooks: string[] };
  defaultBranch: string;
  warnings: string[];
  /** Prettier is a dependency of the root or a workspace package. */
  prettier?: true;
  /** Sorted union of every package's dependency names. File checks below are root-only, except app/pages/eas.json/app.json, which are per package. */
  deps: string[];
  apps: { dir: string; kind: 'web' | 'mobile' | 'api' }[];
  frameworks: string[];
  routers: string[];
  testRunners: string[];
  /** Repo-relative paths. */
  ciFiles: string[];
  docker: boolean;
  /** Labels (terraform, cdk, pulumi, serverless, sst), not file names. */
  iac: string[];
  dbClients: string[];
  authSdks: string[];
  expo: boolean;
  /** Labels from the config file stem (vercel, netlify, fly, render, railway, wrangler, amplify). */
  deploy: string[];
  gitHooks: 'lefthook' | 'husky' | 'none';
}

const SKIP = new Set(['node_modules', '.git', '.harness']);
const MAX_DIRS = 5000;
const PY_TOOLS = ['pytest', 'ruff', 'mypy', 'black'] as const;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const COVERAGE_PROVIDERS = ['@vitest/coverage-v8', '@vitest/coverage-istanbul'];
const depsOf = (pkg: Record<string, any> | null) => new Set(DEP_FIELDS.flatMap((f) => Object.keys(pkg?.[f] ?? {})));

// Every fs read goes through these so detect never throws; a missing file is silent, any other failure becomes a warning.
// Set at the top of detect(); read() and list() honour it so a harnessignored path is never opened or listed.
let ignored: (rel: string) => boolean = () => false;

function read(root: string, rel: string, warnings: string[], skipped: string): string | null {
  if (ignored(rel)) return null;
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read \`${rel}\`; ${skipped}. Check its permissions and run init again.`);
    return null;
  }
}

function list(root: string, rel: string, warnings: string[], skipped: string): import('node:fs').Dirent[] {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true }).filter((e) => !ignored(rel ? `${rel}/${e.name}` : e.name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not list \`${rel || '.'}\`; ${skipped}. Check its permissions and run init again.`);
    return [];
  }
}

function readJson(root: string, rel: string, warnings: string[], skipped: string): Record<string, any> | null {
  const text = read(root, rel, warnings, skipped);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    warnings.push(`\`${rel}\` is not a JSON object; ${skipped}. Fix the file and run init again.`);
  } catch {
    warnings.push(`Could not parse \`${rel}\`; ${skipped}. Fix the JSON and run init again.`);
  }
  return null;
}

const git = (root: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', [...SAFE_GIT, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
  } catch {
    return null;
  }
};

function defaultBranch(root: string): string {
  const head = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(root, 'rev-parse', '--verify', '-q', `refs/heads/${b}`)) return b;
  return git(root, 'branch', '--show-current') || 'main';
}

// Expands workspace globs by walking only below each glob's static prefix; bounded, never follows symlinks (Dirent.isDirectory is false for them).
function workspaceDirs(root: string, allGlobs: string[], warnings: string[]): string[] {
  const clean = (g: string) => g.replace(/^\.\//, '').replace(/\/+$/, '');
  const globs = allGlobs.filter((g) => {
    if (!g.replace(/^!/, '').split('/').includes('..') && !isAbsolute(g.replace(/^!/, ''))) return true;
    warnings.push(`Skipped workspace glob \`${g}\` because it points outside the repo. Remove it or use a path inside the repo, then run init again.`);
    return false;
  });
  const neg = globs.filter((g) => g.startsWith('!')).map((g) => clean(g.slice(1)));
  const isNeg = neg.length ? picomatch(neg) : () => false;
  const found = new Set<string>();
  let seen = 0;
  for (const raw of globs.filter((g) => !g.startsWith('!')).map(clean)) {
    const isMatch = picomatch(raw);
    const segs = raw.split('/');
    const prefixLen = segs.findIndex((s) => /[*?[\]{}()!]/.test(s));
    const prefix = (prefixLen < 0 ? segs : segs.slice(0, prefixLen)).join('/');
    const maxDepth = segs.includes('**') ? 6 : segs.length;
    const walk = (rel: string, depth: number) => {
      if (seen++ > MAX_DIRS) return;
      if (rel && isMatch(rel) && !isNeg(rel) && existsSync(join(root, rel, 'package.json'))) found.add(rel);
      if (depth >= maxDepth) return;
      for (const e of list(root, rel, warnings, 'workspace packages below it are skipped')) if (e.isDirectory() && !SKIP.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    };
    walk(prefix, prefix ? prefix.split('/').length : 0);
  }
  return [...found].sort();
}

function packageFacts(root: string, dir: string, warnings: string[], rootDeps: Set<string>): PackageFacts {
  const pkgRel = dir === '.' ? 'package.json' : `${dir}/package.json`;
  const pkg = readJson(root, pkgRel, warnings, 'its scripts and test framework are skipped') ?? {};
  const deps = depsOf(pkg);
  const files = list(root, dir === '.' ? '' : dir, warnings, 'its test config is not detected').filter((e) => e.isFile()).map((e) => e.name);
  const cfgText = (f: string) => read(root, dir === '.' ? f : `${dir}/${f}`, warnings, 'its test config is not detected') ?? '';
  const vitestCfg = files.find((f) => /^vitest\.config\./.test(f)) ?? files.find((f) => /^vite\.config\./.test(f) && /\btest\s*:/.test(cfgText(f)));
  const jestCfg = files.find((f) => /^jest\.config\./.test(f));
  const out: PackageFacts = { dir, scripts: typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {}, test: 'none' };
  if (typeof pkg.name === 'string') out.name = pkg.name;
  if (deps.has('vitest') || vitestCfg) out.test = 'vitest';
  else if (deps.has('jest') || jestCfg || pkg.jest) out.test = 'jest';
  const cfg = out.test === 'vitest' ? vitestCfg : jestCfg;
  if (cfg) out.testConfig = cfg;
  const provider = (p: string) => deps.has(p) || rootDeps.has(p) || existsSync(join(root, dir, 'node_modules', p)) || existsSync(join(root, 'node_modules', p));
  if (out.test === 'vitest' && !COVERAGE_PROVIDERS.some(provider)) out.noCoverageProvider = true;
  const unreadable = out.test === 'jest' ? jestCoverageUnreadable(root, dir, pkg, jestCfg) : null;
  if (unreadable) out.coverageUnreadable = unreadable;
  return out;
}

function pythonFacts(root: string, warnings: string[]): Facts['python'] {
  const texts: { text: string; toml: boolean }[] = [];
  const skipped = 'Python tools are not detected from it';
  const py = read(root, 'pyproject.toml', warnings, skipped);
  if (py !== null) texts.push({ text: py, toml: true });
  for (const e of list(root, '', warnings, skipped)) if (e.isFile() && /^requirements.*\.txt$/.test(e.name)) texts.push({ text: read(root, e.name, warnings, skipped) ?? '', toml: false });
  const tools = PY_TOOLS.filter((t) =>
    texts.some(({ text, toml }) =>
      text.split('\n').some((l) => {
        const s = l.trim();
        if (s.startsWith('#')) return false;
        if (new RegExp(`^\\[tool\\.${t}[\\].]`).test(s)) return true;
        return toml ? new RegExp(`["']${t}\\b`).test(s) : new RegExp(`^${t}\\b`, 'i').test(s);
      }),
    ),
  );
  return { present: texts.length > 0, tools };
}

function collectCommands(node: unknown, out: string[]): void {
  if (Array.isArray(node)) node.forEach((n) => collectCommands(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' && typeof v === 'string') out.push(v);
      else collectCommands(v, out);
    }
  }
}

export function detect(root: string): Facts {
  const warnings: string[] = [];
  ignored = harnessIgnore(root);
  const has = (f: string) => existsSync(join(root, f));
  const rootPkg = readJson(root, 'package.json', warnings, 'its scripts and test framework are skipped');
  const hasPkg = has('package.json');

  const fieldPm = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.split('@')[0] : '';
  let packageManager: Facts['packageManager'] = 'none';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(fieldPm)) packageManager = fieldPm as Facts['packageManager'];
  else if (has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (has('yarn.lock')) packageManager = 'yarn';
  else if (has('bun.lock') || has('bun.lockb')) packageManager = 'bun';
  else if (has('package-lock.json') || hasPkg) packageManager = 'npm';

  const globs: string[] = [];
  const wsYaml = read(root, 'pnpm-workspace.yaml', warnings, 'its workspace packages are skipped');
  if (wsYaml !== null) {
    try {
      const p = parseYaml(wsYaml)?.packages;
      if (Array.isArray(p)) globs.push(...p.filter((g) => typeof g === 'string'));
    } catch {
      warnings.push('Could not parse `pnpm-workspace.yaml`; its workspace packages are skipped. Fix the YAML and run init again.');
    }
  }
  const ws = rootPkg?.workspaces;
  const wsList = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  globs.push(...wsList.filter((g: unknown): g is string => typeof g === 'string'));

  const dirs = globs.length ? workspaceDirs(root, globs, warnings).filter((d) => !ignored(d)) : [];
  const rootDeps = depsOf(rootPkg);
  const packages = [...(hasPkg ? ['.'] : []), ...dirs].map((d) => packageFacts(root, d, warnings, rootDeps));
  const pkgDeps = [...(hasPkg ? ['.'] : []), ...dirs].map((dir) => ({ dir, deps: dir === '.' ? rootDeps : depsOf(readJson(root, `${dir}/package.json`, [], '')) }));
  const prettier = pkgDeps.some((p) => p.deps.has('prettier'));
  const python = pythonFacts(root, warnings);
  const visible = (f: string) => has(f) && !ignored(f);
  const appJson = (rel: string) => readJson(root, rel, [], '');

  const otherHooks: string[] = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    const s = readJson(root, `.claude/${f}`, warnings, 'its hooks are not reported');
    if (s) collectCommands(s.hooks, otherHooks);
  }

  return {
    root,
    packageManager,
    yarnBerry: has('.yarnrc.yml'),
    packages,
    python,
    existing: {
      claudeMd: has('CLAUDE.md'),
      agentsMd: has('AGENTS.md'),
      settings: has('.claude/settings.json'),
      settingsLocal: has('.claude/settings.local.json'),
      claudeDir: has('.claude'),
      otherHooks: [...new Set(otherHooks)].filter((c) => !c.includes('.harness/hooks/dispatch.mjs')),
    },
    defaultBranch: defaultBranch(root),
    warnings: [...new Set(warnings)],
    ...(prettier ? { prettier: true as const } : {}),
    ...deriveFacts(root, pkgDeps, python, visible, appJson),
  };
}
