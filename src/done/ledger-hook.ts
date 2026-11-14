// Writes the evidence ledger after a Bash or PowerShell call (spec §4.2). Not failClosed: a throw only warns, and the
// evidence is simply missing (§7), so verify re-runs the check. A row is never written with a guessed tree or exit.
import { toolFailed } from '../checks/decisions-stop.js';
import { newestFresh, readResults, resultsDir } from '../checks/tdd/results.js';
import { esc, isObj } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { redactSecrets } from '../core/secrets.js';
import type { Check, Ctx } from '../hooks/check.js';
import { checkArgv, harnessArgs, isTestRunner, plainArgv } from './commands.js';
import { activeTaskId, type Contract, loadContract } from './contract.js';
import { appendRow, freshEvidence, readLedger, sameArgv } from './ledger.js';
import { treeHash } from './tree.js';

const ALLOW = { kind: 'allow' } as const;
const RESULTS_SLACK_MS = 2000; // a reporter's file can land just before the tool call's clock starts

/** The call's exit: PostToolUseFailure's `Exit code N` line, or PostToolUse's response. Unknown is null, never a pass (F4). */
function exitOf(ctx: Ctx): number | null {
  const { input } = ctx;
  if (input.hook_event_name === 'PostToolUseFailure') {
    const m = typeof input.error === 'string' ? /^Exit code (\d+)/.exec(input.error) : null;
    return m ? Number(m[1]) : null;
  }
  const res = isObj(input.tool_response) ? input.tool_response : {};
  const code = res.exitCode ?? res.exit_code;
  if (toolFailed(res)) return typeof code === 'number' && code !== 0 ? code : null;
  // An exit code, or Bash's own output object (interrupted: false), is the success signal; any other shape says nothing.
  return typeof code === 'number' ? code : res.interrupted === false ? 0 : null;
}

/** Test criteria whose test passed in a results file written during this call; none when the call's duration is unknown. */
function passedTests(ctx: Ctx, c: Contract): string[] {
  const ms = ctx.input.duration_ms;
  const tests = c.criteria.filter((cr) => 'test' in cr.check);
  if (typeof ms !== 'number' || !tests.length) return [];
  const newest = newestFresh(readResults(ctx.root, resultsDir(ctx.root, ctx.config)), Date.now() - ms - RESULTS_SLACK_MS);
  return tests.filter((cr) => {
    const t = (cr.check as { test: string }).test, i = t.indexOf('::');
    return newest.get(t.slice(0, i))?.tests.some((x) => x.fullName === t.slice(i + 2) && x.status === 'passed');
  }).map((cr) => cr.id);
}

export const evidenceLedger: Check = {
  name: 'evidence-ledger',
  events: ['PostToolUse', 'PostToolUseFailure'],
  run(ctx) {
    const { input, root, config } = ctx;
    const command = input.tool_input?.command;
    if (!config.checks.done || (input.tool_name !== 'Bash' && input.tool_name !== 'PowerShell') || input.tool_input?.run_in_background === true || typeof command !== 'string') return ALLOW;
    const argv = plainArgv(command);
    if (!argv) return ALLOW;
    const id = activeTaskId(root, ctx.env); // an invalid HARNESS_TASK throws: a warning, no row
    if (id === null) return ALLOW;
    const loaded = loadContract(root, id);
    if ('error' in loaded) throw new Error(loaded.error);
    const c = loaded.contract;
    const exit = exitOf(ctx);
    const ts = new Date().toISOString(), session = input.session_id, contract = c.sha256!;
    const argvOf = (n: string) => checkArgv(root, config, n);

    const args = harnessArgs(command);
    if (args?.length === 3 && args[0] === 'done' && args[1] === '--blocked') {
      if (exit !== 0) return ALLOW; // the CLI refused it
      const tree = treeHash(root);
      const failing = freshEvidence(c, readLedger(root), tree, argvOf).gaps.filter((g) => g.kind === 'criterion').map((g) => g.id);
      const reason = redactSecrets(args[2]!);
      appendRow(root, { kind: 'blocked', ts, session, task: c.id, reason, failing_criteria: failing, tree, contract });
      appendEvent(root, { ts, session, check: 'done', decision: 'task-blocked', reason: esc(reason).slice(0, 200) });
      return ALLOW;
    }

    const runs = c.criteria.filter((cr) => 'run' in cr.check && sameArgv(plainArgv(cr.check.run), argv));
    if (!runs.length && !c.checks.some((n) => sameArgv(argvOf(n), argv)) && !isTestRunner(argv)) return ALLOW;
    const tree = treeHash(root); // about 80 ms on 500 files, so only for a matched command; a git problem throws
    const criteria = [...runs.filter((cr) => exit === (cr.check as { expect_exit: number }).expect_exit).map((cr) => cr.id), ...passedTests(ctx, c)];
    appendRow(root, { kind: 'run', ts, session, command, exit, tree, contract, criteria });
    return ALLOW;
  },
};
