// gh and hub: an allow-list (owner ruling, 2026-11-13). Only the known reads below run freely; every other subcommand
// asks, unknown ones, extensions and user aliases included. `gh pr create`/`new` stay allowed (the pr-body check gates
// them). gh/hub api reads, and GitLab push options, are judged too. Arguments are read with the shared getopt reader.
import { type OptTable, readOptions, valuesOf } from '../core/options.js';

/** gh 2.97's group aliases (`gh <group> --help`, ALIASES). */
const GROUP_ALIAS: Record<string, string> = { cs: 'codespace', rs: 'ruleset', ext: 'extension', extensions: 'extension', skills: 'skill', at: 'attestation', agent: 'agent-task', agents: 'agent-task', 'agent-tasks': 'agent-task' };
/**
 * The read subcommands per gh group, from gh 2.97's `--help` with their aliases (`ls`). `true`: every subcommand reads
 * (or the command has none). A nested read is `sub:third` (`repo deploy-key list`). Local-only commands that change
 * nothing on GitHub (`pr checkout`, `repo clone`, `run download`) count as reads.
 */
const GH_READS: Record<string, ReadonlySet<string> | true> = {
  auth: new Set(['status']), browse: true, codespace: new Set(['list', 'ls', 'view', 'logs']), discussion: new Set(['list', 'ls', 'view']), gist: new Set(['list', 'ls', 'view', 'clone']),
  issue: new Set(['list', 'ls', 'status', 'view']), org: new Set(['list', 'ls']), pr: new Set(['list', 'ls', 'status', 'checks', 'diff', 'view', 'checkout', 'co', 'create', 'new']),
  project: new Set(['field-list', 'item-list', 'list', 'ls', 'view']), release: new Set(['list', 'ls', 'view', 'download', 'verify', 'verify-asset']),
  repo: new Set(['list', 'ls', 'view', 'clone', 'gitignore', 'license', 'read-dir', 'read-file', 'deploy-key:list', 'deploy-key:ls', 'autolink:list', 'autolink:view']),
  skill: new Set(['list', 'ls', 'search', 'preview', 'show']), cache: new Set(['list', 'ls']), run: new Set(['list', 'ls', 'view', 'watch', 'download']), workflow: new Set(['list', 'ls', 'view']),
  'agent-task': new Set(['list', 'view']), alias: new Set(['list', 'ls']), attestation: true, completion: true, config: new Set(['get', 'list', 'ls']), extension: new Set(['list', 'ls', 'search', 'browse']),
  'gpg-key': new Set(['list', 'ls']), 'ssh-key': new Set(['list', 'ls']), label: new Set(['list', 'ls']), licenses: true, ruleset: new Set(['check', 'list', 'ls', 'view']), search: true,
  secret: new Set(['list', 'ls']), variable: new Set(['get', 'list', 'ls']), status: true, help: true, version: true,
};
const NESTED = new Set(['deploy-key', 'autolink']); // repo subcommands whose read is the third word
// gh's persistent flags that can come before the subcommand and take a value.
const GH_OPTS: OptTable = { v: 'R', lv: ['repo', 'hostname'], lf: ['help', 'version'] };
// gh api and hub api: method, fields (which make the default method POST), input body, headers, and the value flags that shift positionals.
const API_OPTS: OptTable = { v: 'XfFHqtp', lv: ['method', 'field', 'raw-field', 'input', 'header', 'jq', 'template', 'cache', 'preview', 'hostname'], lf: ['paginate', 'include', 'silent', 'verbose', 'slurp', 'obey-ratelimit'] };

/** `--help`/`-h`/`--version` as an option of its own (not another option's value): gh prints and does nothing else. */
const asksForHelp = (args: string[]): boolean => args.some((a, i) => /^(--help|-h|--version)$/.test(a) && !(args[i - 1] ?? '').startsWith('-'));

/**
 * Why a gh/hub api call is a write, or null for a clear read: GET (also `-X GET` with fields, sent as query parameters)
 * with no method override, or a GraphQL `query` that is one literal word with no `mutation`. `built`: the command line
 * holds a `$`, backtick or newline, so the query may be built at run time and is not a clear read.
 */
function apiWhy(tool: string, args: string[], built: boolean): string | null {
  const p = readOptions(args, API_OPTS);
  const method = valuesOf(p, ['-X', '--method']).at(-1)?.toUpperCase();
  const fields = valuesOf(p, ['-f', '-F', '--field', '--raw-field']), input = valuesOf(p, ['--input']);
  if (valuesOf(p, ['-H', '--header']).some((h) => /method-override/i.test(h))) return `${tool} api with a method-override header`;
  if (/(^|\/)graphql$/.test((p.pos[0] ?? '').replace(/[?#].*$/, ''))) {
    if (method && method !== 'GET' && method !== 'POST') return `${tool} api graphql with -X ${method}`;
    if (input.length || fields.some((f) => /^[^=]*=@/.test(f))) return `${tool} api graphql with a body from a file or stdin, which harness can't read`;
    if (built) return `${tool} api graphql with a query built at run time ($, a backtick or a newline), which harness can't read`;
    return /\bmutation\b/i.test(args.join(' ')) ? `${tool} api graphql with a mutation` : null;
  }
  if (method) return method === 'GET' ? null : `${tool} api -X ${method}`;
  return fields.length || input.length ? `${tool} api with fields or an input body (${tool} sends those as a POST)` : null;
}

const asks = (what: string) => `${what} is not a known read, so it may change shared state on GitHub (merges, closes, comments, releases, settings and API writes need your yes)`;

/** Why `gh <args>` may change shared state (anything but a known read), or null. `built`: see apiWhy. */
export function ghWriteWhy(args: string[], built: boolean): string | null {
  if (asksForHelp(args)) return null;
  const p = readOptions(args, GH_OPTS), [g = '', sub = '', third = ''] = p.pos, group = GROUP_ALIAS[g] ?? g;
  if (!group) return null; // `gh` alone prints help
  if (group === 'api') { const why = apiWhy('gh', args.slice(args.indexOf(g) + 1), built); return why ? asks(`gh api (${why})`) : null; }
  if (!Object.hasOwn(GH_READS, group)) return asks(`gh ${g}`); // an extension, a user alias, or a command gh added later
  const reads = GH_READS[group];
  if (reads === true || !sub) return null; // a read-only command, or a bare group (help)
  if (group === 'repo' && NESTED.has(sub)) return !third || reads.has(`${sub}:${third}`) ? null : asks(`gh repo ${sub} ${third}`);
  return reads.has(sub) ? null : asks(`gh ${g} ${sub}`);
}

/** hub's own GitHub commands; anything else is a git command hub passes on (the caller judges it as git). */
export const HUB_OWN = new Set(['api', 'browse', 'ci-status', 'compare', 'create', 'delete', 'fork', 'gist', 'pr', 'pull-request', 'release', 'issue', 'sync', 'alias', 'merge', 'help', 'version']);
const HUB_READS: Record<string, ReadonlySet<string> | true> = { browse: true, 'ci-status': true, compare: true, help: true, version: true, alias: true, issue: new Set(['', 'show']), pr: new Set(['list', 'show', 'checkout']), release: new Set(['', 'show', 'download']) };
/** Why hub's own command `<args>` may change shared state, or null (a known read). */
export function hubWriteWhy(args: string[], built: boolean): string | null {
  if (asksForHelp(args)) return null;
  const p = readOptions(args, { lf: ['help', 'version', 'noop'] }), [cmd = '', sub = ''] = p.pos;
  if (!cmd) return null;
  if (cmd === 'api') { const why = apiWhy('hub', args.slice(args.indexOf('api') + 1), built); return why ? asks(`hub api (${why})`) : null; }
  const reads = Object.hasOwn(HUB_READS, cmd) ? HUB_READS[cmd] : undefined;
  return reads === true || reads?.has(sub) ? null : asks(`hub ${cmd}${sub ? ` ${sub}` : ''}`);
}

// git push's options, so `-o X`, `-oX` and `--push-option=X` are read and a value option never hides one.
const PUSH_OPTS: OptTable = { v: 'o', lv: ['push-option', 'repo', 'receive-pack', 'exec'], lo: ['signed', 'force-with-lease', 'recurse-submodules'], prefix: true };
const MR = /^merge_request\./;
const MR_WHY = 'a GitLab merge-request push option (merge_request.*) opens or merges a merge request';
/** Why `git push` with these args (after `push`) asks: a GitLab push option that opens or merges a merge request. */
export function pushOptionWhy(args: string[]): string | null {
  return valuesOf(readOptions(args, PUSH_OPTS), ['-o', '--push-option']).some((o) => MR.test(o)) ? asks(`git push -o merge_request.* (${MR_WHY})`) : null;
}
/** Why git's own config (`git -c push.pushOption=merge_request.* push`, `git config push.pushOption merge_request.*`)
 *  arms a merge-request push option, or null. `globals` are the words before the subcommand. */
export function pushConfigWhy(globals: string[], sub: string | undefined, rest: string[]): string | null {
  const isKey = (k: string) => /^push\.pushoption$/i.test(k);
  for (let i = 0; i < globals.length; i++) {
    const kv = globals[i] === '-c' ? (globals[i + 1] ?? '') : /^-c./.test(globals[i]) ? globals[i].slice(2) : '';
    const eq = kv.indexOf('=');
    if (eq > 0 && isKey(kv.slice(0, eq)) && MR.test(kv.slice(eq + 1))) return asks(`git -c push.pushOption=merge_request.* (${MR_WHY})`);
  }
  if (sub === 'config') {
    const pos = rest.filter((w) => !w.startsWith('-')), k = pos.findIndex(isKey);
    if (k >= 0 && MR.test(pos[k + 1] ?? '')) return asks(`git config push.pushOption merge_request.* (${MR_WHY})`);
  }
  return null;
}

// Done contract: a contract on origin's default branch vouches for itself (loadContract), so a local command that repoints
// refs/remotes/* could vouch for a forged one. Commands that can: update-ref/symbolic-ref there, remote add/set-url/rename/
// set-head, a fetch or pull of a URL, with a refspec that names a destination or --refmap, and remote URL or fetch config.
const REMOTE_REF = /^refs\/remotes\//i; // i: a loose ref on a case-insensitive file system
const REMOTE_KEY = /^(remote\..+\.(url|fetch)|url\..+\.insteadof)$/i;
const REMOTE_SUBS = new Set(['add', 'set-url', 'rename', 'set-head']);
const FETCH_OPTS: OptTable = {
  v: 'josX', lv: ['jobs', 'server-option', 'upload-pack', 'refmap', 'depth', 'deepen', 'shallow-since', 'shallow-exclude', 'negotiation-tip', 'filter', 'submodule-prefix', 'recurse-submodules-default', 'strategy', 'strategy-option'],
  lo: ['recurse-submodules', 'rebase', 'gpg-sign'], prefix: true,
};
const CONFIG_OPTS: OptTable = { v: 'f', lv: ['file', 'blob', 'type', 'default', 'comment', 'value'] };
const REF_WHY = 'can repoint a remote-tracking ref (refs/remotes/*), which vouches for a task contract; a person runs it';
const isUrl = (w: string) => /[/\\:]/.test(w) || w.startsWith('.');
/** Why a git command with these words may repoint refs/remotes/*, or null. `globals` are the words before the subcommand. */
export function remoteRefWhy(globals: string[], sub: string | undefined, rest: string[]): string | null {
  const why = (what: string) => `${what} ${REF_WHY}`;
  for (let i = 0; i < globals.length; i++) {
    const kv = globals[i] === '-c' ? (globals[i + 1] ?? '') : /^-c./.test(globals[i]) ? globals[i].slice(2) : globals[i].startsWith('--config-env=') ? globals[i].slice(13) : '';
    if (REMOTE_KEY.test(kv.slice(0, kv.indexOf('=')))) return why(`git -c ${kv.slice(0, kv.indexOf('='))}`);
  }
  if (sub === 'update-ref' || sub === 'symbolic-ref') {
    const p = readOptions(rest, { v: 'm' });
    if (p.flags.includes('--stdin')) return why('git update-ref --stdin (its refs are not visible to harness)');
    const write = sub === 'update-ref' || p.pos.length > 1 || p.flags.some((f) => f === '-d' || f === '--delete');
    return write && REMOTE_REF.test((p.pos[0] ?? '').replace(/\/+/g, '/')) ? why(`git ${sub} ${p.pos[0]}`) : null;
  }
  if (sub === 'remote') {
    const s = readOptions(rest, {}).pos[0] ?? '';
    return REMOTE_SUBS.has(s) ? why(`git remote ${s}`) : null;
  }
  if (sub === 'fetch' || sub === 'pull') {
    const p = readOptions(rest, FETCH_OPTS);
    if (valuesOf(p, ['--refmap']).length) return why(`git ${sub} --refmap`);
    const repos = p.flags.includes('--multiple') ? p.pos : p.pos.slice(0, 1);
    if (repos.some(isUrl)) return why(`git ${sub} of a URL or path`);
    return p.pos.slice(repos.length).some((r) => r.includes(':')) ? why(`git ${sub} with a refspec that names a destination`) : null;
  }
  if (sub === 'config') {
    const pos = readOptions(rest, CONFIG_OPTS).pos, k = pos.findIndex((w) => REMOTE_KEY.test(w));
    return k >= 0 && pos[k + 1] !== undefined ? why(`git config ${pos[k]}`) : null;
  }
  return null;
}
