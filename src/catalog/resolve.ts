import type { Exec } from '../core/exec.js';
import type { Catalog } from './schema.js';

/** Checks that each pinned source still exists upstream. Remote servers cannot be pinned, so they are listed instead. */
export function resolvePins(c: Catalog, exec: Exec, only?: string[]): { problems: string[]; unpinned: { id: string; reason: string }[] } {
  const problems: string[] = [];
  const unpinned: { id: string; reason: string }[] = [];
  for (const id of only ?? []) if (!c.items.some((i) => i.id === id)) problems.push(`--only: no catalog item "${id}"`);
  const missing = new Set<string>();
  const run = (cmd: string, args: string[]): string | null => {
    const r = exec(cmd, args);
    if (r.missing) return missing.add(cmd), null;
    return r.status === 0 ? r.stdout.trim() : null;
  };
  for (const { id, source: s } of c.items) {
    if (only && !only.includes(id)) continue;
    if (s.type === 'remote') unpinned.push({ id, reason: s.unpinned });
    else if (s.type === 'npm') {
      if (missing.has('npm')) continue;
      const v = run('npm', ['view', `${s.package}@${s.version}`, 'version']);
      if (v !== s.version && !missing.has('npm')) problems.push(`${id}: ${s.package}@${s.version} not found on npm`);
    } else if (s.type === 'github' || s.type === 'git-subdir') {
      if (missing.has('gh')) continue;
      const sha = run('gh', ['api', `repos/${s.repo}/commits/${s.sha}`, '--jq', '.sha']);
      if (sha !== s.sha) {
        if (!missing.has('gh')) problems.push(`${id}: commit ${s.sha} not found in ${s.repo}`);
      } else if (s.type === 'git-subdir' && run('gh', ['api', `repos/${s.repo}/contents/${s.path}?ref=${s.sha}`, '--jq', '.type']) !== 'dir') {
        problems.push(`${id}: path ${s.path} is not a directory in ${s.repo} at ${s.sha}`);
      }
    }
  }
  if (missing.has('gh')) problems.push('gh not found on PATH; install GitHub CLI to check pins');
  if (missing.has('npm')) problems.push('npm not found on PATH; install npm to check pins');
  return { problems, unpinned };
}
