import { isDeepStrictEqual } from 'node:util';
import { type GuardedPart, type GuardedView, settingsBlocks } from './harness-files.js';

// Plan ruling R11 (CC7): which settings changes weaken harness. Everything else in a settings file is the person's and
// applies live, as Claude Code intends. ConfigChange uses it now; the settings-edit check (CC6) will too.

// Owner answer Q7 = A (2026-11-16): settings `env` reaches the hook processes, so only the keys that steer them stay
// guarded. Matched case-insensitively, as Windows reads env names (`Path`).
export const GUARDED_ENV: { keys: readonly string[]; prefixes: readonly string[] } = {
  keys: ['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'CI', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', 'AGENT_GUARD_ALLOW_INSTALL', 'XDG_RUNTIME_DIR'],
  prefixes: ['HARNESS_', 'GIT_', 'LD_', 'DYLD_'],
};
const guardedKey = (k: string): boolean => {
  const u = k.toUpperCase();
  return GUARDED_ENV.keys.includes(u) || GUARDED_ENV.prefixes.some((p) => u.startsWith(p));
};

/** What harness wrote to `.claude/settings.json`, from the manifest. `deny` is null when the manifest is unknown. */
export type Owned = { sandbox: Record<string, unknown>; denyWrite: string[]; deny: Set<string> | null; hookGroups: string[] };

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function ownedSettings(root: string): Owned {
  const blocks = settingsBlocks(root);
  const owned: Owned = { sandbox: {}, denyWrite: [], deny: blocks ? new Set() : null, hookGroups: [] };
  for (const raw of blocks ?? []) {
    let b: any;
    try {
      b = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof b?.deny === 'string') owned.deny!.add(b.deny);
    else if (typeof b?.denyWrite === 'string') owned.denyWrite.push(b.denyWrite);
    else if (typeof b?.event === 'string' && isObj(b.group)) owned.hookGroups.push(raw);
    // A created parent (`value: {}`) is not a value harness relies on.
    else if (Array.isArray(b?.set) && b.set.length === 2 && b.set[0] === 'sandbox' && !isObj(b.value)) owned.sandbox[b.set[1]] = b.value;
  }
  return owned;
}

// No baseline: the project file as harness wrote it.
function fromManifest(o: Owned): GuardedView {
  const hooks = new Map<string, unknown[]>();
  for (const raw of o.hookGroups) {
    const { event, group } = JSON.parse(raw);
    hooks.set(event, [...(hooks.get(event) ?? []), group]);
  }
  return { hooks: [...hooks], deny: [...(o.deny ?? [])], disableAllHooks: null, sandbox: { ...o.sandbox, filesystem: { denyWrite: o.denyWrite } }, env: {} };
}

/**
 * The parts of harness that `cur` weakens against `base`: a harness hook group changed or gone, a harness deny rule gone,
 * disableAllHooks turned on, an owned sandbox key moved off harness's value, an owned denyWrite path gone, or a guarded
 * env key added, removed or changed. `base === undefined` compares against the manifest's records.
 */
export function weakened(base: GuardedView | undefined, cur: GuardedView, owned: Owned): GuardedPart[] {
  const b = base === undefined ? fromManifest(owned) : base;
  if (!b || !cur) return ['unreadable'];
  const groups = (v: NonNullable<GuardedView>) => v.hooks.flatMap(([event, gs]) => gs.map((group) => ({ event, group })));
  const box = (v: NonNullable<GuardedView>) => (isObj(v.sandbox) ? v.sandbox : {});
  const denyWrite = (v: NonNullable<GuardedView>): unknown[] => (Array.isArray(box(v).filesystem?.denyWrite) ? box(v).filesystem.denyWrite : []);
  const env = (v: NonNullable<GuardedView>) => Object.fromEntries(Object.entries(isObj(v.env) ? v.env : {}).filter(([k]) => guardedKey(k)));
  const [eb, ec] = [env(b), env(cur)];
  const parts: GuardedPart[] = [];
  if (groups(b).some((g) => !groups(cur).some((c) => isDeepStrictEqual(c, g)))) parts.push('hooks');
  if (b.deny.some((r) => !cur.deny.includes(r))) parts.push('deny');
  if (cur.disableAllHooks && !b.disableAllHooks) parts.push('disableAllHooks');
  if (Object.entries(owned.sandbox).some(([k, v]) => !isDeepStrictEqual(box(b)[k], box(cur)[k]) && !isDeepStrictEqual(box(cur)[k], v))) parts.push('sandbox');
  if (owned.denyWrite.some((p) => denyWrite(b).includes(p) && !denyWrite(cur).includes(p))) parts.push('denyWrite');
  if ([...new Set([...Object.keys(eb), ...Object.keys(ec)])].some((k) => eb[k] !== ec[k])) parts.push('env');
  return parts;
}
