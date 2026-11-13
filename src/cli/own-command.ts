import { relative, resolve } from 'node:path';
import { denyWritePaths } from '../checks/protect.js';
import { readCliPath, trustedCli } from '../core/cli-path.js';
import { esc } from '../core/config.js';

/** The person's own command line, for a step Claude Code's sandbox blocks. */
export function sandboxLine(cmd: 'init' | 'update' | 'git' | 'add' | 'remove' | 'sync' | 'context', args: string[], root: string): string {
  return `Claude Code's sandbox blocks harness's own files. ${ownCommand(cmd, args, root)}`;
}
/**
 * The person's own command line, with the `!` prefix hint. A `!` command runs outside the sandbox, so it names only the
 * trusted CLI (the repo's own node_modules install, as the guard does): the running script could be the agent's own copy.
 */
export function ownCommand(cmd: string, args: string[], root: string): string {
  const cli = readCliPath(root) ?? trustedCli(process.argv[1] ?? '', root);
  const self = cli ? `node "${cli}"` : 'npx @khubaibqaiser/harness';
  return `Run this yourself with Claude Code's \`!\` prefix (a \`!\` command runs outside the sandbox): ${self} ${cmd} ${args.map(shq).join(' ')}`;
}
/** One shell word: bare when plain, else single-quoted (embedded quotes the POSIX way); control characters are escaped first so they never reach the terminal. */
export const shq = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${(/[\u0000-\u001f\u007f-\u009f]/.test(a) ? esc(a) : a).replace(/'/g, `'\\''`)}'`);
export const isDenied = (e: unknown): boolean => ['EPERM', 'EACCES'].includes((((e as Error)?.cause ?? e) as NodeJS.ErrnoException)?.code ?? '');
/** EPERM on a path under harness's denyWrite list (a rename's `dest` counts): the sandbox's denial, not any other. */
export function deniedWrite(e: unknown, root: string): boolean {
  const x = ((e as Error)?.cause ?? e) as NodeJS.ErrnoException & { dest?: string };
  if (x?.code !== 'EPERM') return false;
  const under = (p: unknown) => {
    if (typeof p !== 'string') return false;
    const rel = relative(root, resolve(root, p)).replace(/\\/g, '/');
    return denyWritePaths().some((d) => rel === d.slice(2) || rel.startsWith(`${d.slice(2)}/`));
  };
  return under(x.path) || under(x.dest);
}
/** For any harness command the sandbox blocks (its denyWrite covers harness's files): the person's own `!` line, or null. */
export const deniedHint = (argv: string[], e: unknown, root: string): string | null =>
  (deniedWrite(e, root) ? `Claude Code's sandbox blocks harness's own files. ${ownCommand(argv[0] ?? '', argv.slice(1), root)}` : null);
