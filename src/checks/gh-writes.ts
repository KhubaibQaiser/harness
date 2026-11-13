// gh and hub commands that change shared state, gh/hub api writes, and GitLab push options (owner ruling, 2026-11-13).
// The guard asks before each; reads stay allowed. Arguments are read with the shared getopt reader (core/options.ts);
// the guard's walk finds gh past wrappers and path heads, and its plain-head readings feed it here too.
import { type OptTable, readOptions, valuesOf } from '../core/options.js';

/** Write subcommands per gh group. */
const GH_WRITES: Record<string, readonly string[]> = {
  pr: ['merge', 'close', 'reopen', 'review', 'comment', 'edit', 'ready', 'lock', 'unlock'],
  issue: ['close', 'delete', 'edit', 'comment', 'transfer', 'lock', 'pin', 'reopen', 'unlock', 'unpin'],
  release: ['create', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['delete', 'edit', 'archive', 'unarchive', 'rename', 'sync'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  cache: ['delete'],
  gist: ['create', 'edit', 'delete', 'rename'],
  alias: ['set', 'delete', 'import'],
};
/** Groups where every subcommand but these reads writes (gh adds subcommands over time; a new one asks). */
const GH_READS: Record<string, readonly string[]> = { secret: ['list'], variable: ['list', 'get'], ruleset: ['list', 'view', 'check'], label: ['list'] };
// gh's persistent flags that can come before the subcommand and take a value.
const GH_OPTS: OptTable = { v: 'R', lv: ['repo', 'hostname'], lf: ['help', 'version'] };
// gh api and hub api: method, fields (which make the default method POST), input body, and the value flags that shift positionals.
const API_OPTS: OptTable = { v: 'XfFHqtp', lv: ['method', 'field', 'raw-field', 'input', 'header', 'jq', 'template', 'cache', 'preview', 'hostname'], lf: ['paginate', 'include', 'silent', 'verbose', 'slurp', 'obey-ratelimit'] };

/** Why a gh/hub api call is a write, or null for a clear read: GET with no fields, or a GraphQL query with no `mutation`. */
function apiWhy(tool: string, args: string[]): string | null {
  const p = readOptions(args, API_OPTS);
  const method = valuesOf(p, ['-X', '--method']).at(-1)?.toUpperCase();
  const fields = valuesOf(p, ['-f', '-F', '--field', '--raw-field']), input = valuesOf(p, ['--input']);
  if (p.pos[0] === 'graphql') {
    // A GraphQL query is a POST but a read; a mutation, a body read from a file or stdin, or another method is not.
    if (method && method !== 'GET' && method !== 'POST') return `${tool} api graphql with -X ${method}`;
    if (input.length || fields.some((f) => /^[^=]*=@/.test(f))) return `${tool} api graphql with a body from a file, which harness can't read`;
    return /\bmutation\b/i.test(args.join(' ')) ? `${tool} api graphql with a mutation` : null;
  }
  if (method) return method === 'GET' ? null : `${tool} api -X ${method}`;
  return fields.length || input.length ? `${tool} api with fields or an input body (${tool} sends those as a POST)` : null;
}

const asks = (what: string) => `${what} changes shared state (a merge, close, comment, release, setting or API write needs your yes)`;

/** Why `gh <args>` changes shared state, or null. */
export function ghWriteWhy(args: string[]): string | null {
  const p = readOptions(args, GH_OPTS), [group = '', sub = '', third = ''] = p.pos;
  if (group === 'api') { const why = apiWhy('gh', args.slice(args.indexOf('api') + 1)); return why ? asks(`gh api (${why})`) : null; }
  if (group === 'repo' && sub === 'deploy-key') return third === 'add' || third === 'delete' ? asks(`gh repo deploy-key ${third}`) : null;
  if (Object.hasOwn(GH_WRITES, group) && GH_WRITES[group].includes(sub)) return asks(`gh ${group} ${sub}`);
  if (Object.hasOwn(GH_READS, group) && sub && !GH_READS[group].includes(sub)) return asks(`gh ${group} ${sub}`);
  return null;
}

/** Why `hub <args>` changes shared state, or null: pull-request, merge, release create/edit/delete, api writes. */
export function hubWriteWhy(args: string[]): string | null {
  const p = readOptions(args, { lf: ['help', 'version'] }), [cmd = '', sub = ''] = p.pos;
  if (cmd === 'pull-request' || cmd === 'merge') return asks(`hub ${cmd}`);
  if (cmd === 'release' && ['create', 'edit', 'delete'].includes(sub)) return asks(`hub release ${sub}`);
  if (cmd === 'api') { const why = apiWhy('hub', args.slice(args.indexOf('api') + 1)); return why ? asks(`hub api (${why})`) : null; }
  return null;
}

// git push's options, so `-o X`, `-oX` and `--push-option=X` are read and a value option never hides one.
const PUSH_OPTS: OptTable = { v: 'o', lv: ['push-option', 'repo', 'receive-pack', 'exec'], lo: ['signed', 'force-with-lease', 'recurse-submodules'], prefix: true };
/** Why `git push` with these args (after `push`) asks: a GitLab push option that opens or merges a merge request. */
export function pushOptionWhy(args: string[]): string | null {
  const opts = valuesOf(readOptions(args, PUSH_OPTS), ['-o', '--push-option']);
  return opts.some((o) => /^merge_request\./.test(o)) ? asks('git push -o merge_request.* (a GitLab merge request action)') : null;
}
