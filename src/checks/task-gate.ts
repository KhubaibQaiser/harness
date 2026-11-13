// Done contract (spec §4.1): with checks.done on, the agent edits nothing outside a workdir until a person approved a task contract.
import { resolve } from 'node:path';
import { defaultExec } from '../core/exec.js';
import { SAFE_GIT } from '../core/git-safe.js';
import { toRepoPath } from '../core/paths.js';
import { activeTaskId, loadContract, TASKS_DIR } from '../done/contract.js';
import type { Check } from '../hooks/check.js';
import { editTarget, isShell } from '../hooks/edit-target.js';
import { inWorkdir, shellWritePaths } from './protect.js';

export const NO_CONTRACT = 'Draft criteria: run harness task draft, then ask the person to approve';
export const NO_CONTRACT_UNATTENDED = 'Unattended run with no approved contract: launch the run with HARNESS_TASK=<id> naming a contract that is on the base branch';
export const CONTRACT_LOCKED = "Task contracts change only through a person's harness task approve, edit or close";
const CI_DECIDES = "CI decides; this checkout can't vouch for the contract (origin/HEAD is not set)";

export const taskGate: Check = {
  name: 'task',
  events: ['PreToolUse'],
  failClosed: true,
  pure: true,
  run(ctx) {
    const { input, root, unattended } = ctx;
    if (!ctx.config.checks.done) return { kind: 'allow' };
    const deny = (reason: string) => ({ kind: 'deny' as const, reason, check: 'task' });
    const target = editTarget(input);
    // protect's shell reading, not just fileWriteTargets: rm, mv, cp, git restores, and paths after a cd or pushd.
    const shell = target === null && isShell(input.tool_name) ? shellWritePaths(String(input.tool_input?.command ?? '')) : { paths: [], unresolved: false };
    // Writes outside the repo are not the task's edits.
    const paths = (target !== null ? [target] : shell.paths).map((t) => resolve(input.cwd || root, t)).filter((p) => toRepoPath(root, p) !== null);
    if (paths.some((p) => { const rel = toRepoPath(root, p)!.toLowerCase(); return rel === TASKS_DIR || rel.startsWith(`${TASKS_DIR}/`); })) return deny(CONTRACT_LOCKED);
    // A write after a cd that can't be resolved may land anywhere: it needs the contract.
    if (!shell.unresolved && paths.every((p) => inWorkdir(root, p))) return { kind: 'allow' };
    const none = unattended ? NO_CONTRACT_UNATTENDED : NO_CONTRACT;
    let id: string | null;
    try {
      id = activeTaskId(root, ctx.env);
    } catch (e) {
      return deny((e as Error).message);
    }
    if (id === null) return deny(none);
    // The working-tree contract under the trust rule: a local approval, or the same file on origin's default branch (F1: a fresh checkout has only that).
    const loaded = loadContract(root, id);
    // Unattended with no origin/HEAD, nobody can run set-head (it is an ask, so denied): say who decides instead.
    if ('error' in loaded) return deny(`Active task ${id}: ${unattended && loaded.error.includes('origin/HEAD is not set here') ? CI_DECIDES : loaded.error}`);
    if (loaded.contract.closed_at !== null) return deny(`Task ${id} is closed; draft a new one`);
    if (unattended) {
      const base = ctx.state.baseHead;
      if (!base || !/^[0-9a-f]{40,64}$/.test(base)) return deny(none);
      if (defaultExec('git', [...SAFE_GIT, 'cat-file', '-e', `${base}:${TASKS_DIR}/${id}.json`], { cwd: root }).status !== 0) return deny(none);
    }
    return { kind: 'allow' };
  },
};
