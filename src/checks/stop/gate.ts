// Stop gate: run the repo's own steps before the agent may finish. Ported from fitness-app stop-check.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from '../../core/events.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { coverageGate } from './coverage-gate.js';

export type Exec = (cmd: string, args: string[], timeoutMs: number) => { status: number | null; output: string; timedOut: boolean };

const DOCS_ONLY = /\.(md|mdx|txt)$|^docs\/|^LICENSE$/;
const MAX_LOG = 3500;
const allow: Decision = { kind: 'allow' };

export const defaultExec = (root: string): Exec => (cmd, args, timeout) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, timedOut };
};

const tail = (text: string) => {
  const t = text.replace(/\s+$/u, '');
  return t.length <= MAX_LOG ? t : `…(truncated)\n${t.slice(-MAX_LOG)}`;
};

const scriptsOf = (root: string): Record<string, unknown> => {
  try {
    const f = join(root, 'package.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).scripts ?? {}) : {};
  } catch {
    return {};
  }
};

export function runStop(ctx: Ctx, exec: Exec, now: () => number = Date.now): Decision {
  const { root, config, input } = ctx;
  const { steps, package_manager: pm, max_attempts: max, timeout_s } = config.stop;
  const start = now();
  const log = (decision: string, reason?: string) => {
    try {
      appendEvent(root, { ts: new Date().toISOString(), session: input.session_id, check: 'stop', decision, ...(reason ? { reason } : {}) });
    } catch {
      // event log is best effort
    }
  };
  const setAttempts = (n: number) => {
    if (ctx.state.stopAttempts !== n) ctx.save({ ...ctx.state, stopAttempts: n });
  };

  const git = exec('git', ['status', '--porcelain'], timeout_s * 1000);
  const changed = git.status === 0 ? git.output.split('\n').filter(Boolean).map((l) => (l.slice(3).split(' -> ').pop() as string).replace(/^"|"$/g, '')) : [];
  if (changed.every((f) => DOCS_ONLY.test(f))) {
    setAttempts(0);
    return allow;
  }

  const scripts = scriptsOf(root);
  for (const step of steps.filter((s) => s in scripts)) {
    const remaining = timeout_s * 1000 - (now() - start);
    const r = remaining > 0 ? exec(pm, ['run', step], remaining) : null;
    if (!r || r.timedOut) {
      log('stop-timeout');
      return { kind: 'context', text: `Stop gate timed out after ${timeout_s}s; checks did not finish.`, check: 'stop' };
    }
    if (r.status === 0) continue;
    const attempts = ctx.state.stopAttempts + 1;
    if (attempts > max) {
      setAttempts(0);
      log('stop-gave-up');
      return allow;
    }
    setAttempts(attempts);
    log('stop-block', `${step} attempt ${attempts} of ${max}; stop_hook_active=${input.stop_hook_active === true}`);
    return { kind: 'block', reason: `${step} failed (attempt ${attempts} of ${max}). Fix it, then finish again.\n${tail(r.output)}`, check: 'stop' };
  }

  // Task 15 hook point: diff coverage runs after every step passes.
  if (config.checks.tdd) {
    const d = coverageGate(ctx, exec);
    if (d.kind !== 'allow') return d;
  }
  setAttempts(0);
  return allow;
}

export const stopGate: Check = {
  name: 'stopGate',
  events: ['Stop'],
  run: (ctx) => (ctx.config.checks.stop ? runStop(ctx, defaultExec(ctx.root)) : allow),
};
