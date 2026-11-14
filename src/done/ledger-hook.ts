// Writes the evidence ledger after a Bash or PowerShell call (spec §4.2). Not failClosed: a throw only warns (and is logged
// as `done ledger-failed`), and the evidence is simply missing (§7), so verify re-runs the check. A row is never written with
// a guessed tree or exit.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { toolFailed } from '../checks/decisions-stop.js';
import { newestFresh, readResults, resultsDir } from '../checks/tdd/results.js';
import { esc, isObj } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { redactSecrets } from '../core/secrets.js';
import type { Check, Ctx } from '../hooks/check.js';
import { warn } from '../hooks/event-log.js';
import { checkArgvs, harnessArgs, isTestRunner, plainArgv } from './commands.js';
import { activeTaskId, type Contract, loadContract, TASKS_DIR } from './contract.js';
import { appendRow, freshEvidence, readLedger, sameArgv } from './ledger.js';
import { treeHash } from './tree.js';

const ALLOW = { kind: 'allow' } as const;
const RESULTS_SLACK_MS = 2000; // a reporter's file can land just before the tool call's clock starts
const MAX_REASON = 200;

/** The call's exit: PostToolUseFailure's `Exit code N` line, or PostToolUse's response. Unknown is null, never a pass (F4). */
function exitOf(ctx: Ctx): number | null {
  const { input } = ctx;
  if (input.hook_event_name === 'PostToolUseFailure') {
    const m = typeof input.error === 'string' ? /^Exit code (\d+)/.exec(input.error) : null;
    return m && Number(m[1]) !== 0 ? Number(m[1]) : null; // a failure that says exit 0 contradicts itself
  }
  const res = isObj(input.tool_response) ? input.tool_response : {};
  const code = res.exitCode ?? res.exit_code;
  if (('exitCode' in res || 'exit_code' in res) && typeof code !== 'number') return null;
  if (toolFailed(res)) return typeof code === 'number' && code !== 0 ? code : null;
  // A numeric exit code, or Bash's own output object (interrupted: false), is the success signal. PowerShell's shape is
  // unverified, so it says nothing until a live Windows check.
  return typeof code === 'number' ? code : input.tool_name === 'Bash' && res.interrupted === false ? 0 : null;
}

/** Test criteria whose test passed in a results file written during this call; none when the call's duration is unknown. */
function passedTests(ctx: Ctx, c: Contract): string[] {
  const ms = ctx.input.duration_ms;
  const tests = c.criteria.filter((cr) => 'test' in cr.check);
  if (typeof ms !== 'number' || !tests.length) return [];
  const now = Date.now();
  // A file dated in the future would stay "fresh" for every later run and win over this run's own results.
  const newest = newestFresh(readResults(ctx.root, resultsDir(ctx.root, ctx.config)).filter((r) => r.writtenAt <= now), now - ms - RESULTS_SLACK_MS);
  return tests.filter((cr) => {
    const t = (cr.check as { test: string }).test, i = t.indexOf('::');
    return newest.get(t.slice(0, i))?.tests.some((x) => x.fullName === t.slice(i + 2) && x.status === 'passed');
  }).map((cr) => cr.id);
}

/** The run commands of the active task file as it is on disk, unverified: only to skip a call that matches nothing cheaply. */
function looseRunArgvs(root: string, env: NodeJS.ProcessEnv): string[][] {
  try {
    const id = activeTaskId(root, env);
    const raw: unknown = id === null ? null : JSON.parse(readFileSync(join(root, TASKS_DIR, `${id}.json`), 'utf8'));
    const criteria = isObj(raw) && Array.isArray(raw.criteria) ? raw.criteria : [];
    return criteria.map((cr) => (isObj(cr) && isObj(cr.check) && typeof cr.check.run === 'string' ? plainArgv(cr.check.run) : null)).filter((a): a is string[] => a !== null);
  } catch {
    return []; // unreadable here: the verified load decides, and only after another match
  }
}

const atRoot = (cwd: string | undefined, root: string): boolean => {
  try {
    return !!cwd && realpathSync(cwd) === realpathSync(root);
  } catch {
    return false;
  }
};

/** Writes the row for a matched call, gated by the verified contract. */
function record(ctx: Ctx, command: string, argv: string[], reason: string | null, steps: Map<string, string[]>): void {
  const { input, root } = ctx;
  const id = activeTaskId(root, ctx.env); // an invalid HARNESS_TASK throws
  if (id === null) return;
  const loaded = loadContract(root, id);
  if ('error' in loaded) throw new Error(loaded.error);
  const c = loaded.contract;
  const exit = exitOf(ctx);
  const ts = new Date().toISOString(), session = input.session_id, contract = c.sha256!;
  const argvOf = (n: string) => steps.get(n) ?? null;
  if (reason !== null) {
    if (exit !== 0) return; // the CLI refused it
    const tree = treeHash(root);
    const failing = freshEvidence(c, readLedger(root), tree, argvOf).gaps.filter((g) => g.kind === 'criterion').map((g) => g.id);
    const r = redactSecrets(reason);
    appendRow(root, { kind: 'blocked', ts, session, task: c.id, reason: r.slice(0, MAX_REASON), failing_criteria: failing, tree, contract });
    appendEvent(root, { ts, session, check: 'done', decision: 'task-blocked', reason: esc(r).slice(0, MAX_REASON) });
    return;
  }
  const runs = c.criteria.filter((cr) => 'run' in cr.check && sameArgv(plainArgv(cr.check.run), argv));
  if (!runs.length && !c.checks.some((n) => sameArgv(argvOf(n), argv)) && !isTestRunner(argv)) return;
  const tree = treeHash(root); // about 80 ms on 500 files, so only for a matched command; a git problem throws
  const criteria = [...runs.filter((cr) => exit === (cr.check as { expect_exit: number }).expect_exit).map((cr) => cr.id), ...passedTests(ctx, c)];
  appendRow(root, { kind: 'run', ts, session, command, exit, tree, contract, criteria });
}

export const evidenceLedger: Check = {
  name: 'evidence-ledger',
  events: ['PostToolUse', 'PostToolUseFailure'],
  run(ctx) {
    const { input, root, config } = ctx;
    const command = input.tool_input?.command;
    if (!config.checks.done || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') || input.tool_input?.run_in_background === true || typeof command !== 'string') return ALLOW;
    // A run from another folder runs that folder's scripts (a workdir package.json too), not the repo's checks (C1).
    if (!atRoot(input.cwd, root)) return ALLOW;
    const argv = plainArgv(command);
    if (!argv) return ALLOW;
    const args = harnessArgs(command);
    const reason = args?.length === 3 && args[0] === 'done' && args[1] === '--blocked' && args[2]!.trim() ? args[2]! : null;
    const steps = checkArgvs(root, config);
    // Match before any contract load, so a call that matches nothing costs no git call and prints nothing.
    const matched = reason !== null || isTestRunner(argv) || [...steps.values()].some((a) => sameArgv(a, argv)) || looseRunArgvs(root, ctx.env).some((a) => sameArgv(a, argv));
    if (!matched) return ALLOW;
    try {
      record(ctx, command, argv, reason, steps);
    } catch (e) {
      try {
        appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check: 'done', decision: 'ledger-failed', reason: esc(redactSecrets(String((e as Error)?.message ?? e))).slice(0, MAX_REASON) });
      } catch (le) {
        warn('ledger-failed event', le);
      }
      throw e;
    }
    return ALLOW;
  },
};
