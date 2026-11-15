import { PROTECTED } from '../checks/protect.js';
import { tamperFindings, tamperScope } from '../checks/tdd/tamper.js';
import { esc } from '../core/config.js';
import type { Exec } from '../core/exec.js';
import { GIT_TIMEOUT_MS } from '../core/decisions-stale.js';
import { SAFE_DIFF, SAFE_GIT } from '../core/git-safe.js';
import { matches } from '../core/paths.js';
import { contractHash, TASKS_DIR, type Contract } from './contract.js';

export const WORKFLOW_PATH = '.github/workflows/harness-verify.yml';
const OWNED = [...PROTECTED, `${TASKS_DIR}/**`, WORKFLOW_PATH];
const MAX_BLOB = 1024 * 1024;

// Lowercased: a case-insensitive filesystem would otherwise let `.Harness/…` through.
export const isHarnessOwned = (rel: string): boolean => matches(rel.toLowerCase(), OWNED);

const scriptsIn = (text: string): Record<string, unknown> => {
  if (!text.trim()) return {};
  try {
    const s = (JSON.parse(text) as { scripts?: unknown })?.scripts;
    return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  } catch (e) {
    throw new Error(`package.json is not valid JSON: ${(e as Error).message}`);
  }
};

/** `names` are the checks that run as `<pm> run <name>`; one finding per script that changed or vanished. */
export function scriptChanges(before: string, after: string, names: string[]): string[] {
  const b = scriptsIn(before), a = scriptsIn(after);
  const get = (s: Record<string, unknown>, n: string) => (Object.hasOwn(s, n) ? JSON.stringify(s[n]) : undefined);
  return names.filter((n) => get(b, n) !== get(a, n)).map((n) => `package.json: script ${JSON.stringify(n)} changed`);
}

export function diffTamper(root: string, git: Exec, from: string, to: string, o: { checkNames: string[]; ownContract?: { id: string; sha256: string } }): { findings: string[]; files: string[] } {
  const g = (what: string, args: string[]): string => {
    const r = git('git', [...SAFE_GIT, ...args], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    if (r.timedOut) throw new Error(`tamper check: git ${what} timed out`);
    if (r.missing || r.status !== 0) throw new Error(`tamper check: git ${what} failed (${r.status}): ${(r.stderr ?? '').trim()}`);
    return r.stdout;
  };
  const blob = (rev: string, rel: string): string => {
    const out = g(`show ${esc(rel)}`, ['show', '--end-of-options', `${rev}:${rel}`]);
    if (out.includes('\0')) throw new Error(`tamper check: ${esc(rel)} is binary, can't be checked`);
    if (out.length > MAX_BLOB) throw new Error(`tamper check: ${esc(rel)} is too large to check`);
    return out;
  };
  const parts = g('listing changes', ['diff', ...SAFE_DIFF, '--name-status', '-z', '--no-renames', '--end-of-options', from, to, '--']).split('\0');
  if (parts.pop() !== '') throw new Error('tamper check: git diff output was cut off');
  const changed: { status: string; rel: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i]!, rel = parts[i + 1];
    if (!/^[AMDT]$/.test(status) || !rel) throw new Error(`tamper check: can't parse diff entry ${esc(status)} ${esc(rel ?? '')}`);
    changed.push({ status, rel });
  }
  const findings: string[] = [];
  const oc = o.ownContract;
  for (const { status, rel } of changed) {
    const before = () => (status === 'A' ? '' : blob(from, rel));
    const after = () => (status === 'D' ? '' : blob(to, rel));
    if (isHarnessOwned(rel)) {
      if (!(oc && status === 'A' && rel === `${TASKS_DIR}/${oc.id}.json` && approved(after(), oc))) findings.push(`protected file changed: ${esc(rel)}`);
    } else if (tamperScope(rel)) {
      const b = before(), a = after();
      findings.push(...tamperFindings(b, a, rel).map((f) => `${esc(rel)}: ${f}`));
      if (rel === 'package.json') findings.push(...scriptChanges(b, a, o.checkNames));
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
