// The wrapped Stop runner: one srt call per run, the steps inside it, strict nonce-tagged result lines. Every failure is unavailable.
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, type HarnessConfig } from '../../core/config.js';
import { real, realish, within } from '../../core/paths.js';
import { allowWriteMessage, allowWriteProblem } from './allow-write.js';
import type { Exec } from './gate.js';
import { locateSrt, srtMessage, type SrtProbe } from './srt.js';
import { renderSrtSettings, tempRoots, writableRoots } from './srt-settings.js';
import type { CheckName, Plan, ResultLine, RunSteps, StepResult, StepsRun } from './steps.js';

export interface WrapDeps { root: string; stop: HarnessConfig['stop']; exec: Exec; now: () => number; srt: SrtProbe; home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tokenBase: () => string | null; node: string; nonce?: () => string }
export type Expected = { kind: 'check'; name: CheckName } | { kind: 'step'; label: string };

export const srtArgv = (settings: string, node: string, runner: string, plan: string, nonce: string): string[] => ['--settings', settings, node, runner, '--stop-steps', plan, nonce];

const PROXY = 'sandbox proxy:';
const MAX_PROXY = 1024;
const first = (s: string): string => esc(s.trim().split('\n')[0] ?? '');
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const failing = (l: ResultLine): boolean => (l.kind === 'step' ? l.timedOut || l.status !== 0 : !l.ok);
const opt = (v: unknown) => v === undefined || typeof v === 'string';
const valid = (o: Record<string, unknown>): boolean =>
  o.kind === 'step'
    ? (o.status === null || Number.isInteger(o.status)) && typeof o.timedOut === 'boolean' && Number.isFinite(o.ms) && opt(o.output)
    : typeof o.ok === 'boolean' && opt(o.detail);
const desc = (e: Expected): string => (e.kind === 'step' ? `step '${e.label}'` : `check '${e.name}'`);

/** Lines must match `expected` in order, and stop right after the first failing entry or at its end. */
export function parseResults(stdout: string, nonce: string, expected: Expected[]): { lines: ResultLine[] } | { error: string } {
  const lines: ResultLine[] = [];
  for (const [i, text] of stdout.split('\n').filter((s) => s.trim()).entries()) {
    const at = `line ${i + 1}`;
    const e = expected[i];
    if (!e || (lines.length && failing(lines.at(-1)!))) return { error: `${at}: extra` };
    let o: Record<string, unknown> | null;
    try {
      o = JSON.parse(text);
    } catch {
      return { error: `${at}: not JSON` };
    }
    if (!o || typeof o !== 'object' || o.nonce !== nonce) return { error: `${at}: no nonce` };
    if (o.kind !== e.kind || (e.kind === 'step' ? o.label !== e.label : o.name !== e.name)) return { error: `${at}: out of order (expected ${desc(e)})` };
    if (!valid(o)) return { error: `${at}: bad fields` };
    lines.push(o as ResultLine);
  }
  if (lines.length < expected.length && !(lines.length && failing(lines.at(-1)!))) return { error: `line ${lines.length + 1}: missing (${desc(expected[lines.length]!)})` };
  return { lines };
}

export const runWrapped = (d: WrapDeps): RunSteps => async (steps, deadline) => {
  const fail = (check: string, why: string): StepsRun => ({ kind: 'unavailable', message: srtMessage({ kind: 'check', check, first: first(why) }), reason: check });
  const files: string[] = [];
  let stage = 'token base'; // names the failed check when anything below throws
  try {
    const tokenBase = d.tokenBase();
    stage = 'stop.allow_write';
    const root = realish(d.root);
    const which = d.srt.which('srt');
    const sys = { root, home: d.home, env: d.env, platform: d.platform, srtReal: which ? realish(which) : null, tokenBase };
    for (const entry of d.stop.allow_write) {
      const why = allowWriteProblem(entry, sys);
      if (why) return { kind: 'unavailable', message: allowWriteMessage(entry, why), reason: 'stop.allow_write' };
    }
    stage = 'launcher';
    const inputs = { root, stop: d.stop, home: d.home, tmp: tempRoots() };
    const roots = writableRoots(inputs);
    const found = locateSrt(d.srt, roots, d.platform, d.node);
    if ('why' in found) return { kind: 'unavailable', message: srtMessage(found.why), reason: found.why.kind === 'check' ? found.why.check : found.why.kind };
    // launch[0] for a node launch; a binary srt still runs the step runner with node, so check it the same way.
    const node = realish(d.node);
    const hit = [d.node, node].find((p) => roots.flatMap((w) => [w, realish(w)]).some((w) => within(p, w, d.platform)));
    if (hit) return { kind: 'unavailable', message: srtMessage({ kind: 'writable', path: esc(hit) }), reason: 'writable' };
    stage = 'step runner';
    const runner = join(root, '.harness/hooks/dispatch.mjs'); // R2: the protected hook bundle, on srt's denyWrite
    if (!lstatSync(runner).isFile()) return fail(stage, 'not a regular file');
    if (real(runner) !== runner) return fail(stage, 'not its own realpath');
    stage = 'settings file';
    const nonce = (d.nonce ?? (() => randomBytes(16).toString('hex')))();
    const dir = join(root, '.harness/state');
    const sFile = join(dir, `srt-${nonce}.json`);
    const pFile = join(dir, `plan-${nonce}.json`);
    // R1: the runner must read the plan, so only the settings file is on denyRead. The nonce binds a line's origin; it is not a secret (step code can read it).
    const settings = Buffer.from(JSON.stringify(renderSrtSettings({ ...inputs, tokenBase, denyWrite: [], denyRead: [sFile] }, d.platform)));
    const plan: Plan = { nonce, deadlineMs: deadline, steps };
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(dir).isDirectory() || real(dir) !== dir) return fail(stage, 'state folder is not a real directory');
    writeFileSync(sFile, settings, { flag: 'wx', mode: 0o600 });
    files.push(sFile);
    try {
      writeFileSync(pFile, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      return fail(stage, `plan: ${msg(e)}`);
    }
    files.push(pFile);
    const ms = deadline - d.now();
    if (ms <= 0) return { kind: 'timeout' };
    // srt only debug-logs a missing settings file, so check it holds our bytes just before the spawn.
    let st;
    try {
      st = lstatSync(sFile);
    } catch {
      return fail(stage, 'missing');
    }
    if (!st.isFile()) return fail(stage, 'not a regular file');
    if (!readFileSync(sFile).equals(settings)) return fail(stage, 'changed');
    stage = 'srt exit';
    const r = await d.exec(found.launch[0]!, [...found.launch.slice(1), ...srtArgv(sFile, node, runner, pFile, nonce)], ms);
    if (r.timedOut) return { kind: 'timeout' };
    const err = r.stderr ?? '';
    if (r.status !== 0) return fail(stage, err.trim() ? err : r.output.trim() ? r.output : `status ${r.status}`);
    const parsed = parseResults(r.stdout ?? '', nonce, steps.map((s) => ({ kind: 'step', label: s.label })));
    if ('error' in parsed) return fail('result lines', parsed.error);
    const results: StepResult[] = parsed.lines.flatMap((l) => (l.kind === 'step' ? [{ label: l.label, status: l.status, timedOut: l.timedOut, ms: l.ms, output: l.output ?? '' }] : []));
    // R12: srt's stderr should hold only proxy lines; anything else means a degraded srt.
    const errLines = err.split('\n').filter((s) => s.trim());
    const warn = errLines.find((s) => !s.startsWith(PROXY));
    if (warn) return fail('srt warning', warn);
    const last = results.at(-1);
    const failed = !!last && (last.timedOut || last.status !== 0);
    if (!failed && r.stderrRolled) return fail('srt warning', 'stderr overflow'); // the dropped head may have held a warning
    const proxy = errLines.join('\n').slice(-MAX_PROXY);
    if (failed && proxy) last.output += `\n${proxy}`; // srt's own denial lines explain a step that needed the network
    return { kind: 'ran', results };
  } catch (e) {
    return fail(stage, msg(e));
  } finally {
    for (const f of files) {
      try {
        rmSync(f, { force: true });
      } catch (e) {
        process.stderr.write(`harness: could not delete ${f}: ${first(msg(e))}\n`);
      }
    }
  }
};
