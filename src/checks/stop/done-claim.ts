// The Stop claim checker (spec §4.3): a "done" claim with no fresh evidence is blocked. It never decides done; verify does.
import { esc } from '../../core/config.js';
import { appendEvent } from '../../core/events.js';
import { redactSecrets } from '../../core/secrets.js';
import { checkArgvs } from '../../done/commands.js';
import { findClaim } from '../../done/claims.js';
import { activeTaskId, loadContract } from '../../done/contract.js';
import { freshEvidence, latestBlocked, readLedger } from '../../done/ledger.js';
import { treeHash } from '../../done/tree.js';
import type { Check, Ctx } from '../../hooks/check.js';
import { lastAssistant } from '../decisions-stop.js';

const ALLOW = { kind: 'allow' } as const;

export const doneClaim: Check = {
  name: 'done',
  events: ['Stop'],
  run(ctx: Ctx) {
    const { config, root, input } = ctx;
    if (!config.checks.done) return ALLOW;
    const log = (decision: string, reason: string) => {
      try {
        appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check: 'done', decision, reason: esc(redactSecrets(reason)).slice(0, 300) });
      } catch {
        // event log is best effort
      }
    };
    const max = config.stop.max_attempts;
    const setAttempts = (n: number) => {
      if ((ctx.state.doneClaimAttempts ?? 0) !== n) ctx.save({ ...ctx.state, doneClaimAttempts: n });
    };
    // Every allow path resets, but with the Stop gate at its limit the counter stays at max: the gate allows on the next Stop, and so must this check.
    const reset = () => setAttempts(ctx.state.stopAttempts >= max ? max : 0);
    try {
      const { text, read } = lastAssistant(ctx); // the text itself is never stored or logged
      const claim = findClaim(text);
      if (!claim) {
        reset();
        if (read && !text) log('done-claim-unchecked', 'no assistant text'); // the transcript gave nothing to check
        return ALLOW;
      }
      const id = activeTaskId(root, ctx.env);
      if (id === null) return reset(), ALLOW;
      // Fail closed means logged, not blocked: harness's own error must not trap the agent at Stop, but it is never silent.
      const loaded = loadContract(root, id);
      if ('error' in loaded) return reset(), log('done-claim-unchecked', `contract: ${loaded.error}`), ALLOW;
      const c = loaded.contract;
      let tree: string;
      try {
        tree = treeHash(root);
      } catch (e) {
        return reset(), log('done-claim-unchecked', `tree hash: ${(e as Error).message}`), ALLOW;
      }
      const rows = readLedger(root);
      if (latestBlocked(rows, c, tree)) return reset(), log('done-claim', `${claim} blocked`), ALLOW;
      const steps = checkArgvs(root, config);
      const { gaps } = freshEvidence(c, rows, tree, (n) => steps.get(n) ?? null);
      if (!gaps.length) {
        reset();
        log('done-claim', claim);
        return ALLOW;
      }
      const attempts = (ctx.state.doneClaimAttempts ?? 0) + 1;
      const ids = gaps.map((g) => g.id).join(', ');
      // stopGate shares stop.max_attempts and gives up on the Stop after it reaches the limit. Giving up here at the limit, and again on
      // the next Stop (the counter is left at max, not 0), lines the two give-ups up so a Stop is allowed within max + 2 Stops of the gate's first block.
      const gateAtLimit = ctx.state.stopAttempts >= max;
      if (attempts > max || gateAtLimit) {
        setAttempts(gateAtLimit ? max : 0);
        log('false-done-gave-up', gateAtLimit ? 'stop gate at its limit' : `"${claim}": ${ids}`);
        return ALLOW;
      }
      ctx.save({ ...ctx.state, doneClaimAttempts: attempts });
      log('false-done-claim', `"${claim}": ${ids}`);
      const lines = gaps.map((g) => `You said "${claim}", but ${g.kind === 'check' ? g.id : g.label} has not passed since your last edit (${g.kind === 'check' ? 'required check' : `criterion ${g.id}`}). Run it, or end with harness done --blocked "<reason>".`);
      return { kind: 'block', reason: [...lines, `(attempt ${attempts} of ${max})`].join('\n'), check: 'done' };
    } catch (e) {
      return reset(), log('done-claim-unchecked', String((e as Error)?.message ?? e)), ALLOW;
    }
  },
};
