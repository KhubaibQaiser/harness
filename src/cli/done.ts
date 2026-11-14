// `harness done --blocked "<reason>"` (done-contract spec §4.2): the agent says it cannot finish. This only checks and reports;
// the evidence-ledger hook writes the blocked row, so a reason the hook would not record is refused here.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { GUARDED, readGuarded } from '../core/harness-files.js';
import { effective, managedSettingsPath, readManagedLayers, withoutRepoMirror } from '../core/settings-layers.js';
import { isHarnessHook } from '../install/merge.js';
import { blockedReason, checkArgvs, MAX_BLOCKED_REASON } from '../done/commands.js';
import { activeTaskId, loadContract } from '../done/contract.js';
import { freshEvidence, readLedger } from '../done/ledger.js';
import { atRoot } from '../done/ledger-hook.js';
import { treeHash } from '../done/tree.js';
import type { CliEnv } from './index.js';

export const DONE_USAGE = 'harness done --blocked "<reason>"';

const runsHook = (s: any): boolean =>
  (Array.isArray(s?.hooks?.PostToolUse) ? s.hooks.PostToolUse : []).some(
    (g: any) => Array.isArray(g?.hooks) && g.hooks.some(isHarnessHook) && (!g.matcher || g.matcher === '*' || new RegExp(`^(?:${g.matcher})$`).test('Bash')),
  );

/**
 * The settings layers (managed, user, project, local) run the harness PostToolUse hook for Bash, and none turns hooks off.
 * Fails closed: an existing layer that can't be read or parsed is false. A missing file is an empty layer.
 * ponytail: an unreadable managed file counts as empty, as it does for Claude Code, which runs as the same user; harness doctor warns about it.
 */
function hookWired(cli: CliEnv): boolean {
  const { root } = cli, env = withoutRepoMirror(root, cli.env);
  const managedLayers = readManagedLayers(cli.managed ?? managedSettingsPath(cli.platform ?? process.platform));
  const managed = managedLayers.map((l) => l.json ?? {});
  const files = [GUARDED.user(cli.home ?? homedir(), env), join(root, GUARDED.project), join(root, GUARDED.local)].map((p) => {
    try {
      const j = JSON.parse(readGuarded(p) ?? '{}');
      return j !== null && typeof j === 'object' && !Array.isArray(j) ? j : false;
    } catch {
      return false;
    }
  });
  if (files.includes(false)) return false;
  if ([...managed, ...files].some((s: any) => s.disableAllHooks === true)) return false;
  return (effective(managedLayers, ['allowManagedHooksOnly']) === true ? managed : [...managed, ...files]).some(runsHook);
}

export function done(args: string[], cli: CliEnv): number {
  const { root, env, out } = cli;
  const usage = (why: string) => (out(`${why}\nUsage: ${DONE_USAGE}`), 2);
  if (args.length !== 2 || args[0] !== '--blocked') return usage('harness done takes --blocked and one reason.');
  const reason = args[1]!;
  if (!reason.trim()) return usage('The reason is empty.');
  if (/[\r\n]/.test(reason)) return usage('The reason must be one line.');
  if (reason.length > MAX_BLOCKED_REASON) return usage(`The reason is over ${MAX_BLOCKED_REASON} characters.`);
  // The hook only records an exact plain command: ask its own matcher, so the two never disagree.
  if (blockedReason(`harness done --blocked "${reason}"`) !== reason) return usage('The reason has shell syntax the hook cannot record ($ ` ; & | < > ( ) \\ * ? [ ] { } ~ # or an unbalanced quote). Say it in plain words.');
  if (!atRoot(cli.cwd ?? process.cwd(), root)) return usage('Run harness done from the repo root: the hook records nothing from another folder.');
  try {
    const { config } = loadConfig(root);
    if (!config.checks.done) return out('The done contract is off (checks.done); nothing would be recorded.'), 1;
    if (!hookWired(cli)) return out('The harness PostToolUse hook is not wired (or disableAllHooks is set); nothing would be recorded. Run harness doctor.'), 1;
    const id = activeTaskId(root, env);
    if (id === null) return out('No active task: nothing would be recorded. A person approves a contract with harness task approve.'), 1;
    const loaded = loadContract(root, id);
    if ('error' in loaded) return out(`Active task ${id}: ${loaded.error}`), 1;
    const { gaps } = freshEvidence(loaded.contract, readLedger(root), treeHash(root), (n) => checkArgvs(root, config).get(n) ?? null);
    out(gaps.length ? `Not passing now:\n${gaps.map((g) => `  - ${g.kind} ${g.id}: ${g.label}`).join('\n')}` : 'Every check and criterion has fresh passing evidence.');
  } catch (e) {
    return out(`harness done failed: ${(e as Error).message}`), 1;
  }
  out('The harness hook records the blocked row when this Bash call completes (not for run_in_background or PowerShell). Confirm with harness verify: exit 3 means blocked, unless a tamper finding makes it not done.');
  return 0;
}
