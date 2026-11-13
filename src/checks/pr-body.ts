// pr-body: every agent `gh pr create`, and every `gh pr edit` that sets a body, must carry a filled pr-ship template;
// `gh pr merge --auto` is denied. The template lives in templates/skills/pr-ship/SKILL.md; a test pins the two together.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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

/** What is wrong with a PR body against the template; empty when it passes. Never echoes body text: it may hold secrets. */
export function bodyProblems(text: string, labels: string[]): string[] {
  const raw = text.replace(/\r\n?/g, '\n');
  if (!raw.includes(MARKER)) return ["the body doesn't use the pr-ship template (its `<!-- harness:pr-body -->` line is missing)"];
  const t = raw.replace(/<!--[\s\S]*?-->/g, ''); // the template's guidance is comments, on or under each heading
  const sections = new Map<string, string>();
  // ponytail: a `## ` line inside a code fence also starts a section; the template has no fences.
  for (const part of t.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    if (!sections.has(head)) sections.set(head, (nl < 0 ? '' : part.slice(nl)).trim());
  }
  const missing = HEADINGS.filter((h) => !sections.has(h));
  const empty = HEADINGS.filter((h) => sections.get(h) === '');
  const out: string[] = [];
  if (missing.length) out.push(`missing sections: ${missing.join(', ')}`);
  if (empty.length) out.push(`empty sections: ${empty.join(', ')} (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`);
  const steps = sections.get(HUMAN);
  if (steps && !/^none\.?$/i.test(steps) && !labels.includes(NEEDS_HUMAN)) {
    out.push(`the "${HUMAN}" section lists steps, so the PR needs the ${NEEDS_HUMAN} label (\`--label ${NEEDS_HUMAN}\` on create, \`--add-label ${NEEDS_HUMAN}\` on edit); never auto-merge or auto-deploy it`);
  }
  return out;
}

type Target = { kind: 'create' | 'edit' | 'merge'; args: string[] } | { kind: 'hidden' };

// gh pr create/edit/merge flags that take a value, so `--title "--fill"` is a title, not a flag.
const VALUE = new Set([
  '-t', '--title', '-b', '--body', '-F', '--body-file', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-r', '--reviewer',
  '-R', '--repo', '-T', '--template', '--recover', '-B', '--base', '-H', '--head', '--add-label', '--remove-label', '--add-assignee', '--remove-assignee',
  '--add-reviewer', '--remove-reviewer', '--add-project', '--remove-project', '--subject', '--match-head-commit', '-A', '--author-email',
]);
const FILL = new Set(['-f', '--fill', '--fill-first', '--fill-verbose']);

/** The flags of one gh pr command, `--x=v` and stuck `-xv` forms included; values of other flags are skipped. */
function flags(args: string[]): { values: Map<string, string[]>; bare: Set<string> } {
  const values = new Map<string, string[]>(), bare = new Set<string>();
  const put = (f: string, v: string) => values.set(f, [...(values.get(f) ?? []), v]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = /^(--[\w-]+)=(.*)$/s.exec(a) ?? /^(-[A-Za-z])(.+)$/s.exec(a);
    if (m && VALUE.has(m[1]!)) put(m[1]!, m[2]!);
    else if (VALUE.has(a)) put(a, args[i + 1] !== undefined ? args[++i]! : '$('); // the walker splits a `$(…)` value off its flag
    else if (a.startsWith('-')) bare.add(m ? m[1]! : a); // `--auto=true` is `--auto`, `-fw` is `-f`
  }
  return { values, bare };
}

function targets(command: string, ctx: Ctx): { list: Target[]; cd: boolean } {
  const list: Target[] = [];
  let cd = false;
  walkCommands<never>(command, { root: ctx.root, env: ctx.env }, ({ toks, k, prev }: Seg) => {
    const name = runnerName(toks[k] ?? '');
    if (name === 'cd' || name === 'pushd') cd = true;
    // A command name the shell expands ($GH, $(which gh)) hides the real arguments, as in pr-size's detect.
    const hidden = toks[k]?.startsWith('$') ? toks.slice(k + 1) : k === 0 && (prev === ')' || prev === '`') ? toks : null;
    if (hidden && afterPr(hidden, 'create')) list.push({ kind: 'hidden' });
    else if (name === 'gh') {
      for (const kind of ['create', 'edit', 'merge'] as const) {
        const args = afterPr(toks.slice(k + 1), kind);
        if (args) list.push({ kind, args });
      }
    }
    return null;
  }, { whole: (w) => (['eval', 'gh', 'pr', 'create'].every((x) => w.includes(x)) ? (list.push({ kind: 'hidden' }), null) : null) });
  return { list, cd };
}

/** The body's text, or why it can't be read. Fails closed: anything harness can't read is a reason, never a pass. */
function bodyText(ctx: Ctx, f: ReturnType<typeof flags>, cd: boolean): { text: string } | { why: string } | null {
  const file = [...(f.values.get('-F') ?? []), ...(f.values.get('--body-file') ?? [])].at(-1);
  if (file === undefined) {
    const body = [...(f.values.get('-b') ?? []), ...(f.values.get('--body') ?? [])].at(-1);
    if (body === undefined) return null;
    return /\$\(|`/.test(body) ? { why: "an inline --body built by a substitution can't be checked" } : { text: body };
  }
  if (/\$\(|`/.test(file)) return { why: "a --body-file named by a substitution can't be checked" };
  if (file === '-') return { why: "a body read from stdin (--body-file -) can't be checked" };
  if (cd && !isAbsolute(file)) return { why: `the command changes directory, so the relative --body-file ${esc(file)} can't be resolved; pass an absolute path` };
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

const deny = (why: string): Decision => ({ kind: 'deny', check: 'pr-body', reason: `PR body: ${why}. ${USE}` });

export function decidePrBody(ctx: Ctx): Decision {
  const { tool_name, tool_input = {} } = ctx.input;
  if (!ctx.config?.checks.prBody || !isShell(tool_name)) return { kind: 'allow' };
  const { list, cd } = targets(String(tool_input.command ?? ''), ctx);
  for (const t of list) {
    if (t.kind === 'hidden') return deny("harness can't read the arguments of this gh pr create (a variable, eval or substitution runs it)");
    const f = flags(t.args);
    if (t.kind === 'merge') {
      if (f.bare.has('--auto')) {
        return { kind: 'deny', check: 'pr-body', reason: 'gh pr merge --auto lets GitHub merge with no person at the moment of merge, so harness never lets the agent turn it on. Ask the person to merge, or to turn on auto-merge themselves.' };
      }
      continue;
    }
    if (t.kind === 'create' && [...FILL].some((x) => f.bare.has(x))) return deny('--fill takes the body from the commits, not the pr-ship template');
    const body = bodyText(ctx, f, cd);
    if (!body) {
      if (t.kind === 'edit') continue; // an edit that leaves the body alone
      return deny('this gh pr create has no --body or --body-file');
    }
    if ('why' in body) return deny(body.why);
    const labels = (t.kind === 'create' ? ['-l', '--label'] : ['--add-label']).flatMap((k) => f.values.get(k) ?? []).flatMap((v) => v.split(',').map((l) => l.trim()));
    const problems = bodyProblems(body.text, labels);
    if (problems.length) return deny(problems.join('; '));
  }
  return { kind: 'allow' };
}

export const prBody: Check = { name: 'pr-body', events: ['PreToolUse'], failClosed: true, pure: true, run: decidePrBody };
