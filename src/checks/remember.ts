// The guard's ask for `harness remember` (team-decisions spec §6.1). The person reads the decision text in the ask, so
// that text must be what the shell passes on: no expansion, substitution or stdin. Field text never reaches the log.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_DIR, shown, slugId } from '../core/decision-file.js';
import { ruleRel } from '../core/decision-rule.js';
import { gitIn } from '../core/decisions-stale.js';
import { planSync, readDecisions } from '../core/decisions.js';
import { appendEvent } from '../core/events.js';
import { redactSecrets, scanSecrets } from '../core/secrets.js';
import { cPayloads, pieces, unquote, words } from '../core/shell-words.js';
import type { Ctx } from '../hooks/check.js';
import type { Decision } from '../hooks/types.js';
import { commandStart } from './guard.js';

export const REMEMBER_WHY = 'the agent is saving a team decision';
type Result = Extract<Decision, { kind: 'deny' | 'ask' }>;

const NOT_LITERAL = 'Blocked by guard: harness remember needs its text as plain quoted words, so the person sees exactly what is written. Remove $, backticks and substitutions.';
const VALUED = new Set(['--title', '--rule', '--why', '--path', '--supersedes', '--by']);
const HARNESS = /(^|\/)harness(@\S+)?(\.(cmd|ps1|bat|exe))?$|(^|\/)cli\.m?js$/i;
const ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/;
const MAX_DEPTH = 3;

/** One `harness remember` invocation: its words after `remember` as written, and whether stdin or a substitution feeds it. */
interface Raw { words: string[]; fed: boolean }

/** Every `harness remember` segment, in the command and in the -c payloads it runs. */
function invocations(text: string, depth = 0): Raw[] {
  const out: Raw[] = [];
  const ps = pieces(text);
  ps.forEach((p, i) => {
    const ws = words(p.text);
    const plain = ws.map(unquote);
    const k = commandStart(plain);
    if (!HARNESS.test(plain[k] ?? '') || plain[k + 1] !== 'remember') return;
    // Piped into it, or a `$(`, `<(` or backtick right after it: the shell supplies some of its words.
    out.push({ words: ws.slice(k + 2), fed: /^\|/.test(ps[i - 1]?.sep ?? '') || /^[(`]$/.test(p.sep) });
  });
  if (depth < MAX_DEPTH) for (const c of cPayloads(text)) out.push(...invocations(c, depth + 1));
  return out;
}

/** The characters of a word that are outside quotes (an escaped character counts as quoted). */
function unquotedPart(w: string): string {
  let out = '', quote = '';
  for (let i = 0; i < w.length; i++) {
    const c = w[i]!;
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '\\') i++;
    else out += c;
  }
  return out;
}

const literal = (r: Raw): boolean =>
  !r.fed && r.words.every((w) => !/[$`]/.test(w) && !/^[<@]/.test(w) && !/[*?[\]{}<>]|^[~#]/.test(unquotedPart(w)));

interface Parsed { sub: string; values: Map<string, string[]>; rest: string[] }
function parse(ws: string[]): Parsed {
  const [sub = '', ...args] = ws.map(unquote);
  const p: Parsed = { sub, values: new Map(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    if (VALUED.has(args[i]!) && i + 1 < args.length) p.values.set(args[i]!, [...(p.values.get(args[i]!) ?? []), args[++i]!]);
    else if (!args[i]!.startsWith('-')) p.rest.push(args[i]!);
  }
  return p;
}
const one = (p: Parsed, k: string): string => p.values.get(k)?.[0] ?? '';

function secretIn(p: Parsed): string | null {
  const fields: [string, string][] = [...[...p.values].flatMap(([k, vs]) => vs.map((v): [string, string] => [k, v])), ...p.rest.map((v): [string, string] => ['the id', v])];
  for (const [name, text] of fields) {
    const hit = scanSecrets(text)[0];
    if (hit) return hit.kind + '\0' + name;
  }
  return null;
}

const ask = (reason: string, log: string): Result => ({ kind: 'ask', reason, check: 'guard', log });
const idLog = (sub: string, id: string) => `remember ${sub}${ID.test(id) ? ` ${id}` : ''}`;

function addAsk(ctx: Ctx, p: Parsed, today: string): Result {
  const title = one(p, '--title');
  const id = slugId(title, today, (x) => existsSync(join(ctx.root, DECISIONS_DIR, `${x}.md`)));
  const why = one(p, '--why');
  const text = [
    `Confirm: the agent wants to save a team decision to ${DECISIONS_DIR}/${id}.md.`,
    `Title: ${shown(title)}.`,
    `Rule: ${shown(one(p, '--rule'))}.`,
    ...(why ? [`Why: ${shown(why)}.`] : []),
    `Paths: ${(p.values.get('--path') ?? []).map(shown).join(', ')}.`,
    'Once merged it loads for every teammate whose session touches those paths. Approve to write the files (nothing is committed).',
  ];
  return ask(text.join(' '), `remember add ${id}`);
}

function confirmAsk(ctx: Ctx, id: string): Result {
  const head = gitIn(ctx.root)(['-c', 'core.fsmonitor=false', 'rev-parse', '--short=7', 'HEAD']);
  const sha7 = head.ok ? head.out.trim() : 'HEAD';
  return ask(`Confirm: the agent wants to mark decision ${shown(id)} as still true at ${sha7}; it then stays loaded for another ${ctx.config.decisions.expiry_days} days.`, idLog('confirm', id));
}

function retireAsk(id: string, by: string): Result {
  const how = by ? ` (superseded by ${shown(by)})` : '';
  return ask(`Confirm: the agent wants to retire decision ${shown(id)}${how}. It rewrites ${DECISIONS_DIR}/${shown(id)}.md and removes ${shown(ruleRel(id))}. The decision file stays as a record.`, idLog('retire', id));
}

function syncAsk(ctx: Ctx, today: string): Result {
  let files: string[];
  try {
    const plan = planSync(ctx.root, readDecisions(ctx.root, today), ctx.config.decisions, today);
    files = [...plan.changes.map((c) => c.rel), ...(plan.adopt.length + plan.rehash.length + plan.stale.length ? ['.harness/manifest.json'] : [])];
  } catch {
    files = []; // unreadable rules folder: the CLI says why
  }
  const what = files.length ? `It changes ${files.map(shown).join(', ')}.` : 'It may change the rule files in .claude/rules/ and .harness/manifest.json.';
  return ask(`Confirm: the agent wants to sync the team decision rules. ${what}`, 'remember sync');
}

function judge(ctx: Ctx, r: Raw, today: string): Result {
  if (!literal(r)) return { kind: 'deny', reason: NOT_LITERAL, check: 'guard', log: 'remember: not literal' };
  const p = parse(r.words);
  if (ctx.unattended && p.sub === 'add') {
    const reason = `${redactSecrets(one(p, '--title'))} | ${redactSecrets(one(p, '--rule'))}`;
    appendEvent(ctx.root, { ts: new Date().toISOString(), session: ctx.input.session_id, check: 'remember', decision: 'decision-candidate', reason });
  }
  const secret = secretIn(p);
  if (secret) {
    const [kind, field] = secret.split('\0');
    return { kind: 'deny', reason: `Blocked by guard: this decision looks like it holds a secret (${kind} in ${field}). Decisions are committed to git. Remove it.`, check: 'guard', log: `remember: secret (${kind})` };
  }
  const quote = quoteHit(); // Task 10 fills this in
  if (quote) return quote;
  if (p.sub === 'add') return addAsk(ctx, p, today);
  if (p.sub === 'confirm') return confirmAsk(ctx, p.rest[0] ?? '');
  if (p.sub === 'retire') return retireAsk(p.rest[0] ?? '', one(p, '--by'));
  if (p.sub === 'sync') return syncAsk(ctx, today);
  return ask(`Confirm: ${REMEMBER_WHY}`, `remember ${p.sub === 'list' || p.sub === 'check' ? p.sub : ''}`.trim());
}

/** Quote detection (§7.1) lands in Task 10; until then nothing counts as a quote. */
const quoteHit = (): Result | null => null;

/** The guard's decision on a command it found running `harness remember` without a read-only form: §6.1 steps 1 to 4. */
export function rememberAsk(ctx: Ctx, command: string, now: Date = new Date()): Exclude<Decision, { kind: 'allow' }> {
  const today = now.toISOString().slice(0, 10);
  const found = invocations(command);
  if (!found.length) return { kind: 'deny', reason: NOT_LITERAL, check: 'guard', log: 'remember: not literal' }; // the guard saw one; this reader can't
  const results = found.map((r) => judge(ctx, r, today));
  return results.find((d) => d.kind === 'deny') ?? results.find((d) => d.log !== 'remember list' && d.log !== 'remember check') ?? results[0]!;
}
