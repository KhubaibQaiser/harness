import { resolve } from 'node:path';
import { esc } from '../core/config.js';

/** The person's own command line, for a step Claude Code's sandbox blocks. */
export function sandboxLine(cmd: 'init' | 'update' | 'git' | 'add' | 'remove' | 'sync' | 'context', args: string[]): string {
  return `Claude Code's sandbox blocks harness's own files. ${ownCommand(cmd, args)}`;
}
/** The person's own command line, with the `!` prefix hint. */
export function ownCommand(cmd: string, args: string[]): string {
  const self = process.argv[1] ? `node "${resolve(process.argv[1])}"` : 'npx @khubaibqaiser/harness';
  return `Run this yourself with Claude Code's \`!\` prefix (a \`!\` command runs outside the sandbox): ${self} ${cmd} ${args.map(shq).join(' ')}`;
}
/** One shell word: bare when plain, else single-quoted (embedded quotes the POSIX way); control characters are escaped first so they never reach the terminal. */
export const shq = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${(/[\u0000-\u001f\u007f-\u009f]/.test(a) ? esc(a) : a).replace(/'/g, `'\\''`)}'`);
export const isDenied = (e: unknown): boolean => ['EPERM', 'EACCES'].includes((((e as Error)?.cause ?? e) as NodeJS.ErrnoException)?.code ?? '');
