import { join } from 'node:path';
import { appendEvent } from '../core/events.js';
import {
  GUARDED, type GuardedView, guardedDiff, guardedView, harnessDenyRules, readGuarded, readRepoSnapshot, settingsFingerprint,
} from '../core/harness-files.js';
import type { Check } from '../hooks/dispatch.js';

// Source values from the hooks reference (ConfigChange input). policy_settings can't be blocked, and skills aren't guarded.
const SOURCES: Record<string, 'user' | 'project' | 'local'> = { user_settings: 'user', project_settings: 'project', local_settings: 'local' };

// Spec 3.3 (D6, C5): a mid-session change to harness's hooks, its deny rules, disableAllHooks or sandbox is not applied
// to the running session, measured against the guarded views at the session's first other hook (plan ruling 4).
export const configChange: Check = {
  name: 'config-change',
  events: ['ConfigChange'],
  failClosed: true,
  run(ctx) {
    const key = SOURCES[String(ctx.input.source)];
    if (!key) return { kind: 'allow' };
    const rel = key === 'user' ? '~/.claude/settings.json' : GUARDED[key];
    const base = ctx.state?.guardedBase;
    const deny = harnessDenyRules(ctx.root);
    let text: string | null = null;
    let cur: GuardedView = null;
    try {
      text = readGuarded(key === 'user' ? GUARDED.user(ctx.home) : join(ctx.root, rel));
      cur = guardedView(text, deny);
    } catch {} // unreadable: cur stays null
    const parts = base ? guardedDiff(base[key] ?? null, cur) : ['no session baseline'];
    if (!parts.length) return { kind: 'allow' };
    if (base && key !== 'user' && cur) {
      // A change the harness CLI recorded (init, update, uninstall) is allowed, and becomes this file's baseline.
      // A file missing from the record never counts as recorded; null records the file as absent.
      const settings = readRepoSnapshot(ctx.root).cli?.settings;
      if (settings && rel in settings && settings[rel] === (text === null ? null : settingsFingerprint(text, deny))) {
        ctx.save({ ...ctx.state, guardedBase: { ...base, [key]: cur } });
        return { kind: 'allow' };
      }
    }
    const list = parts.join(', ');
    try {
      appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'config-change', decision: 'config-change-blocked', reason: `${rel}: ${list}` });
    } catch {} // the block stands without the log
    const notice = `Harness blocked a change to \`${rel}\` (${list}) in this session. The file is still changed on disk, so the next session loads it: review it first.`;
    const pending = ctx.state?.pendingNotice;
    if (ctx.state) ctx.save({ ...ctx.state, pendingNotice: pending?.split('\n').includes(notice) ? pending : [pending, notice].filter(Boolean).join('\n') });
    return {
      kind: 'block',
      check: 'config-change',
      reason: `Harness keeps its hooks, its deny rules, disableAllHooks and the sandbox settings as they were when this session started, so this change to \`${rel}\` (${list}) is not applied to the session.`,
    };
  },
};
