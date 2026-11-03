import type { SandboxMode } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { type Layer, effective, readManagedLayers } from '../core/settings-layers.js';
import { isShell } from '../hooks/edit-target.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { findOnPath } from './stop/runner.js';

const MSG = "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`.";

// Spec 3.4, in its order. Native Windows has no sandbox (D2): it runs with the text checks only.
export function sandboxVerdict(i: { mode: SandboxMode; unattended: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; layers: Layer[] }): 'allow' | 'unavailable' | 'deny' {
  if (i.mode === 'off' || !i.unattended) return 'allow';
  if (i.platform === 'win32') return 'unavailable';
  // HARNESS_SANDBOX=1 stands for the documented `--settings` launch, which a hook can't see. Checked first: it is free.
  if (i.env.HARNESS_SANDBOX === '1') return 'allow';
  const confirmed =
    effective(i.layers, ['sandbox', 'enabled']) === true &&
    effective(i.layers, ['sandbox', 'allowUnsandboxedCommands']) === false &&
    (i.platform !== 'linux' || (!!findOnPath('bwrap', i.env, i.platform) && !!findOnPath('socat', i.env, i.platform)));
  return confirmed ? 'allow' : 'deny';
}

/**
 * Managed from disk, then local, project and user from the session baseline (`guardedBase`): a settings file the agent
 * writes mid-session is not applied by Claude Code (ConfigChange blocks it), so it doesn't count here either.
 * null when there is no baseline. `--settings` sits between managed and local; a hook can't see it.
 */
function sessionLayers(ctx: Ctx): Layer[] | null {
  const base = ctx.state?.guardedBase;
  if (!base) return null;
  return [...readManagedLayers(ctx.managed), ...(['local', 'project', 'user'] as const).map((name): Layer => ({ name, json: base[name] }))];
}

export const sandboxRequired: Check = {
  name: 'sandbox-required',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    // Attended calls and non-shell tools return before any file is read.
    const mode = ctx.config?.sandbox ?? 'unattended'; // degraded (no config): still judged, not a TypeError deny
    if (!isShell(ctx.input.tool_name) || !ctx.unattended || mode === 'off') return { kind: 'allow' };
    const layers = ctx.platform === 'win32' || ctx.env.HARNESS_SANDBOX === '1' ? [] : sessionLayers(ctx);
    const verdict = layers ? sandboxVerdict({ mode, unattended: ctx.unattended, platform: ctx.platform, env: ctx.env, layers }) : 'deny';
    if (verdict === 'deny') return { kind: 'deny', reason: MSG, check: 'sandbox-required' };
    if (verdict === 'unavailable' && !ctx.state?.sandboxUnavailableLogged) {
      appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'sandbox-required', decision: 'sandbox-unavailable' });
      ctx.save({ ...ctx.state, sandboxUnavailableLogged: true });
    }
    return { kind: 'allow' };
  },
};
