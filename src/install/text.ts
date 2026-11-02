import { createHash } from 'node:crypto';

export const eolOf = (s: string): '\n' | '\r\n' => (s.includes('\r\n') ? '\r\n' : '\n');
export const withEol = (s: string, eol: '\n' | '\r\n'): string => s.replace(/\r?\n/g, eol);
/** Indent of the first indented line: a tab, or the space count; 2 when none. */
export function jsonIndentOf(s: string): string | number {
  const m = /^([ \t]+)\S/m.exec(s);
  if (!m) return 2;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
// Manifest hashes ignore CRLF vs LF: a teammate with core.autocrlf=true checks the installed files out with CRLF.
export const hashText = (s: string): string => sha256(s.replace(/\r\n/g, '\n'));
/** True for the LF-normalized hash this version records, and for the exact hash older manifests recorded. */
export const matchesHash = (s: string, h: string): boolean => hashText(s) === h || sha256(s) === h;
