import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateVetReview, type VetReview } from '../ai/vet-review.js';
import { writeAtomic } from '../core/atomic.js';
import { CONTROL, esc } from '../core/config.js';
import { defaultExec, defaultExecBytes, type Exec, type ExecBytes } from '../core/exec.js';
import { cleanAllTmp, cleanTmp, fetchTarball, isVetTmp } from '../vet/fetch.js';
import { aheadBy, installInfo, installLines, reportMarkdown, summaryLines } from '../vet/report.js';
import { scan, type ScanResult } from '../vet/scan.js';
import { REPO, marketList, marketRepoOf, parseTarget, resolveTarget, safe, vetId, type Resolved, type Target } from '../vet/target.js';
import type { CliEnv } from './index.js';
import { installedIds } from './validate.js';

const USAGE = 'Usage: harness vet <target> [--json [--keep]]\n       harness vet --finish <scan.json> --review <file>\n       harness vet --install <scan.json>\n       harness vet --clean';
const NOT_SCAN = 'scan: not a vet scan; run harness vet --json first';
type Out = (line: string) => void;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Scans a GitHub plugin or skill without running it and writes `.harness/vet/<id>-<sha>.md`. Installs nothing; safe for the agent. */
export function vet(args: string[], { root, out }: CliEnv, deps: { exec?: Exec; bytes?: ExecBytes } = {}): number {
  const exec = deps.exec ?? defaultExec;
  const [a, b, c, d] = args;
  if (a === '--clean' && args.length === 1) return out(`Removed ${cleanAllTmp()} unpacked vet folder(s).`), 0;
  if (a === '--install' && b && args.length === 2) return install(b, root, out);
  if (a === '--finish' && b && c === '--review' && d && args.length === 4) return finish(b, d, root, out, exec);
  const flags = args.slice(1);
  const json = flags.includes('--json'), keep = flags.includes('--keep');
  if (!a || a.startsWith('--') || flags.some((f) => f !== '--json' && f !== '--keep') || new Set(flags).size !== flags.length || (keep && !json)) return out(USAGE), 2;

  const t = parseTarget(a);
  if ('error' in t) return out(t.error), 1;
  const r = resolveTarget(t, exec);
  if ('error' in r) return out(r.error), 1;
  const f = fetchTarball(r, deps.bytes ?? defaultExecBytes);
  if ('error' in f) return out(f.error), 1;
  try {
    const s: ScanResult = { target: a, repo: r.repo, sha: r.sha, path: r.path, ...scan(f, r.path) };
    if (json) return out(JSON.stringify(keep ? { ...s, dir: f.dir, map: f.map } : s, null, 2)), 0;
    return report(root, out, s, r, null, installFor(s, r, f.dir, exec));
  } finally {
    if (!keep) cleanTmp(f.dir); // spec 3.5: gone after success and failure alike
  }
}

function report(root: string, out: Out, s: ScanResult, r: Resolved, review: VetReview | null, install: string[]): number {
  const rel = `.harness/vet/${vetId(r)}-${s.sha}.md`;
  mkdirSync(join(root, '.harness', 'vet'), { recursive: true });
  writeAtomic(join(root, ...rel.split('/')), reportMarkdown(s, review, install));
  for (const l of summaryLines(s, review, rel)) out(l);
  return 0;
}

function installFor(s: ScanResult, r: Resolved, dir: string, exec: Exec): string[] {
  const info = installInfo(dir, r);
  // A marketplace named in the item's own marketplace.json may clash with an installed one; name@market is the installed one.
  const taken = info.market && info.market !== r.market ? clash(info.market, info.marketRepo ?? s.repo, exec) : null;
  return installLines(s, info, headAhead(r, exec), taken);
}

function clash(market: string, repo: string, exec: Exec): string | null | undefined {
  const list = marketList(exec);
  if (typeof list === 'string') return undefined;
  const m = list.find((x) => x.name === market);
  if (!m) return null;
  const mr = marketRepoOf(m);
  return typeof mr !== 'string' ? 'not a GitHub repo' : mr.toLowerCase() === repo.toLowerCase() ? null : mr;
}

function headAhead(r: Resolved, exec: Exec): number | null {
  // For name@market, r.ref is the pinned sha, so HEAD is the repo's default branch.
  if (!r.market && r.ref) return aheadBy(r, exec);
  const d = exec('gh', ['api', `repos/${r.repo}`, '--jq', '.default_branch']);
  const ref = d.stdout.trim();
  return d.status === 0 && safe(ref) ? aheadBy({ ...r, ref }, exec) : null;
}

/** scan.json comes back from the agent: every field used later is checked first. */
function readScan(file: string): { s: ScanResult; t: Target } | null {
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!isObj(v)) return null;
  const { target, repo, sha, path, findings, context, dir } = v;
  const fine = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) && typeof repo === 'string' && REPO.test(repo)
    && typeof path === 'string' && (path === '' || safe(path)) && typeof target === 'string'
    && (dir === undefined || (typeof dir === 'string' && isVetTmp(dir)))
    && isObj(context) && Number.isFinite(context.tokens) && Array.isArray(context.unmeasured) && context.unmeasured.every((x) => typeof x === 'string')
    && Array.isArray(findings) && findings.every((x) => isObj(x) && ['high', 'medium', 'low'].includes(x.severity as string) && typeof x.rule === 'string' && /^[a-z-]+$/.test(x.rule)
      && typeof x.file === 'string' && Number.isInteger(x.line) && typeof x.text === 'string');
  const t = fine ? parseTarget(target as string) : null;
  return t && !('error' in t) ? { s: v as unknown as ScanResult, t } : null;
}

/** The Resolved a scan came from, as far as the report name and install text need it. */
const rebuilt = (s: ScanResult, t: Target): Resolved =>
  t.kind === 'plugin' ? { repo: s.repo, sha: s.sha, path: s.path, ref: s.sha, name: t.name, market: t.market } : { repo: s.repo, sha: s.sha, path: s.path, ref: t.ref ?? '' };

function finish(scanFile: string, reviewFile: string, root: string, out: Out, exec: Exec): number {
  const v = readScan(scanFile);
  if (!v || typeof v.s.dir !== 'string') return out(NOT_SCAN), 2;
  let text: string;
  try { text = readFileSync(reviewFile, 'utf8'); } catch (e) { return out(`vet-review: could not read "${esc(reviewFile)}" (${(e as NodeJS.ErrnoException).code ?? 'error'})`), 2; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return out('vet-review: not valid JSON'), 2; }
  const res = validateVetReview(raw, v.s, installedIds(root));
  if (!res.ok) { for (const e of res.errors) out(e); return 2; }
  const r = rebuilt(v.s, v.t);
  if (r.market) {
    const list = marketList(exec);
    const mr = typeof list === 'string' ? undefined : marketRepoOf(list.find((x) => x.name === r.market) ?? {});
    if (typeof mr === 'string' && REPO.test(mr)) r.marketRepo = mr;
  }
  const code = report(root, out, v.s, r, res.review, installFor(v.s, r, v.s.dir, exec));
  cleanTmp(v.s.dir); // only once the report is written
  return code;
}

function install(scanFile: string, root: string, out: Out): number {
  const v = readScan(scanFile);
  if (!v) return out(NOT_SCAN), 2;
  const id = vetId(rebuilt(v.s, v.t));
  const none = () => (out(`No report for ${id}-${v.s.sha.slice(0, 7)}. Run harness vet first.`), 1);
  let md: string;
  try { md = readFileSync(join(root, '.harness', 'vet', `${id}-${v.s.sha}.md`), 'utf8'); } catch { return none(); }
  const lines = md.split('\n');
  const i = lines.lastIndexOf('## Install'), fence = lines[i + 2] ?? '';
  const end = lines.indexOf(fence, i + 3);
  if (i < 0 || !fence.startsWith('```') || end < 0) return none();
  for (const l of lines.slice(i + 3, end)) out(CONTROL.test(l) ? esc(l) : l); // the report is a file in the repo: print it as data
  return 0;
}
