import type { SandboxMode } from '../core/config.js';
import { appendEvent } from '../core/events.js';
import { type Layer, effective, readSettingsLayers } from '../core/settings-layers.js';
import { isShell } from '../hooks/edit-target.js';
import type { Check } from '../hooks/dispatch.js';
import { findOnPath } from './stop/runner.js';

const MSG = "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`.";

// Spec 3.4, in its order. Native Windows has no sandbox (D2): it runs with the text checks only.
export function sandboxVerdict(i: { mode: SandboxMode; unattended: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; layers: Layer[] }): 'allow' | 'unavailable' | 'deny' {
  if (i.mode === 'off' || !i.unattended) return 'allow';
  if (i.platform === 'win32') return 'unavailable';
  const confirmed =
    effective(i.layers, ['sandbox', 'enabled']) === true &&
    effective(i.layers, ['sandbox', 'allowUnsandboxedCommands']) === false &&
    (i.platform !== 'linux' || (!!findOnPath('bwrap', i.env, i.platform) && !!findOnPath('socat', i.env, i.platform)));
  // HARNESS_SANDBOX=1 stands for the documented `--settings` launch, which a hook can't see.
  return confirmed || i.env.HARNESS_SANDBOX === '1' ? 'allow' : 'deny';
}

export const sandboxRequired: Check = {
  name: 'sandbox-required',
  events: ['PreToolUse'],
  failClosed: true,
  run(ctx) {
    // Attended calls and non-shell tools return before any file is read.
    if (!isShell(ctx.input.tool_name) || !ctx.unattended || ctx.config.sandbox === 'off') return { kind: 'allow' };
    const verdict = sandboxVerdict({
      mode: ctx.config.sandbox, unattended: ctx.unattended, platform: ctx.platform, env: ctx.env,
      layers: ctx.platform === 'win32' ? [] : readSettingsLayers(ctx.root, ctx.home, ctx.platform, ctx.managed),
    });
    if (verdict === 'deny') return { kind: 'deny', reason: MSG, check: 'sandbox-required' };
    if (verdict === 'unavailable' && !ctx.state.sandboxUnavailableLogged) {
      appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'sandbox-required', decision: 'sandbox-unavailable' });
      ctx.save({ ...ctx.state, sandboxUnavailableLogged: true });
    }
    return { kind: 'allow' };
  },
};
