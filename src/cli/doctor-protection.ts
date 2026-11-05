import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export type Gh = (args: string[]) => { status: number | null; stdout: string };
export type Protection = { state: 'ok' | 'missing' | 'unknown'; detail: string };

const MAX_FILES = 50;
const MAX_WORKFLOW_BYTES = 1 << 20;
const MAX_CONTEXTS = 100;
const SAFE_NAME = /^[\w.-]{1,100}$/; // owner, repo, branch: gh output is untrusted
const SAFE_CONTEXT = /^[\w .\/()@:+-]{1,100}$/; // printable, no control characters
const NOT_FOUND = /"status":\s*"?404|Branch not protected/; // a bare "Not Found" can be a token without admin rights, so it is unknown
const unknown = (why: string): Protection => ({ state: 'unknown', detail: `branch protection unknown (${why})` });

const MAX_REASON = 120;
// First line of gh's output, control characters stripped: gh output is untrusted.
const failed = (r: { status: number | null; stdout: string }): Protection =>
  unknown(r.status === null ? 'gh not available' : `gh could not read it: ${r.stdout.split('\n')[0].replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_REASON)}`);

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const json = (stdout: string): Record<string, unknown> | null => {
  try { return asRecord(JSON.parse(stdout)); } catch { return null; }
};
const read = (p: string): Record<string, unknown> => {
  try { if (statSync(p).size > MAX_WORKFLOW_BYTES) return {}; return asRecord(parseYaml(readFileSync(p, 'utf8'), { maxAliasCount: 100 })); } catch { return {}; }
};

/** Names of the lint or test jobs in the workflows, plus the callee jobs of local reusable workflows. */
function ciJobNames(root: string): string[] {
  const dir = join(root, '.github/workflows');
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).slice(0, MAX_FILES); } catch {}
  const names: string[] = [];
  const scan = (file: string, depth: number): void => {
    for (const [key, raw] of Object.entries(asRecord(read(file).jobs))) {
      const job = asRecord(raw);
      const steps = Array.isArray(job.steps) ? job.steps : [];
      if (steps.some((s) => /lint|test/.test(String(asRecord(s).run ?? '')))) names.push(typeof job.name === 'string' ? job.name : key);
      const uses = job.uses;
      if (depth && typeof uses === 'string' && uses.startsWith('./.github/workflows/') && !uses.includes('..')) scan(join(root, uses), depth - 1);
    }
  };
  for (const f of files) scan(join(dir, f), 1);
  return names;
}

/** Whether the default branch requires a lint or test CI job. Offline-safe: only `gh` (an args array, never a shell) is called. */
export function branchProtection(root: string, gh: Gh | undefined): Protection {
  if (!gh) return unknown('gh not available');
  const view = gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  if (view.status !== 0) return failed(view);
  const repo = json(view.stdout);
  const slug = repo?.nameWithOwner;
  const branch = asRecord(repo?.defaultBranchRef).name;
  if (typeof slug !== 'string' || typeof branch !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(slug) || !SAFE_NAME.test(branch)) return unknown('gh gave an unexpected answer');
  const res = gh(['api', `repos/${slug}/branches/${branch}/protection`]);
  if (res.status !== 0) return NOT_FOUND.test(res.stdout)
    ? { state: 'missing', detail: `${branch} is not protected: add a branch protection rule so merges require the CI checks (lint and test)` }
    : failed(res);
  const rsc = asRecord(json(res.stdout)?.required_status_checks);
  const checks = Array.isArray(rsc.checks) ? rsc.checks.map((c) => asRecord(c).context) : [];
  const contexts = [...(Array.isArray(rsc.contexts) ? rsc.contexts : []), ...checks]
    .filter((c): c is string => typeof c === 'string' && SAFE_CONTEXT.test(c)).slice(0, MAX_CONTEXTS);
  const jobs = ciJobNames(root);
  // A reusable workflow reads `<caller job> / <callee job>`, so a suffix match counts.
  const hit = contexts.filter((c) => jobs.some((n) => c === n || c.endsWith(` / ${n}`)));
  if (hit.length) return { state: 'ok', detail: `${branch} is protected and requires ${hit.map((c) => `\`${c}\``).join(', ')}` };
  return { state: 'missing', detail: `${branch} is protected but no required check matches a lint or test CI job: require the CI checks (lint and test) in the branch protection rule` };
}
