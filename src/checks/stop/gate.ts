// Stop gate: run the repo's own steps before the agent may finish. Ported from fitness-app stop-check.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from '../../core/events.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { coverageGate } from './coverage-gate.js';

export type ExecResult = { status: number | null; output: string; timedOut: boolean };
export type Exec = (cmd: string, args: string[], timeoutMs: number) => ExecResult | Promise<ExecResult>;

const DOCS_ONLY = /\.(md|mdx|txt)$|^docs\/|^LICENSE$/;
const MAX_LOG = 3500;
const GIT_MS = 5000;
const allow: Decision = { kind: 'allow' };

const realKill = {
  kill: (pid: number, sig: NodeJS.Signals) => process.kill(pid, sig),
  taskkill: (pid: number) => void spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }),
};

// POSIX: SIGKILL the whole process group (the child is its leader); Windows: taskkill the tree. Seam is for tests.
export function killTree(pid: number, platform: string = process.platform, run: typeof realKill = realKill): void {
  try {
    if (platform === 'win32') run.taskkill(pid);
    else run.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export const defaultExec = (root: string): Exec => (cmd, args, timeout) =>
  new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      timedOut = true;
      if (c.pid) killTree(c.pid);
    }, timeout);
    c.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: null, output: `${out}\n${err}\n${e.message}`, timedOut });
    });
    c.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output: `${out}\n${err}`, timedOut });
    });
  });

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

export async function runStop(ctx: Ctx, exec: Exec, now: () => number = Date.now): Promise<Decision> {
  const { root, config, input } = ctx;
  const { steps, package_manager: pm, max_attempts: max, timeout_s } = config.stop;
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

  // NUL-separated; with porcelain -z a rename/copy entry is "XY new" then a separate "old" field, which we skip.
  const paths = (out: string, porcelain: boolean) => {
    const res: string[] = [];
    const f = out.split('\0');
    for (let i = 0; i < f.length; i++) {
      if (!f[i]) continue;
      res.push(porcelain ? f[i].slice(3) : f[i]);
      if (porcelain && /[RC]/.test(f[i].slice(0, 2))) i++;
    }
    return res;
  };
  const ok = (r: { status: number | null; timedOut: boolean }) => r.status === 0 && !r.timedOut;
  const git = await exec('git', ['status', '--porcelain', '-z'], GIT_MS);
  const changed = ok(git) ? paths(git.output, true) : [];
  let failed = !ok(git);
  const base = ctx.state.baseHead;
  if (base) {
    // The agent may have committed its work, leaving a clean tree.
    const d = await exec('git', ['diff', '--name-only', '-z', base, 'HEAD'], GIT_MS);
    if (ok(d)) changed.push(...paths(d.output, false));
    else failed = true;
  }
  if (failed) {
    if (ok(git)) log('stop-diff-failed');
    else if (!ctx.state.stopSkipLogged) {
      log('stop-skipped', 'git status failed'); // once per session: a non-git dir would otherwise log on every Stop
      ctx.save({ ...ctx.state, stopSkipLogged: true });
    }
    changed.push('(unknown)'); // fail closed: treat as code changed
  }
  if (changed.every((f) => DOCS_ONLY.test(f))) {
    setAttempts(0);
    return allow;
  }

  const scripts = scriptsOf(root);
  const stepsStart = now(); // the step budget starts after the git calls
  for (const step of steps.filter((s) => s in scripts)) {
    const remaining = timeout_s * 1000 - (now() - stepsStart);
    const r = remaining > 0 ? await exec(pm, ['run', step], remaining) : null;
    if (!r || r.timedOut) {
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
    return { kind: 'block', reason: `${step} failed (attempt ${attempts} of ${max}). Fix it, then finish again.\n${tail(r.output)}`, check: 'stop' };
  }

  // Diff coverage runs after every step passes.
  if (config.checks.tdd) {
    const d = await coverageGate(ctx, exec, stepsStart);
    if (d.kind === 'block') {
      const attempts = ctx.state.stopAttempts + 1; // coverage blocks share the step-failure attempt counter
      if (attempts > max) {
        setAttempts(0);
        log('stop-gave-up');
        return allow;
      }
      setAttempts(attempts);
    }
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
