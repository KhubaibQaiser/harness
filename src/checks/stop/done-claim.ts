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
    const setAttempts = (n: number) => {
      if ((ctx.state.doneClaimAttempts ?? 0) !== n) ctx.save({ ...ctx.state, doneClaimAttempts: n });
    };
    const claim = findClaim(lastAssistant(ctx).text); // the text itself is never stored or logged
    if (!claim) return ALLOW;
    try {
      const id = activeTaskId(root, ctx.env);
      if (id === null) return ALLOW;
      // Fail closed means logged, not blocked: harness's own error must not trap the agent at Stop, but it is never silent.
      const loaded = loadContract(root, id);
      if ('error' in loaded) return log('done-claim-unchecked', `contract: ${loaded.error}`), ALLOW;
      const c = loaded.contract;
      let tree: string;
      try {
        tree = treeHash(root);
      } catch (e) {
        return log('done-claim-unchecked', `tree hash: ${(e as Error).message}`), ALLOW;
      }
      const rows = readLedger(root);
      if (latestBlocked(rows, c, tree)) return ALLOW;
      const steps = checkArgvs(root, config);
      const { gaps } = freshEvidence(c, rows, tree, (n) => steps.get(n) ?? null);
      if (!gaps.length) {
        setAttempts(0);
        log('done-claim', claim);
        return ALLOW;
      }
      const attempts = (ctx.state.doneClaimAttempts ?? 0) + 1, max = config.stop.max_attempts;
      const ids = gaps.map((g) => g.id).join(', ');
      if (attempts > max) {
        setAttempts(0);
        log('false-done-gave-up', `"${claim}": ${ids}`);
        return ALLOW;
      }
      ctx.save({ ...ctx.state, doneClaimAttempts: attempts });
      log('false-done-claim', `"${claim}": ${ids}`);
      const lines = gaps.map((g) => `You said "${claim}", but ${g.kind === 'check' ? g.id : g.label} has not passed since your last edit (${g.kind === 'check' ? 'required check' : `criterion ${g.id}`}). Run it, or end with harness done --blocked "<reason>".`);
      return { kind: 'block', reason: [...lines, `(attempt ${attempts} of ${max})`].join('\n'), check: 'done' };
    } catch (e) {
      return log('done-claim-unchecked', String((e as Error)?.message ?? e)), ALLOW;
    }
  },
};
