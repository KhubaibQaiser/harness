#!/usr/bin/env node
// Usage: node scripts/install-local.mjs --target <repo> [--dry-run]
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg, code = 1) => { console.error(`install-local: ${msg}`); process.exit(code); };
const { values } = parseArgs({ options: { target: { type: 'string' }, 'dry-run': { type: 'boolean' } } });

if (!values.target) fail('--target <repo> is required', 2);
const target = resolve(values.target);
if (!existsSync(join(target, '.git'))) fail(`${target} is not a git repo root (no .git)`, 2);

const src = (p) => join(root, p);
if (!existsSync(src('dist/hooks/dispatch.mjs'))) fail('dist/hooks/dispatch.mjs is missing: run pnpm build first');

// Refuse any existing path component under the target that is a symlink.
const checkLinks = (rel) => {
  let p = target;
  for (const part of rel.split('/')) {
    p = join(p, part);
    if (existsSync(p) || lstatSync(p, { throwIfNoEntry: false })) {
      if (lstatSync(p).isSymbolicLink()) fail(`refusing symlink: ${rel}`);
    }
  }
};
const readOpt = (rel) => { checkLinks(rel); const p = join(target, rel); return existsSync(p) ? readFileSync(p, 'utf8') : null; };

const OLD = ['scripts/agent-hooks/guard.mjs', 'stop-check.mjs'];
const hasOld = (h) => OLD.some((o) => String(h.command ?? '').includes(o));

function mergeSettings(existingText) {
  let s;
  try { s = existingText === null ? {} : JSON.parse(existingText); } catch (e) { fail(`.claude/settings.json is not valid JSON: ${e.message}`); }
  const frag = JSON.parse(readFileSync(src('templates/settings.fragment.json'), 'utf8'));
  s.hooks ??= {};
  for (const [ev, groups] of Object.entries(s.hooks)) {
    s.hooks[ev] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !hasOld(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  for (const [ev, groups] of Object.entries(frag.hooks)) {
    const list = (s.hooks[ev] ??= []);
    for (const g of groups) {
      const have = new Set(list.flatMap((x) => x.hooks.map((h) => h.command)));
      const hooks = g.hooks.filter((h) => !have.has(h.command));
      if (hooks.length) list.push({ ...g, hooks });
    }
  }
  s.permissions ??= {};
  s.permissions.deny ??= [];
  for (const d of frag.permissions.deny) if (!s.permissions.deny.includes(d)) s.permissions.deny.push(d);
  return JSON.stringify(s, null, 2) + '\n';
}

const START = '<!-- harness:start -->';
const END = '<!-- harness:end -->';
function mergeAgents(text) {
  const block = readFileSync(src('templates/agents-block.md'), 'utf8').trimEnd();
  if (text === null) return block + '\n';
  const s = text.indexOf(START), e = text.indexOf(END);
  if (s === -1 && e === -1) return text + (text.endsWith('\n') ? '' : '\n') + '\n' + block + '\n';
  if (s === -1 || e === -1 || e < s) fail('AGENTS.md has a missing or misordered harness marker; fix it by hand');
  return text.slice(0, s) + block + text.slice(e + END.length);
}

function mergeGitignore(text) {
  let out = text ?? '';
  for (const l of ['.harness/state/', '.harness/logs/']) {
    if (!out.split('\n').includes(l)) out += (out === '' || out.endsWith('\n') ? '' : '\n') + l + '\n';
  }
  return out;
}

// Plan everything first (all validation happens here), then write.
const plan = [];
const add = (rel, next, old) => plan.push({ rel, next, old });
const copy = (rel, from) => add(rel, readFileSync(src(from), 'utf8'), readOpt(rel));

copy('.harness/hooks/dispatch.mjs', 'dist/hooks/dispatch.mjs');
const cfg = readOpt('.harness/config.yaml');
add('.harness/config.yaml', cfg ?? readFileSync(src('templates/config.example.yaml'), 'utf8'), cfg);
copy('.claude/agents/staff-reviewer.md', 'templates/agents/staff-reviewer.md');
copy('.claude/skills/review-rubric/SKILL.md', 'templates/skills/review-rubric/SKILL.md');
const st = readOpt('.claude/settings.json');
add('.claude/settings.json', mergeSettings(st), st);
const ag = readOpt('AGENTS.md');
add('AGENTS.md', mergeAgents(ag), ag);
const gi = readOpt('.gitignore');
add('.gitignore', mergeGitignore(gi), gi);

for (const { rel, next, old } of plan) {
  console.log(`${old === null ? 'create' : old === next ? 'unchanged' : 'update'} ${rel}`);
  if (values['dry-run'] || old === next) continue;
  mkdirSync(dirname(join(target, rel)), { recursive: true });
  writeFileSync(join(target, rel), next);
}
