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
const TEST_CONFIG = /(^|\/)((vite|vitest|jest)\.config\.[^/]+|vitest\.workspace\.[^/]+)$/;
const PM_CONFIG = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.pnpmfile\.cjs|pnpm-workspace\.yaml|bunfig\.toml)$/;
const PKG = /(^|\/)package\.json$/;
const GLOB_RUNNER = /run-p|run-s|npm-run-all|concurrently/;

// Lowercased: a case-insensitive filesystem would otherwise let `.Harness/…` through.
export const isHarnessOwned = (rel: string): boolean => matches(rel.toLowerCase(), OWNED);

const scriptsIn = (text: string): Record<string, unknown> => {
  if (!text.trim()) return {};
  try {
    const s = (JSON.parse(text) as { scripts?: unknown })?.scripts;
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${esc((e as Error).message)}`);
  }
};

/** `names` are the check script names (callers pass every string step, resolved or not; a name on neither side gives
 *  nothing). Reachable scripts count too: pre/post hooks, scripts named in a reachable script, globs given to run-p & co. */
export function scriptChanges(before: string, after: string, names: string[], rel = 'package.json'): string[] {
  const b = scriptsIn(before), a = scriptsIn(after);
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const reach = new Set<string>();
  const queue = [...names];
  while (queue.length) {
    const n = queue.pop()!;
    if (reach.has(n)) continue;
    reach.add(n);
    queue.push(...[`pre${n}`, `post${n}`].filter((h) => keys.includes(h))); // only real scripts, or pre/prepre/... never ends
    for (const s of [b[n], a[n]]) {
      if (typeof s !== 'string') continue;
      const glob = GLOB_RUNNER.test(s);
      for (const t of s.split(/[^A-Za-z0-9_:.\-*]+/).filter(Boolean)) {
        if (glob && t.includes('*')) queue.push(...keys.filter((k) => matches(k, [t])));
        else if (keys.includes(t)) queue.push(t);
      }
    }
  }
  const get = (s: Record<string, unknown>, n: string) => (Object.hasOwn(s, n) ? JSON.stringify(s[n]) : undefined);
  return keys.filter((n) => reach.has(n) && get(b, n) !== get(a, n)).map((n) => `${esc(rel)}: script "${esc(n)}" changed`);
}

const jsonKeys = (text: string): string => {
  try {
    const j = JSON.parse(text || '{}') as { jest?: unknown; vitest?: unknown };
    return JSON.stringify([j.jest, j.vitest]);
  } catch {
    return text;
  }
};

export function diffTamper(root: string, git: Exec, from: string, to: string, o: { checkNames: string[]; ownContract?: { id: string; sha256: string }; timeoutMs?: number }): { findings: string[]; files: string[] } {
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
  const findings: string[] = [];
  const oc = o.ownContract;
  for (const { status, rel, link } of changed) {
    const before = () => (status === 'A' ? '' : blob(from, rel));
    const after = () => (status === 'D' ? '' : blob(to, rel));
    const r = esc(rel);
    const low = rel.toLowerCase();
    if (isHarnessOwned(rel) || (link && (low.startsWith('.harness/') || low.startsWith('.claude/')))) {
      if (!(oc && status === 'A' && !link && rel === `${TASKS_DIR}/${oc.id}.json` && approved(after(), oc))) findings.push(`protected file changed: ${r}`);
    } else if (tamperScope(rel) || TEST_CONFIG.test(rel) || PM_CONFIG.test(rel)) {
      if (link) findings.push(`${r}: symlink or submodule changed`);
      else if (PM_CONFIG.test(rel)) findings.push(`${r}: package manager config changed`);
      else if (TEST_CONFIG.test(rel)) findings.push(`${r}: test config changed`);
      else {
        const b = before(), a = after();
        findings.push(...tamperFindings(b, a, rel).map((f) => `${r}: ${f}`));
        if (PKG.test(rel)) {
          if (jsonKeys(b) !== jsonKeys(a)) findings.push(`${r}: test config changed`);
          findings.push(...scriptChanges(b, a, o.checkNames, rel));
        }
      }
    }
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
