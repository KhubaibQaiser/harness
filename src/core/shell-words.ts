// A small, quote-aware reading of a shell command line, shared by the guard and protect. A seatbelt, not a parser:
// no here-docs, no expansions.
// ponytail: POSIX quoting only (', ", \); PowerShell rules are not modelled.

/** The command split at ; & | && || newlines, parentheses and backticks outside quotes. */
export function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === quote) quote = '';
    } else if (c === '\\' && i + 1 < cmd.length) cur += c + cmd[++i];
    else if (c === '"' || c === "'") (quote = c), (cur += c);
    else if (/[;&|\n()`]/.test(c)) {
      // 2>&1, >&2 and &> are redirections, not separators.
      if (c === '&' && (/[<>]$/.test(cur) || cmd[i + 1] === '>')) { cur += c; continue; }
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The words of one segment, quotes kept (a word may join quoted and unquoted parts, as in --eval="x"). */
export const words = (seg: string): string[] => seg.match(/(?:"(?:\\.|[^"\\])*"?|'[^']*'?|\\.|[^\s"'\\])+/g) ?? [];

/** A word as the shell passes it on: quotes removed; in double quotes only \" \\ \$ \` are escapes. */
export function unquote(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === "'") {
      const end = word.indexOf("'", i + 1);
      out += word.slice(i + 1, end < 0 ? word.length : end);
      i = end < 0 ? word.length : end;
    } else if (c === '"') {
      for (i++; i < word.length && word[i] !== '"'; i++) {
        if (word[i] === '\\' && /["\\$`]/.test(word[i + 1] ?? '')) i++;
        out += word[i];
      }
    } else if (c === '\\' && i + 1 < word.length) out += word[++i];
    else out += c;
  }
  return out;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'script']);
/** A word's command name: its last path segment, lower case, without a Windows extension. */
export const commandName = (word: string): string => word.replace(/["']/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, ''); // backslashes are separators here

/** The commands that `sh -c`, `bash -c`, `script -c` (and the like) run, unquoted, wherever they appear. */
export function cPayloads(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of segments(cmd)) {
    const ws = words(seg);
    for (let i = 0; i < ws.length; i++) {
      if (!SHELLS.has(commandName(ws[i]))) continue;
      for (let j = i + 1; j < ws.length && ws[j].startsWith('-'); j++) {
        if (/^-[a-zA-Z]*c$/.test(ws[j]) && ws[j + 1] !== undefined) {
          out.push(unquote(ws[j + 1]));
          break;
        }
      }
    }
  }
  return out;
}
