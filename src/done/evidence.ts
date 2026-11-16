// Evidence for harness verify (spec §4.4 step 3): fresh ledger rows are reused, everything else runs through the Stop runner.
import type { Exec } from '../checks/stop/gate.js';
import type { PlanStep, RunSteps, StepResult } from '../checks/stop/steps.js';
import { newestFresh, readResults, resultsDir } from '../checks/tdd/results.js';
import type { HarnessConfig } from '../core/config.js';
import { realish } from '../core/paths.js';
import { checkArgvs, plainArgv } from './commands.js';
import type { Contract } from './contract.js';
import { type RunRow, sameArgv } from './ledger.js';
import type { Evidence, Verdict } from './verdict.js';

export type StopExec = Exec;
export const NESTED = "harness verify can't run its checks inside another sandbox. Ask the person to run harness verify in their own terminal, or ! harness verify (outside the sandbox on macOS, and on Linux without the env scrub).";

/**
 * One plan, run in one runner call with `all` (isolation spec §4.2: one srt call per verify): checks not reused, then `run`
 * criteria, then the `test` step for the test criteria unless a `test` check is already in the plan.
 */
export async function collectEvidence(
  root: string, c: Contract,
  o: { config: HarnessConfig; reuse: Map<string, RunRow> | null; run: RunSteps; which: (cmd: string) => string | null; now: () => number; platform: NodeJS.Platform; inTree: (rel: string) => boolean },
): Promise<{ checks: Verdict['checks']; criteria: Verdict['criteria']; reasons: string[] }> {
  const { config, reuse, run, which, now, platform, inTree } = o;
  const argvs = checkArgvs(root, config);
  const timeoutMs = config.done.timeout_s * 1000;
  const reasons: string[] = [];
  const reused = (r: RunRow | undefined): Evidence | null => (r ? { command: r.command, exit: r.exit, ts: r.ts, source: 'reused', status: 'pass' } : null);
  const checks: Verdict['checks'] = c.checks.map((name) => ({ name, evidence: reused(reuse?.get(`check:${name}`)) }));
  const criteria: Verdict['criteria'] = c.criteria.map((cr) => ({
    id: cr.id, text: cr.text, kind: 'test' in cr.check ? 'test' : 'run' in cr.check ? 'run' : 'person',
    evidence: 'person' in cr.check ? null : reused(reuse?.get(`criterion:${cr.id}`)),
  }));

  const plan: PlanStep[] = [], sets: { command: string; set: (e: Evidence) => void; pass: (r: StepResult) => boolean }[] = [];
  const ev = (command: string, r: StepResult, pass: boolean): Evidence => ({ command, exit: r.status, ts: new Date().toISOString(), source: 're-run', status: r.timedOut ? 'timeout' : pass ? 'pass' : 'fail' });
  /** The step's plan index, or -1 when its tool is not on PATH (`missing`, a fail, never a skip). */
  const add = (id: string, argv: string[], set: (e: Evidence) => void, pass: (r: StepResult) => boolean): number => {
    const command = argv.join(' '), found = which(argv[0]!);
    if (!found) {
      reasons.push(`${id}: ${argv[0]} is not on PATH`);
      set({ command, exit: null, ts: new Date().toISOString(), source: 're-run', status: 'missing' });
      return -1;
    }
    plan.push({ label: id, cmd: platform === 'win32' ? found : argv[0]!, args: argv.slice(1), cwd: realish(root), timeoutMs });
    sets.push({ command, set, pass });
    return plan.length - 1;
  };
  const noStep = (ids: string, name: string) => reasons.push(`${ids}: no stop step named ${name} resolves here`);
  const testArgv = argvs.get('test') ?? null;
  let testAt = -2; // -2: no test step in the plan
  for (const ch of checks) {
    if (ch.evidence) continue;
    const argv = argvs.get(ch.name);
    if (!argv) { noStep(ch.name, ch.name); continue; }
    const i = add(ch.name, argv, (e) => (ch.evidence = e), (r) => r.status === 0);
    if (testArgv && sameArgv(argv, testArgv)) testAt = i;
  }
  for (const [i, cr] of c.criteria.entries()) {
    if (!('run' in cr.check) || criteria[i]!.evidence) continue;
    const want = cr.check.expect_exit;
    add(cr.id, plainArgv(cr.check.run)!, (e) => (criteria[i]!.evidence = e), (r) => r.status === want);
  }
  const tests = c.criteria.flatMap((cr, i) => ('test' in cr.check && !criteria[i]!.evidence ? [{ t: cr.check.test, v: criteria[i]! }] : []));
  const dir = resultsDir(root, config);
  if (tests.length && !testArgv) noStep(tests.map((x) => x.v.id).join(', '), 'test');
  else if (tests.length) {
    if (testAt === -2) testAt = add('test', testArgv!, () => {}, (r) => r.status === 0);
    if (testAt === -1) for (const x of tests) x.v.evidence = { command: testArgv!.join(' '), exit: null, ts: new Date().toISOString(), source: 're-run', status: 'missing' };
  }
  if (!plan.length) return finish();

  let results: StepResult[] = [];
  try {
    const res = await run(plan, now() + timeoutMs, { all: true }); // the whole run shares done.timeout_s
    if (res.kind === 'timeout') reasons.push(`the checks timed out after ${config.done.timeout_s}s (done.timeout_s)`);
    else if (res.kind === 'unavailable') reasons.push(res.message, NESTED);
    else if (res.results.length === plan.length && res.results.every((r, i) => r.label === plan[i]!.label)) results = res.results;
    else reasons.push("the check runner's results don't match the plan");
  } catch (e) {
    reasons.push(`the check runner failed: ${(e as Error)?.message ?? e}`);
  }
  results.forEach((r, i) => sets[i]!.set(ev(sets[i]!.command, r, sets[i]!.pass(r))));
  const tr = testAt >= 0 ? results[testAt] : undefined;
  if (tr) {
    // A test criterion passes only when the test step exited 0, a results file changed during that step (ctime, from its start's whole second,
    // since ctime can be coarse) names the test as passed, and the test file is in the verified tree. Nothing in the results folder is deleted.
    // The window starts no earlier than the previous step's end, so a file that step wrote doesn't count where ctime has milliseconds.
    const s = tr.start, prev = results[testAt - 1], from = Math.max(Math.floor((s ?? 0) / 1000) * 1000, prev?.start === undefined ? 0 : prev.start + prev.ms);
    const during = s === undefined ? [] : readResults(root, dir).filter((x) => x.changedAt !== undefined && x.changedAt >= from && x.changedAt <= s + tr.ms);
    const fresh = newestFresh(during, 0);
    for (const { t, v } of tests) v.evidence = ev(sets[testAt]!.command, tr, !tr.timedOut && tr.status === 0 && testPassed(fresh, t) && inTree(t.slice(0, t.indexOf('::'))));
  }
  return finish();

  function finish() {
    for (const [id, e] of [...checks.map((x) => [x.name, x.evidence] as const), ...criteria.filter((x) => x.kind !== 'person').map((x) => [x.id, x.evidence] as const)])
      if (e?.status !== 'pass') reasons.push(e ? `${id} did not pass (${e.status})` : `${id} was not run`);
    return { checks, criteria, reasons };
  }
}

/** `<file>::<full test name>` passed in these results. */
function testPassed(newest: Map<string, { tests: { fullName: string; status: string }[] }>, t: string): boolean {
  const i = t.indexOf('::');
  return !!newest.get(t.slice(0, i))?.tests.some((x) => x.fullName === t.slice(i + 2) && x.status === 'passed');
}
