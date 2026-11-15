import { PROTECTED } from '../checks/protect.js';
import { tamperFindings, tamperScope } from '../checks/tdd/tamper.js';
import { esc } from '../core/config.js';
import type { Exec } from '../core/exec.js';
import { SAFE_DIFF, SAFE_GIT } from '../core/git-safe.js';
import { matches } from '../core/paths.js';
import { contractHash, TASKS_DIR, type Contract } from './contract.js';

export const WORKFLOW_PATH = '.github/workflows/harness-verify.yml';
// The ancestors too: `.harness` itself swapped for a symlink is a change to harness-owned files.
const OWNED = [...PROTECTED, `${TASKS_DIR}/**`, WORKFLOW_PATH, '.harness', '.claude', '.github', '.github/workflows', TASKS_DIR];
const MAX_BLOB = 1024 * 1024;
const TEST_CONFIG = /(^|\/)((vite|vitest|jest|babel|ava|playwright|cypress)\.config\.[^/]+|karma\.conf\.[^/]+|vitest\.workspace\.[^/]+|\.babelrc[^/]*|\.mocharc[^/]*|turbo\.json|nx\.json|tsconfig[^/]*\.json)$/;
const PM_CONFIG = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|bunfig\.toml|\.pnp\.cjs|\.pnp\.loader\.mjs)$|(^|\/)\.yarn\//;
const BAD_SPEC = /^(file:|link:|portal:|git[+:]|github:|gitlab:|bitbucket:|\.{0,2}\/|~\/)|^[\w.-]+\/[\w.-]+(#.*)?$/;
const TOOL_KEYS = ['jest', 'vitest', 'babel', 'mocha'];
const DEPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const PKG = /(^|\/)package\.json$/;

// Lowercased: a case-insensitive filesystem would otherwise let `.Harness/…` through.
export const isHarnessOwned = (rel: string): boolean => matches(rel.toLowerCase(), OWNED);

type Pkg = { scripts?: Record<string, unknown>; config?: unknown } & Record<string, unknown>;
const parse = (text: string, rel: string): Pkg => {
  try {
    const j: unknown = JSON.parse(text.trim() ? text : '{}');
    return j && typeof j === 'object' ? (j as Pkg) : {};
  } catch (e) {
    throw new Error(`${esc(rel)} is not valid JSON: ${esc((e as Error).message)}`);
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Flat, fail-closed: any change to `scripts`, `config`, a test tool's key or a path-like dependency spec is a finding. */
function pkgFindings(b: Pkg, a: Pkg, r: string): string[] {
  const out: string[] = [];
  const bs = b.scripts ?? {}, as = a.scripts ?? {};
  const keys = [...new Set([...Object.keys(bs), ...Object.keys(as)])].filter((k) => !same(bs[k], as[k]));
  if (keys.length) out.push(`${r}: scripts changed (${keys.map(esc).join(', ')})`);
  if (!same(b.config, a.config)) out.push(`${r}: config changed`);
  if (TOOL_KEYS.some((k) => !same(b[k], a[k]))) out.push(`${r}: test config changed`);
  for (const d of DEPS) {
    const bd = (b[d] ?? {}) as Record<string, unknown>;
    for (const [n, spec] of Object.entries((a[d] ?? {}) as Record<string, unknown>)) {
      if (typeof spec !== 'string' || spec === bd[n]) continue;
      if (BAD_SPEC.test(spec)) out.push(`${r}: dependency "${esc(n)}" points at ${esc(spec)}`);
    }
  }
  return out;
}

export function diffTamper(root: string, git: Exec, from: string, to: string, o: { ownContract?: { id: string; sha256: string }; timeoutMs?: number }): { findings: string[]; files: string[] } {
  // ponytail: --no-replace-objects is already in SAFE_GIT; grafts are not covered by it, so both go in the environment too.
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/harness-no-grafts' };
  const g = (what: string, args: string[]): string => {
    const r = git('git', [...SAFE_GIT, ...args], { cwd: root, env, timeoutMs: o.timeoutMs ?? 30_000 });
    if (r.timedOut) throw new Error(`tamper check: git ${what} timed out`);
    if (r.missing || r.status !== 0) throw new Error(`tamper check: git ${what} failed (${r.status}): ${esc((r.stderr ?? '').trim())}`);
    return r.stdout;
  };
  const blob = (rev: string, rel: string): string => {
    const out = g(`show ${esc(rel)}`, ['show', '--end-of-options', `${rev}:${rel}`]);
    if (out.includes('\0')) throw new Error(`tamper check: ${esc(rel)} is binary, can't be checked`);
    if (out.length > MAX_BLOB) throw new Error(`tamper check: ${esc(rel)} is too large to check`);
    return out;
  };
  const parts = g('listing changes', ['diff', ...SAFE_DIFF, '--raw', '-z', '--no-renames', '--end-of-options', from, to, '--']).split('\0');
  if (parts.pop() !== '') throw new Error('tamper check: git diff output was cut off');
  const changed: { status: string; rel: string; link: boolean }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMDT])$/.exec(parts[i]!), rel = parts[i + 1];
    if (!m || !rel) throw new Error(`tamper check: can't parse diff entry ${esc(parts[i]!)} ${esc(rel ?? '')}`);
    changed.push({ status: m[3]!, rel, link: [m[1]!, m[2]!].some((x) => x === '120000' || x === '160000') });
  }
  // Paths a package.json script names (`--config ci.config.ts`): every package.json on both sides, resolved against its own folder and the root.
  const named = new Set<string>();
  const addWords = (p: Pkg, dir: string) => Object.values(p.scripts ?? {}).forEach((v) => typeof v === 'string' && v.split(/[\s"'`;&|()<>=]+/).forEach((w) => {
    const word = w.replace(/^\.\//, '');
    named.add(word);
    named.add(dir + word);
  }));
  for (const rev of [from, to]) {
    const all = g('listing package.json files', ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', rev]).split('\0');
    for (const f of all) if (PKG.test(f) && !f.split('/').includes('node_modules')) addWords(parse(blob(rev, f), f), f.slice(0, f.length - 'package.json'.length));
  }
  const findings: string[] = [];
  const oc = o.ownContract;
  for (const { status, rel, link } of changed) {
    const before = () => (status === 'A' ? '' : blob(from, rel));
    const after = () => (status === 'D' ? '' : blob(to, rel));
    const r = esc(rel);
    const low = rel.toLowerCase();
    if (isHarnessOwned(rel) || (link && (low.startsWith('.harness/') || low.startsWith('.claude/')))) {
      if (!(oc && status === 'A' && !link && rel === `${TASKS_DIR}/${oc.id}.json` && approved(after(), oc))) findings.push(`protected file changed: ${r}`);
    } else if (link) findings.push(`${r}: symlink or submodule changed`);
    else if (PM_CONFIG.test(rel)) findings.push(`${r}: package manager config changed`);
    else if (TEST_CONFIG.test(rel) || named.has(rel)) findings.push(`${r}: test config changed`);
    else if (PKG.test(rel)) {
      const b = before(), a = after();
      findings.push(...tamperFindings(b, a, rel).map((f) => `${r}: ${f}`), ...pkgFindings(parse(b, rel), parse(a, rel), r));
    } else if (tamperScope(rel)) findings.push(...tamperFindings(before(), after(), rel).map((f) => `${r}: ${f}`));
  }
  return { findings, files: changed.map((c) => c.rel) };
}

function approved(text: string, oc: { id: string; sha256: string }): boolean {
  try {
    const c = JSON.parse(text) as Contract;
    return c.id === oc.id && contractHash(c) === oc.sha256;
  } catch {
    return false;
  }
}
