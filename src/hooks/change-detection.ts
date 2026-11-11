// Change detection, the backstop behind the path checks: a session's baseline is the repo's last-seen snapshot (or,
// on a fresh clone, the files at its first hook). A change shows at the next prompt (a notice, once) and blocks the
// next Stop once (the snapshot is then renewed, and the block counts within stop.max_attempts). Each Stop and
// SessionEnd records what the session has accounted for as the next session's baseline, so a change between
// sessions is reported too. Changes the harness CLI made match its own record and don't count.
import { changedFiles, gitHead, guardedViews, readRepoSnapshot, recordLastSeen, snapshotHarnessFiles, type Snapshot } from '../core/harness-files.js';
import type { Check, Ctx } from './check.js';
import { type Log, warn } from './event-log.js';
import { emit } from './io.js';
import type { HookEvent } from './types.js';

const DEFAULT_STOP_ATTEMPTS = 3;
const SHORT_SHA = 12;

/** What change detection found: a notice for this prompt, or the hook's whole output when it blocks. */
export type Found = { notice: string; out?: string };
type Pass = { ctx: Ctx; event: HookEvent; log: Log; cur: Snapshot; found: Found };
type Noticed = [string, string | null][];

const maxAttempts = (ctx: Ctx): number => ctx.config?.stop.max_attempts ?? DEFAULT_STOP_ATTEMPTS;

/**
 * ConfigChange's and sandbox-required's baseline (plan ruling 4): once per session, before any check runs, and only
 * when a check will compare against it. Returns a blocked ConfigChange's pending notice, shown at this prompt.
 */
export function seedBaselines(ctx: Ctx, event: HookEvent, checks: Check[]): string {
  let pending = '';
  try {
    if (!ctx.state.guardedBase && event !== 'ConfigChange' && checks.some((c) => c.events.includes('ConfigChange') || c.name === 'sandbox-required')) ctx.save({ ...ctx.state, guardedBase: guardedViews(ctx.root, ctx.home, ctx.env), guardedCli: readRepoSnapshot(ctx.root).cli?.id });
    if (event === 'UserPromptSubmit' && ctx.state.pendingNotice) {
      pending = ctx.state.pendingNotice;
      ctx.save({ ...ctx.state, pendingNotice: undefined });
    }
  } catch (e) {
    warn('config-change baseline', e);
  }
  return pending;
}

/** Compares the harness files with the session's baseline at Stop, UserPromptSubmit and SessionEnd. */
export function detectHarnessFileChanges(ctx: Ctx, event: HookEvent, log: Log): Found {
  const found: Found = { notice: '' };
  try {
    if (!ctx.state.harnessFiles) {
      const seen = readRepoSnapshot(ctx.root).lastSeen;
      ctx.save({ ...ctx.state, harnessFiles: seen?.files ?? snapshotHarnessFiles(ctx.root), harnessHead: seen ? seen.head : ctx.state.baseHead });
    }
    if (event === 'Stop' || event === 'UserPromptSubmit' || event === 'SessionEnd') compare({ ctx, event, log, cur: snapshotHarnessFiles(ctx.root), found });
  } catch (e) {
    warn('harness-files', e);
  }
  return found;
}

function compare(p: Pass): void {
  const { ctx, event, cur } = p;
  const prev = ctx.state.harnessFiles!;
  // A change shown at a prompt that is no longer as shown (undone, or changed again) before the Stop that would
  // account for it: report that at this Stop, once. At SessionEnd, an undone change makes the shown state the
  // next session's baseline, so the next session reports the undoing.
  const noticed: Noticed | null = ctx.state.harnessNoticed ? JSON.parse(ctx.state.harnessNoticed) : null;
  const gone = !!noticed && noticed.some(([f, h]) => (cur[f] ?? null) !== h);
  const shown: Snapshot = { ...prev };
  for (const [f, h] of noticed ?? []) if (h === null) delete shown[f]; else shown[f] = h;
  if (gone && event === 'Stop') {
    p.found.out = blockChangedAgain(p, noticed!, shown);
    if (p.found.out !== undefined) return;
  }
  const files = event === 'SessionEnd' && gone ? [] : changedFiles(ctx.state.harnessFiles!, cur);
  p.found.out = reportChanged(p, files);
  if (p.found.out !== undefined) return;
  // What this session has accounted for (not an unreported change) is where the next session starts.
  // At SessionEnd the shown state becomes the next baseline only when the shown change was undone or changed again
  // (so the next session reports that); a change still there keeps the old baseline, so the next Stop blocks it.
  if (event === 'Stop' || event === 'SessionEnd') recordLastSeen(ctx.root, event === 'SessionEnd' && gone ? shown : ctx.state.harnessFiles!, ctx.state.harnessHead);
}

function blockChangedAgain(p: Pass, noticed: Noticed, shown: Snapshot): string | undefined {
  const { ctx, event, cur, log } = p;
  const changed = [...new Set([...noticed.map(([f]) => f), ...changedFiles(shown, cur)])].sort();
  log('harness-files', 'harness-files-changed', changed.join(', '));
  const head = gitHead(ctx.root);
  const why = `The change to ${noticed.map(([f]) => `\`${f}\``).join(', ')} shown at the last prompt is no longer there: something changed these files again before this Stop, possibly undoing the person's edit. ${filesChangedWhy(changed, ctx.state.harnessHead, head)}`;
  const attempts = ctx.state.stopAttempts + 1;
  const over = attempts > maxAttempts(ctx);
  ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: over ? 0 : attempts });
  recordLastSeen(ctx.root, cur, head);
  if (over) log('harness-files', 'stop-gave-up', why);
  else return emit(event, { kind: 'block', reason: why, check: 'harness-files' });
  return undefined;
}

function reportChanged(p: Pass, files: string[]): string | undefined {
  const { ctx, event, cur, log } = p;
  const cli = files.length ? readRepoSnapshot(ctx.root).cli : undefined;
  if (files.length && cli && !changedFiles(cli.files, cur).length) ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: gitHead(ctx.root), harnessNoticed: undefined });
  else if (files.length && event !== 'SessionEnd') {
    const key = JSON.stringify(files.map((f) => [f, cur[f] ?? null]));
    if (ctx.state.harnessNoticed !== key) log('harness-files', 'harness-files-changed', files.join(', '));
    const head = gitHead(ctx.root);
    const why = filesChangedWhy(files, ctx.state.harnessHead, head);
    const attempts = ctx.state.stopAttempts + 1;
    if (event === 'UserPromptSubmit') {
      if (ctx.state.harnessNoticed !== key) p.found.notice = why;
      ctx.save({ ...ctx.state, harnessNoticed: key });
    } else if (attempts > maxAttempts(ctx)) {
      ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: 0 });
      log('harness-files', 'stop-gave-up', why);
    } else {
      ctx.save({ ...ctx.state, harnessFiles: cur, harnessHead: head, harnessNoticed: undefined, stopAttempts: attempts });
      recordLastSeen(ctx.root, cur, head);
      return emit(event, { kind: 'block', reason: why, check: 'harness-files' });
    }
  }
  return undefined;
}

function filesChangedWhy(files: string[], startHead: string | undefined, head: string | undefined): string {
  const list = files.map((f) => `\`${f}\``).join(', ');
  const short = (h: string) => h.slice(0, SHORT_SHA);
  const review = startHead
    ? `\`git diff ${short(startHead)} -- .harness .claude/settings.json .claude/rules docs/decisions\` (everything since the session started), and \`git diff -- .harness .claude/settings.json .claude/rules docs/decisions\` for what is not committed`
    : '`git diff -- .harness .claude/settings.json .claude/rules docs/decisions`';
  const moved = startHead && head && head !== startHead ? ` HEAD moved since the session started (${short(startHead)} -> ${short(head)}): a branch switch, a pull or a commit can explain the change.` : '';
  return `Harness files changed since harness last checked them: ${list}. Tell the person now and ask them to review the change with ${review} (any command or script can change these files, not only an edit).${moved} Harness says this once per change.`;
}
