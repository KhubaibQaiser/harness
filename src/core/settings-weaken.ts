import { isDeepStrictEqual } from 'node:util';
import { type GuardedPart, type GuardedView, hookIds, settingsBlocks } from './harness-files.js';
import { effective, type Layer } from './settings-layers.js';

// Plan ruling R11 (CC7): which settings changes weaken harness. Everything else in a settings file is the person's and
// applies live, as Claude Code intends. ConfigChange uses it now; the settings-edit check (CC6) will too.

// Owner answer Q7 = A (2026-11-16): settings `env` reaches the hook processes, so only the keys that steer them stay
// guarded. Matched case-insensitively, as Windows reads env names (`Path`).
export const GUARDED_ENV: { keys: readonly string[]; prefixes: readonly string[] } = {
  keys: ['PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'CI', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP', 'AGENT_GUARD_ALLOW_INSTALL', 'XDG_RUNTIME_DIR',
    // Owner answer M2 (2026-11-16): home, temp and shell paths steer the Stop gate's srt profile and runner.
    'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'COMSPEC'],
  prefixes: ['HARNESS_', 'GIT_', 'LD_', 'DYLD_'],
};
const guardedKey = (k: string): boolean => {
  const u = k.toUpperCase();
  return GUARDED_ENV.keys.includes(u) || GUARDED_ENV.prefixes.some((p) => u.startsWith(p));
};

// Owner answer OQ1 = A (2026-11-16): sandbox-required judges the session-start files, so a change that makes the value
// Claude Code uses for a key it relies on looser is held, in any file, whoever wrote it. Each key with its safe value and
// the layers Claude Code honours it from, read the way sandbox-required reads it; turning one on applies live.
const ANY: Layer['name'][] = ['managed', 'local', 'project', 'user'];
const TRUSTED: [string[], unknown, Layer['name'][]][] = [
  [['enabled'], true, ANY],
  [['allowUnsandboxedCommands'], false, ANY],
  [['network', 'strictAllowlist'], true, ['managed', 'user']], // any honoured true wins
  [['network', 'allowManagedDomainsOnly'], true, ['managed']],
];
// Precedence (settings docs): managed, then --settings (a hook can't see it), local, project, user: the first that sets it.
// Owner answer M3 (2026-11-16): excludedCommands entries run outside the sandbox; lists merge across layers, so an entry
// new to the union is held, and a removal applies.
const excluded = (layers: Layer[]): Set<string> =>
  new Set(layers.flatMap((x) => { const v = effective([x], ['sandbox', 'excludedCommands']); return Array.isArray(v) ? v.map((e) => JSON.stringify(e)) : []; }));
const winning = (layers: Layer[], path: string[], from: Layer['name'][]): unknown =>
  from === ANY ? effective(layers, ['sandbox', ...path]) : layers.some((l) => from.includes(l.name) && effective([l], ['sandbox', ...path]) === true) || undefined;

/** What harness wrote to `.claude/settings.json`, from the manifest. `deny` is null when it is unknown. */
export type Owned = { sandbox: Record<string, unknown>; denyWrite: string[]; deny: Set<string> | null; hookGroups: string[] };

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Owned from parsed manifest blocks (`settingsBlocks`); null blocks mean unknown. */
export function ownedFrom(blocks: unknown[] | null): Owned {
  const owned: Owned = { sandbox: {}, denyWrite: [], deny: blocks ? new Set() : null, hookGroups: [] };
  for (const b of (blocks ?? []) as any[]) {
    if (typeof b?.deny === 'string') owned.deny!.add(b.deny);
    else if (typeof b?.denyWrite === 'string') owned.denyWrite.push(b.denyWrite);
    else if (typeof b?.event === 'string' && isObj(b.group)) owned.hookGroups.push(JSON.stringify(b));
    // A created parent (`value: {}`) is not a value harness relies on.
    else if (Array.isArray(b?.set) && b.set.length === 2 && b.set[0] === 'sandbox' && !isObj(b.value)) owned.sandbox[b.set[1]] = b.value;
  }
  return owned;
}

export const ownedSettings = (root: string): Owned => ownedFrom(settingsBlocks(root));

// No baseline: the project file as harness wrote it.
function fromManifest(o: Owned): GuardedView {
  const hooks = new Map<string, unknown[]>();
  for (const raw of o.hookGroups) {
    const { event, group } = JSON.parse(raw);
    hooks.set(event, [...(hooks.get(event) ?? []), group]);
  }
  return { hooks: [...hooks], deny: [...(o.deny ?? [])], disableAllHooks: null, sandbox: { ...o.sandbox, filesystem: { denyWrite: o.denyWrite } }, env: {}, hookIds: hookIds(Object.fromEntries(hooks)) };
}

/**
 * The parts of harness that `cur` weakens against `base`: a harness hook group changed or gone, a harness deny rule gone,
 * disableAllHooks turned on, an owned sandbox key moved off harness's value, a TRUSTED sandbox key loosened, an owned
 * denyWrite path gone, or a guarded env key added, removed or changed. `base === undefined` compares against the manifest's
 * records. `layers` (every settings layer before and after) judges the TRUSTED keys on the value that wins; without it,
 * on this file alone. With ownership unknown (`owned.deny === null`), every sandbox change counts.
 */
export function weakened(base: GuardedView | undefined, cur: GuardedView, owned: Owned, layers?: { base: Layer[]; cur: Layer[] }): GuardedPart[] {
  const b = base === undefined ? fromManifest(owned) : base;
  if (!b || !cur) return ['unreadable'];
  const groups = (v: NonNullable<GuardedView>) => v.hooks.flatMap(([event, gs]) => gs.map((group) => ({ event, group })));
  const box = (v: NonNullable<GuardedView>) => (isObj(v.sandbox) ? v.sandbox : {});
  const l = layers ?? { base: [{ name: 'user', json: b }], cur: [{ name: 'user', json: cur }] };
  const denyWrite = (v: NonNullable<GuardedView>): unknown[] => (Array.isArray(box(v).filesystem?.denyWrite) ? box(v).filesystem.denyWrite : []);
  const env = (v: NonNullable<GuardedView>) => Object.fromEntries(Object.entries(isObj(v.env) ? v.env : {}).filter(([k]) => guardedKey(k)));
  const [eb, ec] = [env(b), env(cur)];
  const parts: GuardedPart[] = [];
  if (groups(b).some((g) => !groups(cur).some((c) => isDeepStrictEqual(c, g)))) parts.push('hooks');
  if (b.hookIds && cur.hookIds?.some((h) => !b.hookIds!.includes(h))) parts.push('newHooks'); // a state from before them: skipped
  if (b.deny.some((r) => !cur.deny.includes(r))) parts.push('deny');
  if (cur.disableAllHooks && !b.disableAllHooks) parts.push('disableAllHooks');
  if (
    (owned.deny === null && !isDeepStrictEqual(b.sandbox, cur.sandbox)) ||
    Object.entries(owned.sandbox).some(([k, v]) => !isDeepStrictEqual(box(b)[k], box(cur)[k]) && !isDeepStrictEqual(box(cur)[k], v)) ||
    TRUSTED.some(([path, safe, from]) => winning(l.base, path, from) === safe && winning(l.cur, path, from) !== safe)
  ) parts.push('sandbox');
  if ([...excluded(l.cur)].some((e) => !excluded(l.base).has(e))) parts.push('excludedCommands');
  if (owned.denyWrite.some((p) => denyWrite(b).includes(p) && !denyWrite(cur).includes(p))) parts.push('denyWrite');
  if ([...new Set([...Object.keys(eb), ...Object.keys(ec)])].some((k) => eb[k] !== ec[k])) parts.push('env');
  return parts;
}
