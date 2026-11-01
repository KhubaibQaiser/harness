import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';

export interface PackageFacts { dir: string; name?: string; scripts: Record<string, string>; test: 'vitest' | 'jest' | 'none'; testConfig?: string }
export interface Facts {
  root: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none';
  yarnBerry: boolean;
  packages: PackageFacts[];
  python: { present: boolean; tools: ('pytest' | 'ruff' | 'mypy' | 'black')[] };
  existing: { claudeMd: boolean; agentsMd: boolean; settings: boolean; settingsLocal: boolean; otherHooks: string[] };
  defaultBranch: string;
  warnings: string[];
}

const SKIP = new Set(['node_modules', '.git', '.harness']);
const MAX_DIRS = 5000;
const PY_TOOLS = ['pytest', 'ruff', 'mypy', 'black'] as const;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

function readJson(p: string, warnings: string[]): Record<string, any> | null {
  const text = read(p);
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    warnings.push(`${p}: expected a JSON object`);
  } catch (e) {
    warnings.push(`${p}: could not parse (${(e as Error).message})`);
  }
  return null;
}

const git = (root: string, ...args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
function workspaceDirs(root: string, globs: string[]): string[] {
  const clean = (g: string) => g.replace(/^\.\//, '').replace(/\/+$/, '');
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
      let ents;
      try {
        ents = readdirSync(join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) if (e.isDirectory() && !SKIP.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    };
    walk(prefix, prefix ? prefix.split('/').length : 0);
  }
  return [...found].sort();
}

function packageFacts(root: string, dir: string, warnings: string[]): PackageFacts {
  const abs = join(root, dir);
  const pkg = readJson(join(abs, 'package.json'), warnings) ?? {};
  const deps = new Set(DEP_FIELDS.flatMap((f) => Object.keys(pkg[f] ?? {})));
  let files: string[] = [];
  try {
    files = readdirSync(abs);
  } catch {}
  const vitestCfg = files.find((f) => /^vitest\.config\./.test(f)) ?? files.find((f) => /^vite\.config\./.test(f) && /\btest\s*:/.test(read(join(abs, f)) ?? ''));
  const jestCfg = files.find((f) => /^jest\.config\./.test(f));
  const out: PackageFacts = { dir, scripts: typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {}, test: 'none' };
  if (typeof pkg.name === 'string') out.name = pkg.name;
  if (deps.has('vitest') || vitestCfg) out.test = 'vitest';
  else if (deps.has('jest') || jestCfg || pkg.jest) out.test = 'jest';
  const cfg = out.test === 'vitest' ? vitestCfg : jestCfg;
  if (cfg) out.testConfig = cfg;
  return out;
}

function pythonFacts(root: string): Facts['python'] {
  const texts: { text: string; toml: boolean }[] = [];
  const py = read(join(root, 'pyproject.toml'));
  if (py !== null) texts.push({ text: py, toml: true });
  for (const f of readdirSync(root)) if (/^requirements.*\.txt$/.test(f)) texts.push({ text: read(join(root, f)) ?? '', toml: false });
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
  const has = (f: string) => existsSync(join(root, f));
  const rootPkg = readJson(join(root, 'package.json'), warnings);
  const hasPkg = has('package.json');

  const fieldPm = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager.split('@')[0] : '';
  let packageManager: Facts['packageManager'] = 'none';
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(fieldPm)) packageManager = fieldPm as Facts['packageManager'];
  else if (has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (has('yarn.lock')) packageManager = 'yarn';
  else if (has('bun.lock') || has('bun.lockb')) packageManager = 'bun';
  else if (has('package-lock.json') || hasPkg) packageManager = 'npm';

  const globs: string[] = [];
  const wsYaml = read(join(root, 'pnpm-workspace.yaml'));
  if (wsYaml !== null) {
    try {
      const p = parseYaml(wsYaml)?.packages;
      if (Array.isArray(p)) globs.push(...p.filter((g) => typeof g === 'string'));
    } catch (e) {
      warnings.push(`pnpm-workspace.yaml: could not parse (${(e as Error).message})`);
    }
  }
  const ws = rootPkg?.workspaces;
  const wsList = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
  globs.push(...wsList.filter((g: unknown): g is string => typeof g === 'string'));

  const dirs = globs.length ? workspaceDirs(root, globs) : [];
  const packages = [...(hasPkg ? ['.'] : []), ...dirs].map((d) => packageFacts(root, d, warnings));

  const otherHooks: string[] = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    const s = readJson(join(root, '.claude', f), warnings);
    if (s) collectCommands(s.hooks, otherHooks);
  }

  return {
    root,
    packageManager,
    yarnBerry: has('.yarnrc.yml'),
    packages,
    python: pythonFacts(root),
    existing: {
      claudeMd: has('CLAUDE.md'),
      agentsMd: has('AGENTS.md'),
      settings: has('.claude/settings.json'),
      settingsLocal: has('.claude/settings.local.json'),
      otherHooks: [...new Set(otherHooks)].filter((c) => !c.includes('.harness/hooks/dispatch.mjs')),
    },
    defaultBranch: defaultBranch(root),
    warnings,
  };
}
