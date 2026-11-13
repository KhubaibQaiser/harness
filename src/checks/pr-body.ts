// pr-body: every agent `gh pr create` (or `pr new`), and every `gh pr edit` that sets a body, must carry a filled pr-ship
// template; the agent may not turn on auto-merge, merge as admin or drop the needs-human label. The template lives in
// templates/skills/pr-ship/SKILL.md; a test pins the two together.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { esc } from '../core/config.js';
import type { Check, Ctx } from '../hooks/dispatch.js';
import { isShell } from '../hooks/edit-target.js';
import type { Decision } from '../hooks/types.js';
import { runnerName, type Seg, walkCommands } from './guard.js';
import { afterPr } from './pr-size/detect.js';

export const MARKER = '<!-- harness:pr-body -->';
export const HEADINGS = [
  'Summary', 'What changed and why', 'Alternatives considered', 'How to review', 'How to verify', 'Screenshots', 'Performance', 'Security',
  'Human steps before merge or deploy', 'Not verified and known limits',
];
const HUMAN = HEADINGS[8]!;
const NEEDS_HUMAN = 'needs-human';
const BODY_MAX = 1 << 20;
const USE = "Write the body from the pr-ship skill's template to a file and pass --body-file <file>.";

/** Each `## ` section's heading (comments on the heading line dropped) and its trimmed text, in order. */
function sections(text: string): [string, string][] {
  // ponytail: a `## ` line inside a code fence also starts a section (and so reads as a duplicate); the template has no fences.
  return text.split(/^## /m).slice(1).map((part) => {
    const nl = part.indexOf('\n');
    return [(nl < 0 ? part : part.slice(0, nl)).replace(/<!--.*?-->/g, '').trim(), nl < 0 ? '' : part.slice(nl).trim()];
  });
}

/** What is wrong with a PR body against the template; empty when it passes. Never echoes body text: it may hold secrets. */
export function bodyProblems(text: string, labels: string[]): string[] {
  const raw = text.replace(/\r\n?/g, '\n');
  if (!raw.includes(MARKER)) return ["the body doesn't use the pr-ship template (its `<!-- harness:pr-body -->` line is missing)"];
  // What GitHub shows: comments gone, and an unclosed one hides the rest of the body.
  const shown = sections(raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, ''));
  const count = (h: string) => shown.filter(([k]) => k === h).length;
  const missing = HEADINGS.filter((h) => count(h) === 0);
  const twice = HEADINGS.filter((h) => count(h) > 1);
  const empty = HEADINGS.filter((h) => count(h) === 1 && /^[\s\p{P}\p{S}]*$/u.test(shown.find(([k]) => k === h)![1]));
  const out: string[] = [];
  if (missing.length) out.push(`missing sections: ${missing.join(', ')}`);
  if (twice.length) out.push(`duplicate sections: ${twice.join(', ')}`);
  if (empty.length) out.push(`empty sections: ${empty.join(', ')} (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`);
  // "None." exactly, with nothing else (not even a comment), is the only way to say there are no human steps.
  const steps = sections(raw).find(([k]) => k === HUMAN)?.[1];
  if (count(HUMAN) === 1 && !empty.includes(HUMAN) && steps !== 'None.' && !labels.includes(NEEDS_HUMAN)) {
    out.push(`the "${HUMAN}" section lists steps, so the PR needs the ${NEEDS_HUMAN} label (\`--label ${NEEDS_HUMAN}\` on create, \`--add-label ${NEEDS_HUMAN}\` on edit); never auto-merge or auto-deploy it`);
  }
  return out;
}

type Kind = 'create' | 'edit' | 'merge';
type Target = { kind: Kind; sub: string; args: string[]; seg: string; redirect: boolean } | { kind: 'hidden' };
const SUBS: [string, Kind][] = [['create', 'create'], ['new', 'create'], ['edit', 'edit'], ['merge', 'merge']];

// gh pr create/edit flags, short forms to long, and the long ones that take a value (so `--title "--fill"` is a title).
const LONG: Record<string, string> = {
  '-t': '--title', '-b': '--body', '-F': '--body-file', '-a': '--assignee', '-l': '--label', '-m': '--milestone', '-p': '--project', '-r': '--reviewer',
  '-R': '--repo', '-T': '--template', '-B': '--base', '-H': '--head', '-e': '--editor', '-f': '--fill', '-w': '--web', '-d': '--draft',
};
const VALUE = new Set(['--title', '--body', '--body-file', '--assignee', '--label', '--milestone', '--project', '--reviewer', '--repo', '--template', '--recover',
  '--base', '--head', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project']);
const FILL = ['--fill', '--fill-first', '--fill-verbose'];

/** The flags of one gh pr create/edit by long name, values in command order (gh keeps the last); `--x=v` and `-xv` included. */
function flags(args: string[]): { values: Map<string, string[]>; bare: Set<string>; order: string[] } {
  const values = new Map<string, string[]>(), bare = new Set<string>(), order: string[] = [];
  const put = (f: string, v: string) => (values.set(f, [...(values.get(f) ?? []), v]), order.push(f));
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^(--[\w-]+)=(.*)$/s.exec(a) ?? /^(-[A-Za-z])(.+)$/s.exec(a);
    const f = LONG[m ? m[1]! : a] ?? (m ? m[1]! : a);
    if (m && VALUE.has(f)) put(f, m[2]!);
    else if (VALUE.has(f)) put(f, args[i + 1] !== undefined ? args[++i]! : '$('); // the walker splits a `$(…)` value off its flag
    else if (a.startsWith('-')) bare.add(f); // `-fw` is `--fill`
  }
  return { values, bare, order };
}

const norm = (toks: string[]) => toks.join(' ').replace(/\u0001/g, ' ');

/** Every gh pr create/new/edit/merge under every reading, and every other simple command on the line. */
function targets(command: string, ctx: Ctx): { list: Target[]; others: boolean } {
  const list: Target[] = [];
  const segs = new Set<string>();
  walkCommands<never>(command, { root: ctx.root, env: ctx.env }, ({ toks, k, prev }: Seg) => {
    if (toks.length) segs.add(norm(toks));
    // A command name the shell expands ($GH, $(which gh)) hides the real arguments, as in pr-size's detect.
    const hidden = toks[k]?.startsWith('$') ? toks.slice(k + 1) : k === 0 && (prev === ')' || prev === '`') ? toks : null;
    if (hidden && SUBS.some(([s]) => afterPr(hidden, s))) list.push({ kind: 'hidden' });
    else if (runnerName(toks[k] ?? '') === 'gh') {
      for (const [sub, kind] of SUBS) {
        const args = afterPr(toks.slice(k + 1), sub);
        if (args) list.push({ kind, sub, args, seg: norm(toks), redirect: toks.some((x) => /^(\d+|&)?[<>]/.test(x)) });
      }
    }
    return null;
  }, { whole: (w) => (w.includes('eval') && w.includes('gh') && w.includes('pr') && SUBS.some(([s]) => w.includes(s)) ? (list.push({ kind: 'hidden' }), null) : null) });
  const mine = new Set(list.flatMap((t) => ('seg' in t ? [t.seg] : [])));
  return { list, others: [...segs].some((s) => !mine.has(s)) };
}

/** The body file's text, or why it can't be read. Fails closed: anything harness can't read is a reason, never a pass. */
function bodyText(ctx: Ctx, file: string): { text: string } | { why: string } {
  if (file === '-') return { why: "a body read from stdin (--body-file -) can't be checked" };
  const path = resolve(ctx.input.cwd || ctx.root, file);
  try {
    const st = statSync(path);
    // A FIFO or /dev/stdin would hang the hook, so only a regular file is read.
    if (!st.isFile() || st.size > BODY_MAX) return { why: `${esc(file)} is not a regular file of at most 1 MB, so it can't be checked` };
  } catch {
    return { why: `there is no body file at ${esc(path)}` };
  }
  return { text: readFileSync(path, 'utf8') };
}

const deny = (why: string, use = true): Decision => ({ kind: 'deny', check: 'pr-body', reason: use ? `PR body: ${why}. ${USE}` : why });

/** Why one create or edit is denied, or null. */
function bodyWhy(ctx: Ctx, t: Extract<Target, { args: string[] }>, others: boolean): Decision | null {
  const f = flags(t.args), cmd = `gh pr ${t.sub}`;
  const removes = (f.values.get('--remove-label') ?? []).flatMap((v) => v.split(',').map((l) => l.trim()));
  if (removes.includes(NEEDS_HUMAN)) return deny(`Only a person removes the ${NEEDS_HUMAN} label: it marks a PR that needs a human step before merge or deploy.`, false);
  if (FILL.some((x) => f.bare.has(x))) return deny('--fill takes the body from the commits, not the pr-ship template');
  if (f.values.has('--recover') || f.bare.has('--editor')) return deny("--recover and --editor take the body from a place harness can't check");
  const sources = f.order.filter((x) => x === '--body' || x === '--body-file');
  if (!sources.length) return t.kind === 'edit' ? null : deny(`this ${cmd} has no --body-file`);
  if (sources.length > 1) return deny(`this ${cmd} has more than one --body or --body-file; pass exactly one --body-file`);
  if (sources[0] === '--body') return deny('an inline --body can never carry the filled pr-ship template, which spans many lines');
  const file = f.values.get('--body-file')![0]!;
  if (/\$\(|`/.test(file)) return deny("a --body-file named by a substitution can't be checked");
  // Another command on the line could write the file after harness reads it (`cp x body.md && gh pr create -F body.md`).
  if (others || t.redirect) return deny(`${cmd} with a --body-file must be the only command on the line, with no redirect, so nothing can rewrite the file after harness reads it`);
  const body = bodyText(ctx, file);
  if ('why' in body) return deny(body.why);
  const labels = (t.kind === 'create' ? ['--label'] : ['--add-label']).flatMap((k) => f.values.get(k) ?? []).flatMap((v) => v.split(',').map((l) => l.trim()));
  const problems = bodyProblems(body.text, labels);
  return problems.length ? deny(problems.join('; ')) : null;
}

export function decidePrBody(ctx: Ctx): Decision {
  const { tool_name, tool_input = {} } = ctx.input;
  if (!ctx.config?.checks.prBody || !isShell(tool_name)) return { kind: 'allow' };
  const { list, others } = targets(String(tool_input.command ?? ''), ctx);
  for (const t of list) {
    if (t.kind === 'hidden') return deny("harness can't read the arguments of this gh pr command (a variable, eval or substitution runs it)");
    if (t.kind === 'merge') {
      // In any position, even as another flag's value: fail closed rather than mirror merge's flag table.
      if (t.args.some((a) => /^--auto(=|$)/.test(a))) return deny('gh pr merge --auto lets GitHub merge with no person at the moment of merge, so harness never lets the agent turn it on. Ask the person to merge, or to turn on auto-merge themselves.', false);
      if (t.args.some((a) => /^--admin(=|$)/.test(a))) return deny('gh pr merge --admin skips branch protection, so harness never lets the agent run it. Ask the person to merge.', false);
      continue;
    }
    const why = bodyWhy(ctx, t, others);
    if (why) return why;
  }
  return { kind: 'allow' };
}

export const prBody: Check = { name: 'pr-body', events: ['PreToolUse'], failClosed: true, pure: true, run: decidePrBody };
