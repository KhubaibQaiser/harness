import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appendEvent } from '../core/events.js';
import { GUARDED, type GuardedView, guardedView, readGuarded, readRepoSnapshot, settingsBlocks, settingsFingerprint } from '../core/harness-files.js';
import { type Layer, readManagedLayers } from '../core/settings-layers.js';
import { ownedFrom, weakened } from '../core/settings-weaken.js';
import type { Check } from '../hooks/dispatch.js';

// Source values from the hooks reference (ConfigChange input). policy_settings can't be blocked, and skills aren't guarded.
const SOURCES: Record<string, 'user' | 'project' | 'local'> = { user_settings: 'user', project_settings: 'project', local_settings: 'local' };

// `~` expanded like preset does; the native realpath canonicalizes case on macOS and Windows. A missing file resolves as is.
const real = (p: string, home: string): string => {
  const abs = resolve(p.replace(/^~(?=[\\/]|$)/, home));
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
};

// Every settings layer, highest precedence first, as sandbox-required reads them: managed from disk, then the views given.
const layers = (managed: string, before: Record<string, GuardedView>, after: Record<string, GuardedView>) => {
  const stack = (v: Record<string, GuardedView>): Layer[] => [...readManagedLayers(managed), ...(['local', 'project', 'user'] as const).map((name) => ({ name, json: v[name] ?? null }))];
  return { base: stack(before), cur: stack(after) };
};

// Spec 3.3 (D6, C5), narrowed by plan ruling R11 (CC7): a mid-session change that weakens harness (settings-weaken.ts) is
// not applied to the running session, measured against the guarded views at the session's first other hook (plan ruling
// 4). Any other change applies live. Claude Code shows nothing for a blocked change (hooks reference, ConfigChange), so the
// next prompt's notice is the only signal.
export const configChange: Check = {
  name: 'config-change',
  events: ['ConfigChange'],
  failClosed: true,
  run(ctx) {
    const key = SOURCES[String(ctx.input.source)];
    if (!key) return { kind: 'allow' };
    const user = GUARDED.user(ctx.home, ctx.env);
    const rel = key !== 'user' ? GUARDED[key] : user === join(ctx.home, '.claude', 'settings.json') ? '~/.claude/settings.json' : user;
    const base = ctx.state?.guardedBase;
    // With a baseline, what harness owns is what the manifest said at its start, plus records added since; a manifest
    // that is now unreadable or lost a record blocks, as before CC7 (review M1). A state without the snapshot uses live.
    const live = settingsBlocks(ctx.root);
    const snap = base && ctx.state?.guardedOwned !== undefined ? ctx.state.guardedOwned : live;
    const has = (list: unknown[] | null, b: unknown) => !!list?.some((x) => isDeepStrictEqual(x, b));
    const lost = !!snap && snap.some((b) => !has(live, b));
    const owned = ownedFrom(snap && [...snap, ...(live ?? []).filter((b) => !has(snap, b))]);
    const deny = owned.deny;
    let text: string | null = null;
    let cur: GuardedView = null;
    try {
      text = readGuarded(key === 'user' ? user : join(ctx.root, rel));
      cur = guardedView(text, deny);
    } catch {} // unreadable: cur stays null
    // The file Claude Code reports is not the one harness watches (say CLAUDE_CONFIG_DIR, stripped by the env scrub,
    // with no mirror): harness can't judge it, so it is blocked rather than passed on an unchanged file's diff.
    const reported = key === 'user' && typeof ctx.input.file_path === 'string' && ctx.input.file_path ? ctx.input.file_path : undefined;
    const elsewhere = reported !== undefined && real(reported, ctx.home) !== real(user, ctx.home);
    const parts = elsewhere
      ? [`not the watched \`${rel}\`: launch with HARNESS_CLAUDE_CONFIG_DIR set`]
      : base ? [...weakened(base[key] ?? null, cur, owned, layers(ctx.managed, base, { ...base, ...ctx.state?.guardedApplied, [key]: cur })), ...(lost ? ['harness manifest unreadable or missing records'] : [])]
      // No baseline: the project file against the manifest's records, the others against an empty file.
      : deny ? weakened(key === 'project' ? undefined : guardedView('{}', deny), cur, owned) : ['no session baseline'];
    if (!parts.length) {
      if (base) ctx.save({ ...ctx.state, guardedApplied: { ...ctx.state?.guardedApplied, [key]: cur } }); // Claude Code applies it
      return { kind: 'allow' };
    }
    if (base && rel === GUARDED.project && cur) {
      // A change the harness CLI recorded (init, update, uninstall) is allowed, and becomes this file's baseline. Only the
      // project file: the CLI never writes the others, so a record of them would cover a script's earlier change.
      // A file missing from the record never counts as recorded; null records the file as absent. Only a CLI run
      // during this session counts: an older record would let a script restore the CLI's state over a later edit.
      const cli = readRepoSnapshot(ctx.root).cli;
      const settings = cli?.id && cli.id !== ctx.state?.guardedCli ? cli.settings : undefined;
      if (settings && rel in settings && settings[rel] === (text === null ? null : settingsFingerprint(text, deny))) {
        // The record is used up once accepted; the manifest the CLI left is now what harness owns.
        ctx.save({ ...ctx.state, guardedBase: { ...base, [key]: cur }, guardedCli: cli!.id, guardedOwned: live, guardedApplied: { ...ctx.state?.guardedApplied, [key]: cur } });
        return { kind: 'allow' };
      }
    }
    const list = parts.join(', ');
    const shown = elsewhere ? reported : rel;
    try {
      appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'config-change', decision: 'config-change-blocked', reason: `${shown}: ${list}` });
    } catch {} // the block stands without the log
    const notice = `Harness blocked a change to \`${shown}\` (${list}): the whole file change was held for this session, not only those parts. The file is still changed on disk, so the next session loads it: review it first.`;
    const pending = ctx.state?.pendingNotice;
    if (ctx.state) ctx.save({ ...ctx.state, pendingNotice: pending?.split('\n').includes(notice) ? pending : [pending, notice].filter(Boolean).join('\n') });
    return {
      kind: 'block',
      check: 'config-change',
      reason: `Harness keeps its own hooks, deny rules, sandbox keys and hook-steering \`env\` keys as they were when this session started, and disableAllHooks off, so this change to \`${shown}\` (${list}) is not applied to the session. Ask the person to make this change outside the session.`,
    };
  },
};
