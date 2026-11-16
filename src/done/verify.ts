// `harness verify` (spec §4.4), attended: a verdict bound to HEAD and the working tree, every step failing closed.
import { rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { defaultExec as stopExec } from '../checks/stop/gate.js';
import { findOnPath } from '../checks/stop/runner.js';
import { realSrtProbe } from '../checks/stop/srt.js';
import { type RunSteps, runUnwrapped } from '../checks/stop/steps.js';
import { runWrapped } from '../checks/stop/wrap.js';
import { esc, loadConfig } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { defaultExec, type Exec, type ExecOpts } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { tokenBase } from '../core/token-base.js';
import type { CliEnv } from '../cli/index.js';
import { checkArgvs, plainArgv } from './commands.js';
import { activeTaskId, type Contract, contractHash, loadContract, TASK_ID, TASKS_DIR, validateContract } from './contract.js';
import { collectEvidence, type StopExec } from './evidence.js';
import { type BlockedRow, freshEvidence, latestBlocked, readLedger } from './ledger.js';
import { claudeModel, type ReviewModel } from './review-model.js';
import { runTaskReview, taskBasis } from './review-task.js';
import { diffTamper, isHarnessOwned } from './tamper-diff.js';
import { treeHash } from './tree.js';
import { EXIT, folderError, linkedFolder, type Outcome, recordVerdictHash, type ReviewResult, type Verdict, verdictLines, verdictPath, writeVerdict } from './verdict.js';

export const VERIFY_USAGE = 'harness verify [--task <id>]';
export interface VerifyDeps { exec?: StopExec; git?: Exec; tree?: (root: string) => string; now?: () => number; which?: (cmd: string) => string | null; runSteps?: RunSteps; model?: ReviewModel }

// The same history diffTamper reads: no replace refs, no grafts.
const GIT_ENV = { GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null/harness-no-grafts' };
const msg = (e: unknown) => String((e as Error)?.message ?? e);
export const NOT_RECORDED = "Verdict not recorded: harness verify can only record a verdict outside the agent's sandbox (run it in your own terminal).";

export async function verify(args: string[], cli: CliEnv, deps: VerifyDeps = {}): Promise<number> {
  const { root, out } = cli;
  const git = deps.git ?? defaultExec, now = deps.now ?? Date.now, tree = deps.tree ?? ((r: string) => treeHash(r));
  const platform = cli.platform ?? process.platform;
  const g = (a: string[], o: ExecOpts = {}): string => {
    const r = git('git', [...SAFE_GIT, ...a], { cwd: root, env: { ...process.env, ...GIT_ENV }, ...o });
    if (r.status !== 0 || r.missing || r.timedOut) throw new Error(`git ${a[0]} failed (${r.status}): ${esc((r.stderr ?? '').trim().split('\n')[0] ?? '')}`);
    return r.stdout.trim();
  };
  // First, before anything that can exit early: no old or planted verdict for HEAD stays trusted.
  let commit: string, id: string | null;
  try {
    commit = g(['rev-parse', '--verify', 'HEAD^{commit}']);
    // Sandbox-writable: a link here could aim the delete and the writes below at a user's folder. Checked again before each write.
    const bad = linkedFolder(root);
    if (bad) throw folderError(bad);
    rmSync(join(root, verdictPath(commit, 'all')), { force: true });
  } catch (e) {
    return out(`harness verify: ${msg(e)}`), 1;
  }
  try {
    recordVerdictHash(root, commit, null);
  } catch {
    // In the agent's sandbox the state is read-only; the record step below says so, and the file it vouched for is gone.
  }
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--task' && TASK_ID.test(args[1]!)))) return out(`Usage: ${VERIFY_USAGE}`), 2;
  const { config, errors } = loadConfig(root);
  if (errors.length) return out(`harness verify: .harness/config.yaml ${errors.join('; ')}`), 1;
  if (!config.checks.done) return out('The done contract is off (checks.done); there is nothing to verify.'), 1;
  try {
    id = args[1] ?? activeTaskId(root, cli.env);
  } catch (e) {
    return out(`harness verify: ${msg(e)}`), 1;
  }
  if (id === null) return out('No active task to verify. A person approves a contract with harness task approve, or name one with --task <id>.'), 1;

  const notes: string[] = [];
  let run = deps.runSteps;
  if (!run) {
    const exec = deps.exec ?? stopExec(root);
    const off = config.sandbox === 'off';
    if (off || platform === 'win32') (run = runUnwrapped(exec, now)), notes.push(`Stop steps ran without the sandbox (${off ? 'sandbox: off' : 'native Windows'}).`);
    else run = runWrapped({ root, stop: config.stop, exec, now, srt: realSrtProbe(cli.env, platform), home: cli.home ?? homedir(), platform, env: cli.env, tokenBase: () => tokenBase(platform, cli.env), node: process.execPath });
  }
  const which = deps.which ?? ((cmd: string) => (/[\\/]/.test(cmd) ? cmd : findOnPath(cmd, process.env, platform)));

  const reasons: string[] = [];
  let c: Contract | null = null, t = '', clean = false, base = '', tamper: string[] = [], filesOnly = false, blocked: BlockedRow | null = null;
  let ev: Pick<Verdict, 'checks' | 'criteria'> = { checks: [], criteria: [] };
  try {
    const loaded = loadContract(root, id, { git });
    if ('error' in loaded) throw new Error(loaded.error);
    c = loaded.contract;
    if (c.closed_at !== null) reasons.push(`task ${id} is closed`);
    t = tree(root);
    clean = t === g(['rev-parse', `${commit}^{tree}`]);
    try {
      base = g(['merge-base', c.base, commit]);
    } catch {
      throw new Error(`contract base ${c.base.slice(0, 7)} is not in this repo's history`);
    }
    const d = diffTamper(root, git, base, t, { ownContract: { id: c.id, sha256: c.sha256! }, namedPaths: namedPaths(c, config.stop.steps, base, g), timeoutMs: 30_000 });
    tamper = d.findings;
    // Only harness files changed, and every changed contract is a valid approved one: a person merging it is the approval (plan, point 3).
    filesOnly = d.files.length > 0 && d.files.every(isHarnessOwned) && d.files.filter((f) => f.startsWith(`${TASKS_DIR}/`)).every((f) => approvedAt(t, f, g));
    if (!filesOnly) {
      const rows = readLedger(root), argvs = checkArgvs(root, config);
      blocked = latestBlocked(rows, c, t);
      const inTree = (rel: string) => { try { return g(['cat-file', '-e', `${t}:${rel}`]), true; } catch { return false; } };
      const r = await collectEvidence(root, c, { config, reuse: freshEvidence(c, rows, t, (n) => argvs.get(n) ?? null).pass, run, which, now, platform, inTree });
      ev = { checks: r.checks, criteria: r.criteria };
      reasons.push(...r.reasons);
      if (tree(root) !== t) reasons.push('the checks changed the working tree');
    }
  } catch (e) {
    reasons.push(msg(e));
  }
  // Step 4, the review: only after everything else passed, fresh every run (never a cached or reported result).
  let review: ReviewResult | null = null;
  if (c && !filesOnly) {
    const model = c.review.model;
    if (reasons.length || tamper.length || blocked) review = { model, status: 'skipped', findings: [] };
    else {
      const rg: Exec = (cmd, a, o) => git(cmd, a, { env: { ...process.env, ...GIT_ENV }, ...o });
      try {
        review = await runTaskReview(root, taskBasis(root, rg, base, t, config.pr_size.exclude), c, {
          model: deps.model ?? claudeModel(), git: rg, evidence: JSON.stringify(ev, null, 2), maxFindings: config.review.max_findings, timeoutMs: config.done.review_timeout_s * 1000, reviewModel: model,
        });
      } catch (e) {
        review = { model, status: 'failed', error: msg(e), findings: [] };
      }
      if (review.status === 'failed') reasons.push(`review failed: ${review.error}`);
      for (const f of review.findings) if (f.severity === 'critical' && f.placement !== 'dropped') reasons.push(`review: ${esc(f.file)}:${f.line} ${esc(f.title)}`);
    }
  }
  const outcome: Outcome = filesOnly && !reasons.length ? 'harness-files-only' : tamper.length ? 'not-done' : blocked ? 'blocked' : reasons.length ? 'not-done' : 'done';
  const v: Verdict = {
    schema: 'harness-verdict/1', mode: 'attended', part: 'all', task: id, contract_sha256: c?.sha256 ?? '', commit, tree: t, clean, base, outcome, reasons, tamper, ...ev,
    person: (c?.criteria ?? []).flatMap((cr) => ('person' in cr.check ? [`${cr.id}: ${cr.check.person}`] : [])), review,
    blocked: blocked && { reason: blocked.reason, failing_criteria: blocked.failing_criteria }, created: new Date().toISOString(),
  };
  let text: string;
  try {
    text = writeVerdict(root, v);
  } catch (e) {
    return out(`harness verify: ${msg(e)}`), 1; // a harness folder became a link: nothing was written
  }
  let recorded = true, why = '';
  try {
    recordVerdictHash(root, commit, text);
  } catch (e) {
    [recorded, why] = [false, msg(e)]; // EPERM in the agent's sandbox (.harness/state is on its denyWrite), or a linked folder
  }
  for (const n of notes) out(n);
  out('--- How to verify ---');
  for (const l of verdictLines(v)) out(l);
  if (!recorded) out(`${NOT_RECORDED} (${why})`);
  const items = [...v.checks, ...v.criteria].map((x) => x.evidence?.source);
  try {
    appendEvent(root, { ts: v.created, session: 'cli', check: 'verify', decision: `verify-${outcome}`, reason: `task ${id} ${commit.slice(0, 7)} attended reused ${items.filter((s) => s === 'reused').length} re-run ${items.filter((s) => s === 're-run').length} tamper ${tamper.length} review ${review?.status ?? 'none'}` });
  } catch (e) {
    out(`harness verify: the event log could not be written: ${msg(e)}`);
  }
  return !recorded && EXIT[outcome] === 0 ? 1 : EXIT[outcome]; // an unrecorded done or harness-files-only is not trusted
}

/** Files a check or `run` criterion names by path (`bash scripts/ci.sh`), as they exist at base: a change to one is a tamper finding. */
function namedPaths(c: Contract, steps: (string | { run: string[] })[], base: string, g: (a: string[], o?: ExecOpts) => string): string[] {
  const words = [...steps.flatMap((s) => (typeof s === 'string' ? [] : s.run)), ...c.criteria.flatMap((cr) => ('run' in cr.check ? plainArgv(cr.check.run) ?? [] : []))]
    .filter((w) => w && !w.startsWith('-') && !/[\0\n]/.test(w) && !posix.isAbsolute(w)).map((w) => posix.normalize(w)).filter((w) => !w.startsWith('..'));
  const uniq = [...new Set(words)];
  if (!uniq.length) return [];
  const lines = g(['cat-file', '--batch-check'], { input: uniq.map((w) => `${base}:${w}\n`).join('') }).split('\n');
  return uniq.filter((_, i) => / blob \d+$/.test(lines[i] ?? ''));
}

/** The file at tree `t` is an approved contract whose embedded hash matches its content and name. */
function approvedAt(t: string, rel: string, g: (a: string[]) => string): boolean {
  try {
    const v = validateContract(JSON.parse(g(['cat-file', 'blob', `${t}:${rel}`])), { approved: true });
    return v.ok && v.contract.sha256 === contractHash(v.contract) && rel === `${TASKS_DIR}/${v.contract.id}.json`;
  } catch {
    return false;
  }
}
