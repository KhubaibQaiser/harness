// Stop gate: run the repo's own steps before the agent may finish. Ported from fitness-app stop-check.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { appendEvent } from '../../core/events.js';
import { appendTiming } from '../../core/timing.js';
import { decisionNotes } from '../decisions-stop.js';
import type { Check, Ctx } from '../../hooks/dispatch.js';
import type { Decision } from '../../hooks/types.js';
import { coverageGate } from './coverage-gate.js';
import { findOnPath, resolveStep, scriptsOf, winCmdLine } from './runner.js';
import { realish } from '../../core/paths.js';
import { type PlanStep, type RunSteps, runUnwrapped } from './steps.js';
import { realSrtProbe, type SrtProbe } from './srt.js';
import { tokenBase } from '../../core/token-base.js';
import { runWrapped } from './wrap.js';
import { SAFE_DIFF, SAFE_GIT } from '../../core/git-safe.js';

export type ExecResult = { status: number | null; output: string; timedOut: boolean; stdout?: string; stderr?: string; stderrRolled?: boolean };
export type Exec = (cmd: string, args: string[], timeoutMs: number, input?: string) => ExecResult | Promise<ExecResult>;

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

export const defaultExec = (root: string): Exec => (cmd, args, timeout, input) =>
  new Promise((resolve) => {
    // Node won't spawn .cmd/.bat directly (CVE-2024-27980), so run them through cmd.exe with a pre-quoted line.
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const c = shim
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', winCmdLine(cmd, args)], { cwd: root, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true })
      : spawn(cmd, args, { cwd: root, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    let rolled = false; // the stderr tail dropped bytes
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    const finish = (status: number | null, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      c.stdout?.destroy();
      c.stderr?.destroy();
      resolve({ status, output: `${out}\n${err}${extra}`, timedOut, stdout: out, stderr: err, stderrRolled: rolled });
    };
    if (input !== undefined) {
      if (!c.stdin) return finish(null, '\nspawn has no stdin for the input');
      c.stdin.on('error', () => {}); // a child that exits first shows in its status and output
      c.stdin.end(input);
    }
    c.stdout?.on('data', (d) => (out = (out + d).slice(-KEEP)));
    c.stderr?.on('data', (d) => {
      err += d;
      if (err.length > KEEP) [rolled, err] = [true, err.slice(-KEEP)];
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (c.pid) killTree(c.pid);
      grace = setTimeout(() => finish(null), GRACE_MS);
    }, timeout);
    c.on('error', (e) => finish(null, `\n${e.message}`));
    c.on('close', (status) => finish(status));
  });

export const tail = (text: string) => {
  const t = text.replace(/\s+$/u, '');
  return t.length <= MAX_LOG ? t : `…(truncated)\n${t.slice(-MAX_LOG)}`;
};

const realWhich = (cmd: string) => (/[\\/]/.test(cmd) ? cmd : findOnPath(cmd, process.env, process.platform));

export async function runStop(ctx: Ctx, exec: Exec, now: () => number = Date.now, which: (cmd: string) => string | null = realWhich, run: RunSteps | NotedRun): Promise<Decision> {
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
  const git = await exec('git', [...SAFE_GIT, 'status', '--porcelain', '-z'], GIT_MS);
  const changed = ok(git) ? paths(git.output, true) : [];
  let failed = !ok(git);
  const base = ctx.state.baseHead;
  if (base) {
    // The agent may have committed its work, leaving a clean tree.
    const d = await exec('git', [...SAFE_GIT, 'diff', ...SAFE_DIFF, '--name-only', '-z', base, 'HEAD'], GIT_MS);
    if (ok(d)) changed.push(...paths(d.output, false));
    else failed = true;
  }
  if (failed) {
    // Not a repo at all: note it once per session (steps still run). A failure inside a repo is logged every Stop.
    if (!ok(git) && !ok(await exec('git', [...SAFE_GIT, 'rev-parse', '--is-inside-work-tree'], GIT_MS))) {
      if (!ctx.state.stopNoGitLogged) {
        log('stop-no-git');
        ctx.save({ ...ctx.state, stopNoGitLogged: true });
      }
    } else log('stop-diff-failed', ok(git) ? undefined : 'git status failed');
    changed.push('(unknown)'); // fail closed: treat as code changed
  }
  const scripts = scriptsOf(root);
  const runNotes: string[] = []; // lines the runner wants shown (unwrapped, or a refused sandbox: off)
  const stepsStart = now(); // the step budget starts after the git calls
  // Every failure path shares one attempt counter: block, or give up and allow once max is exceeded.
  const failStep = (reason: string): Decision => {
    const attempts = ctx.state.stopAttempts + 1;
    if (attempts > max) {
      setAttempts(0);
      log('stop-gave-up');
      return done(allow);
    }
    setAttempts(attempts);
    return { kind: 'block', reason: [reason, ...runNotes].join('\n').replace('{n}', `${attempts} of ${max}`), check: 'stop' };
  };
  let ran = 0;
  // A missing tool is the user's setup, not the agent's work: skip the step and warn once per session, never block.
  // A step is marked warned (and logged) only when the warning is shown, i.e. when this Stop is not blocked.
  let resolved = 0;
  const missing: { label: string; cmd: string }[] = [];
  const done = (d: Decision): Decision => {
    const seen = ctx.state.stopToolMissing ?? [];
    const fresh = missing.filter((m) => !seen.includes(m.label));
    if (d.kind !== 'allow') return d;
    const notes = config.checks.decisions ? decisionNotes(ctx, changed) : [];
    for (const m of fresh) log('stop-tool-missing', `${m.label}: ${m.cmd}`);
    if (fresh.length) ctx.save({ ...ctx.state, stopToolMissing: [...seen, ...fresh.map((m) => m.label)] });
    const cmds = [...new Set(fresh.map((m) => m.cmd))];
    const text = cmds.map((cmd) => {
      const labels = fresh.filter((m) => m.cmd === cmd).map((m) => `\`${m.label}\``);
      const who = ran === 0 && cmds.length === 1 && labels.length === resolved ? 'Every Stop step was' : `Stop step${labels.length > 1 ? 's' : ''} ${labels.join(', ')} ${labels.length > 1 ? 'were' : 'was'}`;
      return `${who} skipped: \`${cmd}\` is not on the PATH Claude Code's hooks see (it can differ from your terminal's). Install it there, or edit stop.steps in \`.harness/config.yaml\`.`;
    });
    const all = [...text, ...runNotes, ...notes];
    return all.length ? { kind: 'context', text: all.join('\n'), check: 'stop' } : d;
  };
  // Docs-only goes through done(), so the team-decision nudge still shows (spec §8).
  if (changed.every((f) => DOCS_ONLY.test(f))) {
    setAttempts(0);
    return done(allow);
  }
  const plan: PlanStep[] = [];
  for (const step of steps) {
    const rs = resolveStep(step, pm, scripts);
    if (!rs) continue;
    resolved++;
    const found = which(rs.cmd);
    if (!found) {
      missing.push({ label: rs.label, cmd: rs.cmd });
      continue;
    }
    // On Windows pass the resolved path so a .cmd shim can be recognised and wrapped.
    plan.push({ label: rs.label, cmd: process.platform === 'win32' ? found : rs.cmd, args: rs.args, cwd: realish(root), timeoutMs: timeout_s * 1000 });
  }
  ran = plan.length;
  if (ran === 0) {
    // Nothing ran, so there is no fresh coverage to judge: allow without the coverage gate.
    if (!ctx.state.stopNothingLogged) {
      log('stop-nothing-to-run');
      ctx.save({ ...ctx.state, stopNothingLogged: true });
    }
    setAttempts(0);
    return done(allow);
  }
  const res = await run(plan, stepsStart + timeout_s * 1000);
  runNotes.push(...((run as Partial<NotedRun>).notes ?? []));
  const timeoutText = [`Stop gate timed out after ${timeout_s}s; checks did not finish.`, ...runNotes].join('\n');
  if (res.kind === 'timeout') return { kind: 'context', text: timeoutText, check: 'stop' };
  if (res.kind === 'unavailable') {
    log('stop-srt-unavailable', res.reason);
    return failStep(`${res.message} (attempt {n})`); // counts toward max_attempts like any failing step
  }
  for (const r of res.results) {
    appendTiming(root, { ts: new Date().toISOString(), session: input.session_id, event: 'Stop', step: r.label, outcome: r.timedOut ? 'timeout' : r.status === 0 ? 'allow' : 'block', ms: Math.max(0, r.ms) });
    if (r.timedOut) return { kind: 'context', text: timeoutText, check: 'stop' };
    if (r.status !== 0) return failStep(`${r.label} failed (attempt {n}). Fix it, then finish again.\n${tail(r.output)}`);
  }

  // Diff coverage runs after every step passes.
  if (config.checks.tdd) {
    const d = await coverageGate(ctx, exec, stepsStart);
    if (d.kind === 'block') {
      const attempts = ctx.state.stopAttempts + 1; // coverage blocks share the step-failure attempt counter
      if (attempts > max) {
        setAttempts(0);
        log('stop-gave-up');
        return done(allow);
      }
      setAttempts(attempts);
    }
    if (d.kind === 'block') return { ...d, reason: [d.reason, ...runNotes].join('\n') };
    if (d.kind === 'context') return { ...d, text: [d.text, ...runNotes].join('\n') };
    if (d.kind !== 'allow') return d;
  }
  setAttempts(0);
  return done(allow);
}

/** A runner that may add visible lines to the Stop's decision; `notes` is refilled on each call. */
export type NotedRun = RunSteps & { notes: string[] };
const REFUSED = 'sandbox: off was set during this session, so the Stop steps still run inside srt. Start a new session to apply it.';

/** Wrapped in srt unless native Windows, or `sandbox: off` that was already in force when the session began (R9, R10).
 *  Never chosen from an env var, file or probe; an `off` set mid-session (branch switch, pull) is refused. */
export function pickRunner(ctx: Ctx, exec: Exec, now: () => number, srt: SrtProbe = realSrtProbe(ctx.env, ctx.platform)): NotedRun {
  const log = (decision: string) => {
    try {
      appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'stop', decision });
    } catch {
      // event log is best effort
    }
  };
  const noted = (inner: RunSteps, before: (notes: string[]) => void): NotedRun => {
    const notes: string[] = [];
    const f = ((steps, deadline) => {
      notes.length = 0;
      before(notes);
      return inner(steps, deadline);
    }) as NotedRun;
    f.notes = notes;
    return f;
  };
  const off = ctx.config.sandbox === 'off';
  const honoured = off && ctx.state.sandboxBase === 'off';
  if (honoured || ctx.platform === 'win32')
    return noted(runUnwrapped(exec, now), (notes) => {
      if (honoured && !ctx.state.stopUnwrappedLogged) {
        log('stop-unwrapped');
        ctx.save({ ...ctx.state, stopUnwrappedLogged: true });
      }
      notes.push(`Stop steps ran without the sandbox (${honoured ? 'sandbox: off' : 'native Windows'}).`);
    });
  const wrapped = runWrapped({ root: ctx.root, stop: ctx.config.stop, exec, now, srt, home: ctx.home, platform: ctx.platform, env: ctx.env, tokenBase: () => tokenBase(ctx.platform, ctx.env), node: process.execPath });
  return noted(wrapped, (notes) => {
    if (off && !ctx.state.stopOffRefusedLogged) {
      log('stop-unwrapped-refused');
      ctx.save({ ...ctx.state, stopOffRefusedLogged: true });
      notes.push(REFUSED);
    }
  });
}

export const stopGate: Check = {
  name: 'stopGate',
  events: ['Stop'],
  run: (ctx) => (ctx.config.checks.stop ? (() => { const exec = defaultExec(ctx.root); return runStop(ctx, exec, Date.now, realWhich, pickRunner(ctx, exec, Date.now)); })() : allow),
};
