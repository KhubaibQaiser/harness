import type { Exec } from '../core/exec.js';
import type { Catalog } from './schema.js';

/** Checks that each pinned source still exists upstream. Remote servers cannot be pinned, so they are listed instead. */
// The contents API returns an array for a directory, an object for a file.
const DIR_JQ = 'if type == "array" then "dir" else .type end';

export function resolvePins(c: Catalog, exec: Exec, only?: string[]): { problems: string[]; unpinned: { id: string; reason: string }[] } {
  const problems: string[] = [];
  const unpinned: { id: string; reason: string }[] = [];
  for (const id of only ?? []) if (!c.items.some((i) => i.id === id)) problems.push(`--only: no catalog item "${id}"`);
  const missing = new Set<string>();
  // 'absent' is a real 404; anything else non-zero is reported as "could not verify" so a rate limit never reads as a bad pin.
  const run = (cmd: string, args: string[], what: string, id: string): string | 'absent' | null => {
    const r = exec(cmd, args);
    if (r.missing) return missing.add(cmd), null;
    if (r.status === 0) return r.stdout.trim();
    const err = (r.stderr ?? '').trim();
    if (/HTTP 404|Not Found|E404/i.test(err)) return 'absent';
    problems.push(`${id}: could not verify ${what} (${cmd} exited ${r.status})${err ? `: ${err.split('\n')[0]}` : ''}`);
    return null;
  };
  for (const { id, source: s } of c.items) {
    if (only && !only.includes(id)) continue;
    if (s.type === 'remote') unpinned.push({ id, reason: s.unpinned });
    else if (s.type === 'npm') {
      if (missing.has('npm')) continue;
      const v = run('npm', ['view', `${s.package}@${s.version}`, 'version'], `${s.package}@${s.version}`, id);
      if (v === 'absent' || (v !== null && v !== s.version)) problems.push(`${id}: ${s.package}@${s.version} not found on npm`);
    } else if (s.type === 'github' || s.type === 'git-subdir') {
      if (missing.has('gh')) continue;
      const sha = run('gh', ['api', `repos/${s.repo}/commits/${s.sha}`, '--jq', '.sha'], `commit ${s.sha} in ${s.repo}`, id);
      if (sha === null) continue;
      if (sha !== s.sha) problems.push(`${id}: commit ${s.sha} not found in ${s.repo}`);
      else if (s.type === 'git-subdir') {
        const path = s.path.split('/').map(encodeURIComponent).join('/');
        const t = run('gh', ['api', `repos/${s.repo}/contents/${path}?ref=${s.sha}`, '--jq', DIR_JQ], `path ${s.path} in ${s.repo}`, id);
        if (t !== null && t !== 'dir') problems.push(`${id}: path ${s.path} is not a directory in ${s.repo} at ${s.sha}`);
      }
    }
  }
  if (missing.has('gh')) problems.push('gh not found on PATH; install GitHub CLI to check pins');
  if (missing.has('npm')) problems.push('npm not found on PATH; install npm to check pins');
  return { problems, unpinned };
}
