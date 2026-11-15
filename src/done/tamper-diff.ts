import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PROTECTED } from '../checks/protect.js';
import { tamperFindings, tamperScope } from '../checks/tdd/tamper.js';
import { esc } from '../core/config.js';
import type { Exec, ExecOpts } from '../core/exec.js';
import { SAFE_DIFF, SAFE_GIT } from '../core/git-safe.js';
import { matches } from '../core/paths.js';
import { contractHash, TASKS_DIR, type Contract } from './contract.js';

export const WORKFLOW_PATH = '.github/workflows/harness-verify.yml';
// The ancestors too: `.harness` itself swapped for a symlink is a change to harness-owned files.
const OWNED = [...PROTECTED, `${TASKS_DIR}/**`, WORKFLOW_PATH, '.harness', '.claude', '.github', '.github/workflows', TASKS_DIR];
const MAX_BLOB = 1024 * 1024;
const TEST_CONFIG = /(^|\/)((vite|vitest|jest|babel|ava|playwright|cypress)\.config\.[^/]+|karma\.conf\.[^/]+|vitest\.workspace\.[^/]+|\.babelrc[^/]*|\.mocharc[^/]*|turbo\.json|nx\.json|tsconfig[^/]*\.json)$/;
const PM_CONFIG = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|bunfig\.toml|\.pnp\.cjs|\.pnp\.loader\.mjs)$|(^|\/)\.yarn\//;
const BAD_SPEC = /^(file:|link:|portal:|workspace:|npm:|https?:|git[+:]|github:|gitlab:|bitbucket:|\.{0,2}\/|~\/)|^[\w.-]+\/[\w.-]+(#.*)?$|\.(tgz|tar\.gz|tar)$/;
const TOOL_KEYS = ['jest', 'vitest', 'babel', 'mocha'];
const REDIRECTS = ['overrides', 'resolutions', 'pnpm.overrides', 'pnpm.patchedDependencies'];
const DEPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const PKG = /(^|\/)package\.(json|json5|yaml)$/;
const LOCK = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lock)$/;
const LOCAL_DEP = /\b(file|link|portal):|"link":\s*true/;
const LOCK_MAX = 16 * MAX_BLOB;
const BATCH = 32 * MAX_BLOB;
// ~87 bytes per entry: about 3 million files.
const TREE_MAX = 256 * MAX_BLOB;
const ROOT_VAR = /^\$\{?(INIT_CWD|npm_config_local_prefix)\}?\//;
const ZERO = /^0+$/;

// Lowercased: a case-insensitive filesystem would otherwise let `.Harness/…` through.
export const isHarnessOwned = (rel: string): boolean => matches(rel.toLowerCase(), OWNED);

type Pkg = { scripts?: Record<string, unknown>; config?: unknown } & Record<string, unknown>;
// null: not readable as a package file. package.json5 is read as JSON only (no JSON5 parser here), so comments make it unreadable.
const parse = (text: string | null, rel: string): Pkg | null => {
  if (text === null) return null;
  if (!text.trim()) return {};
  try {
    const j: unknown = rel.endsWith('.yaml') ? parseYaml(text) : JSON.parse(text.replace(/^﻿/, ''));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Pkg) : null;
  } catch {
    return null;
  }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const at = (p: Pkg, key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), p);

/** Flat, fail-closed: any change to `scripts`, `config`, a test tool's key, an override or a path-like dependency spec is a finding. */
function pkgFindings(b: Pkg, a: Pkg, r: string, depNames: Set<string>): string[] {
  const out: string[] = [];
  const bs = b.scripts ?? {}, as = a.scripts ?? {};
  const keys = [...new Set([...Object.keys(bs), ...Object.keys(as)])].filter((k) => !same(bs[k], as[k]));
  if (keys.length) out.push(`${r}: scripts changed (${keys.map(esc).join(', ')})`);
  if (!same(b.config, a.config)) out.push(`${r}: config changed`);
  if (TOOL_KEYS.some((k) => !same(b[k], a[k]))) out.push(`${r}: test config changed`);
  for (const k of REDIRECTS) if (!same(at(b, k), at(a, k))) out.push(`${r}: ${k} changed`);
  // npm, pnpm and yarn link a workspace package in by name, so a new or renamed package can stand in for a dependency.
  if (typeof a.name === 'string' && a.name !== b.name && depNames.has(a.name)) out.push(`${r}: package name "${esc(a.name)}" matches a dependency`);
  for (const d of DEPS) {
    const bd = (b[d] ?? {}) as Record<string, unknown>;
    for (const [n, spec] of Object.entries((a[d] ?? {}) as Record<string, unknown>)) {
      if (typeof spec !== 'string' || spec === bd[n]) continue;
      if (BAD_SPEC.test(spec)) out.push(`${r}: dependency "${esc(n)}" points at ${esc(spec)}`);
    }
  }
  return out;
}

export function diffTamper(root: string, git: Exec, from: string, to: string, o: { ownContract?: { id: string; sha256: string }; timeoutMs?: number; namedPaths?: string[] }): { findings: string[]; files: string[] } {
  // ponytail: --no-replace-objects is already in SAFE_GIT; grafts are not covered by it, so both go in the environment too.
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/harness-no-grafts' };
  const g = (what: string, args: string[], x: ExecOpts = {}): string => {
    const r = git('git', [...SAFE_GIT, ...args], { cwd: root, env, timeoutMs: o.timeoutMs ?? 30_000, ...x });
    if (r.timedOut) throw new Error(`tamper check: git ${what} timed out`);
    if (r.missing || r.status !== 0) throw new Error(`tamper check: git ${what} failed (${r.status}): ${esc((r.stderr ?? '').trim())}`);
    return r.stdout;
  };
  const split = (out: string, what: string) => {
    const parts = out.split('\0');
    if (parts.pop() !== '') throw new Error(`tamper check: ${what} output was cut off`);
    return parts;
  };
  const parts = split(g('listing changes', ['diff', ...SAFE_DIFF, '--raw', '-z', '--no-abbrev', '--no-renames', '--end-of-options', from, to, '--']), 'git diff');
  const changed: { status: string; rel: string; link: boolean; ob: string; oa: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(parts[i]!), rel = parts[i + 1];
    if (!m || !rel) throw new Error(`tamper check: can't parse diff entry ${esc(parts[i]!)} ${esc(rel ?? '')}`);
    changed.push({ status: m[5]!, rel, link: [m[1]!, m[2]!].some((x) => x === '120000' || x === '160000'), ob: m[3]!, oa: m[4]! });
  }
  // Every blob is read in one cat-file call, deduped by id across both sides; `size` comes from ls-tree, so nothing oversize is read.
  const size = new Map<string, number>(), want = new Map<string, string>(), pkgs: { oid: string; rel: string }[] = [];
  const need = (oid: string, rel: string, cap = MAX_BLOB) => { if (!ZERO.test(oid) && (size.get(oid) ?? 0) <= cap && !want.has(oid)) want.set(oid, rel); };
  for (const rev of [from, to]) {
    for (const e of split(g('listing files', ['ls-tree', '-r', '-l', '-z', '--end-of-options', rev], { maxBuffer: TREE_MAX }), 'git ls-tree')) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t([^]*)$/.exec(e);
      if (!m) throw new Error(`tamper check: can't parse tree entry ${esc(e)}`);
      size.set(m[3]!, Number(m[4]));
      if ((m[1] === '100644' || m[1] === '100755') && PKG.test(m[5]!) && !m[5]!.split('/').includes('node_modules')) pkgs.push({ oid: m[3]!, rel: m[5]! });
    }
  }
  const oc = o.ownContract;
  for (const p of pkgs) need(p.oid, p.rel);
  for (const c of changed) if (!c.link && (tamperScope(c.rel) || PKG.test(c.rel) || LOCK.test(c.rel) || c.rel === `${TASKS_DIR}/${oc?.id}.json`)) for (const oid of [c.ob, c.oa]) need(oid, c.rel, LOCK.test(c.rel) ? LOCK_MAX : MAX_BLOB);
  // Batches of at most BATCH bytes (by ls-tree size) keep each read under the exec output limit; one blob is at most LOCK_MAX.
  const batches: [string, string][][] = [];
  let sum = Infinity;
  for (const e of want) {
    const n = size.get(e[0]) ?? 0;
    if (sum + n > BATCH) { batches.push([]); sum = 0; }
    batches.at(-1)!.push(e);
    sum += n;
  }
  const got = new Map<string, string>();
  for (const batch of batches) {
    const out = g('reading files', ['cat-file', '--batch'], { input: batch.map(([oid]) => oid).join('\n') + '\n', encoding: 'latin1' });
    let i = 0;
    for (const [oid, rel] of batch) {
      const nl = out.indexOf('\n', i), m = /^([0-9a-f]+) (?:blob (\d+)|(missing))$/.exec(out.slice(i, nl < 0 ? i : nl));
      if (!m || m[1] !== oid) throw new Error('tamper check: git cat-file output was cut off');
      if (m[3]) throw new Error(`tamper check: git can't read ${esc(rel)}`);
      got.set(oid, Buffer.from(out.slice(nl + 1, nl + 1 + Number(m[2])), 'latin1').toString('utf8'));
      i = nl + 2 + Number(m[2]);
    }
    if (i !== out.length) throw new Error('tamper check: git cat-file output was cut off');
  }
  // null: binary, or over `cap`.
  const body = (oid: string, cap = MAX_BLOB): string | null => {
    if (ZERO.test(oid)) return '';
    if ((size.get(oid) ?? 0) > cap) return null;
    const t = got.get(oid);
    if (t === undefined) throw new Error('tamper check: a blob was not read');
    return t.includes('\0') ? null : t;
  };
  const text = (oid: string, rel: string): string => {
    const t = body(oid);
    if (t === null) throw new Error(`tamper check: ${esc(rel)} is ${(size.get(oid) ?? 0) > MAX_BLOB ? 'too large to check' : "binary, can't be checked"}`);
    return t;
  };
  // Paths a script names (`--config ci.config.ts`), from every readable package file on both sides, against its own folder and the root.
  const named = new Set<string>((o.namedPaths ?? []).map((p) => posix.normalize(p)));
  const depNames = new Set<string>();
  for (const { oid, rel } of pkgs) {
    const p = parse(body(oid), rel);
    if (!p) continue; // npm can't run scripts from a package file it can't read
    for (const d of DEPS) Object.keys(p[d] ?? {}).forEach((n) => depNames.add(n));
    const dir = rel.slice(0, rel.lastIndexOf('/') + 1);
    // ponytail: `$INIT_CWD` and the local prefix are the root; other `$` words are not followed (Known limit).
    for (const v of Object.values(p.scripts ?? {})) if (typeof v === 'string') for (const w of v.split(/[\s"'`;&|()<>=]+/)) {
      if (ROOT_VAR.test(w)) named.add(posix.normalize(w.replace(ROOT_VAR, '')));
      else named.add(posix.normalize(w)).add(posix.join(dir, w));
    }
  }
  const findings: string[] = [];
  for (const { status, rel, link, ob, oa } of changed) {
    const r = esc(rel);
    const low = rel.toLowerCase();
    if (isHarnessOwned(rel) || (link && (low.startsWith('.harness/') || low.startsWith('.claude/')))) {
      if (!(oc && status === 'A' && !link && rel === `${TASKS_DIR}/${oc.id}.json` && approved(body(oa) ?? '', oc))) findings.push(`protected file changed: ${r}`);
    } else if (link) findings.push(`${r}: symlink or submodule changed`);
    else if (PM_CONFIG.test(rel)) findings.push(`${r}: package manager config changed`);
    else if (TEST_CONFIG.test(rel)) findings.push(`${r}: test config changed`);
    else if (named.has(rel)) findings.push(`${r}: file named by a package.json script changed`);
    else if (LOCK.test(rel)) {
      const b = body(ob, LOCK_MAX), a = body(oa, LOCK_MAX), old = new Set(b?.split('\n'));
      if (b === null || a === null) findings.push(`${r}: lockfile unreadable`);
      // ponytail: added lines only; other lockfile changes are left to the install gate.
      else if (a.split('\n').some((l) => !old.has(l) && LOCAL_DEP.test(l))) findings.push(`${r}: lockfile adds a local file, link or portal dependency`);
    } else if (PKG.test(rel)) {
      const bt = body(ob), atx = body(oa), b = parse(bt, rel), a = parse(atx, rel);
      if (!b || !a) findings.push(`${r}: package.json unreadable`);
      else findings.push(...tamperFindings(bt!, atx!, rel).map((f) => `${r}: ${f}`), ...pkgFindings(b, a, r, depNames));
    } else if (tamperScope(rel)) findings.push(...tamperFindings(text(ob, rel), text(oa, rel), rel).map((f) => `${r}: ${f}`));
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
