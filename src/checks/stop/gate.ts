// Stop gate: run the repo's own steps before the agent may finish. Ported from fitness-app stop-check.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from '../../core/events.js';
import { appendTiming } from '../../core/timing.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { coverageGate } from './coverage-gate.js';
import { findOnPath, resolveStep, winCmdLine } from './runner.js';

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

const KEEP = 64 * 1024; // rolling tail per stream; the gate only shows the last MAX_LOG chars
const GRACE_MS = 2000; // after the kill, how long to wait for pipes held by escaped grandchildren

export const defaultExec = (root: string): Exec => (cmd, args, timeout) =>
  new Promise((resolve) => {
    // Node won't spawn .cmd/.bat directly (CVE-2024-27980), so run them through cmd.exe with a pre-quoted line.
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const c = shim
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winCmdLine(cmd, args)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true })
      : spawn(cmd, args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (status: number | null, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      c.stdout?.destroy();
      c.stderr?.destroy();
      resolve({ status, output: `${out}\n${err}${extra}`, timedOut });
    };
    c.stdout?.on('data', (d) => (out = (out + d).slice(-KEEP)));
    c.stderr?.on('data', (d) => (err = (err + d).slice(-KEEP)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (c.pid) killTree(c.pid);
      grace = setTimeout(() => finish(null), GRACE_MS);
    }, timeout);
    c.on('error', (e) => finish(null, `\n${e.message}`));
    c.on('close', (status) => finish(status));
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

const realWhich = (cmd: string) => (/[\\/]/.test(cmd) ? cmd : findOnPath(cmd, process.env, process.platform));

export async function runStop(ctx: Ctx, exec: Exec, now: () => number = Date.now, which: (cmd: string) => string | null = realWhich): Promise<Decision> {
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
    // Not a repo at all: note it once per session (steps still run). A failure inside a repo is logged every Stop.
    if (!ok(git) && !ok(await exec('git', ['rev-parse', '--is-inside-work-tree'], GIT_MS))) {
      if (!ctx.state.stopNoGitLogged) {
        log('stop-no-git');
        ctx.save({ ...ctx.state, stopNoGitLogged: true });
      }
    } else log('stop-diff-failed', ok(git) ? undefined : 'git status failed');
    changed.push('(unknown)'); // fail closed: treat as code changed
  }
  if (changed.every((f) => DOCS_ONLY.test(f))) {
    setAttempts(0);
    return allow;
  }

  const scripts = scriptsOf(root);
  const stepsStart = now(); // the step budget starts after the git calls
  // Every failure path shares one attempt counter: block, or give up and allow once max is exceeded.
  const failStep = (reason: string): Decision => {
    const attempts = ctx.state.stopAttempts + 1;
    if (attempts > max) {
      setAttempts(0);
      log('stop-gave-up');
      return allow;
    }
    setAttempts(attempts);
    return { kind: 'block', reason: reason.replace('{n}', `${attempts} of ${max}`), check: 'stop' };
  };
  let ran = 0;
  // A missing tool is the user's setup, not the agent's work: skip the step and warn once per session, never block.
  // A step is marked warned (and logged) only when the warning is shown, i.e. when this Stop is not blocked.
  let resolved = 0;
  const missing: { label: string; cmd: string }[] = [];
  const done = (d: Decision): Decision => {
    const seen = ctx.state.stopToolMissing ?? [];
    const fresh = missing.filter((m) => !seen.includes(m.label));
    if (d.kind !== 'allow' || !fresh.length) return d;
    for (const m of fresh) log('stop-tool-missing', `${m.label}: ${m.cmd}`);
    ctx.save({ ...ctx.state, stopToolMissing: [...seen, ...fresh.map((m) => m.label)] });
    const cmds = [...new Set(fresh.map((m) => m.cmd))];
    const text = cmds.map((cmd) => {
      const labels = fresh.filter((m) => m.cmd === cmd).map((m) => `\`${m.label}\``);
      const who = ran === 0 && cmds.length === 1 && labels.length === resolved ? 'Every Stop step was' : `Stop step${labels.length > 1 ? 's' : ''} ${labels.join(', ')} ${labels.length > 1 ? 'were' : 'was'}`;
      return `${who} skipped: \`${cmd}\` is not on the PATH Claude Code's hooks see (it can differ from your terminal's). Install it there, or edit stop.steps in \`.harness/config.yaml\`.`;
    });
    return { kind: 'context', text: text.join('\n'), check: 'stop' };
  };
  for (const step of steps) {
    const rs = resolveStep(step, pm, scripts);
    if (!rs) continue;
    resolved++;
    const found = which(rs.cmd);
    if (!found) {
      missing.push({ label: rs.label, cmd: rs.cmd });
      continue;
    }
    ran++;
    const remaining = timeout_s * 1000 - (now() - stepsStart);
    // On Windows pass the resolved path so a .cmd shim can be recognised and wrapped.
    const t0 = now();
    const r = remaining > 0 ? await exec(process.platform === 'win32' ? found : rs.cmd, rs.args, remaining) : null;
    appendTiming(root, { ts: new Date().toISOString(), session: input.session_id, event: 'Stop', step: rs.label, outcome: !r || r.timedOut ? 'timeout' : r.status === 0 ? 'allow' : 'block', ms: Math.max(0, now() - t0) });
    if (!r || r.timedOut) {
      return { kind: 'context', text: `Stop gate timed out after ${timeout_s}s; checks did not finish.`, check: 'stop' };
    }
    if (r.status === 0) continue;
    return failStep(`${rs.label} failed (attempt {n}). Fix it, then finish again.\n${tail(r.output)}`);
  }
  if (ran === 0) {
    // Nothing ran, so there is no fresh coverage to judge: allow without the coverage gate.
    if (!ctx.state.stopNothingLogged) {
      log('stop-nothing-to-run');
      ctx.save({ ...ctx.state, stopNothingLogged: true });
    }
    setAttempts(0);
    return done(allow);
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
  return done(allow);
}

export const stopGate: Check = {
  name: 'stopGate',
  events: ['Stop'],
  run: (ctx) => (ctx.config.checks.stop ? runStop(ctx, defaultExec(ctx.root)) : allow),
};
