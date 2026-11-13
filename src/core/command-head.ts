// The command head of each segment, read once for every rule: a known wrapper (sudo, env, nice, timeout, xargs, …) with
// its options is split off into its own segment, and a path or quoted head (/usr/bin/git, "git") becomes its name.
import { commandName, pieces, unquote, words } from './shell-words.js';

/** A wrapper's short options that take a value (`v`) or none (`f`), its long ones, and whether one positional word
 *  (timeout's duration) comes before the command. GNU and BSD/macOS forms. */
type Spec = { v?: string; f?: string; lv?: string[]; lf?: string[]; arg?: true };
const WRAPPERS: Record<string, Spec> = {
  command: { f: 'pvV' },
  builtin: {},
  exec: { v: 'a', f: 'cl' },
  env: { v: 'uCSPa', f: 'i0v', lv: ['unset', 'chdir', 'split-string', 'argv0'], lf: ['ignore-environment', 'null', 'debug', 'default-signal', 'ignore-signal', 'block-signal', 'list-signal-handling'] },
  sudo: { v: 'ugCDhprtUTR', f: 'AbBEHiKklnNPSsVv', lv: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout', 'chroot'], lf: ['askpass', 'background', 'bell', 'preserve-env', 'set-home', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'validate'] },
  doas: { v: 'uC', f: 'nsL' },
  nice: { v: 'n', lv: ['adjustment'] },
  nohup: {},
  time: { v: 'of', f: 'pvalqh', lv: ['output', 'format'], lf: ['portability', 'verbose', 'append', 'quiet'] },
  timeout: { v: 'sk', f: 'vfp', lv: ['signal', 'kill-after'], lf: ['verbose', 'foreground', 'preserve-status'], arg: true },
  xargs: { v: 'InPLsdEaJRS', f: '0rtpxoile', // GNU -i, -l, -e take only a stuck value
    lv: ['max-args', 'max-procs', 'max-lines', 'max-chars', 'delimiter', 'arg-file', 'process-slot-var'], lf: ['eof', 'replace', 'null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty'] },
  stdbuf: { v: 'ioe', lv: ['input', 'output', 'error'] },
  setsid: { f: 'cfw', lf: ['ctty', 'fork', 'wait'] },
  ionice: { v: 'cnpPu', f: 't', lv: ['class', 'classdata', 'pid', 'pgid', 'uid'], lf: ['ignore'] },
  busybox: {},
};
const LEADERS = new Set(['{', '!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until']);
const nameOf = (w: string): string => commandName(unquote(w));

/** Where the options of the wrapper at `i` end. An option the table does not know sets `unsure`; it is read as taking
 *  the next word only when `valueMode` is set. */
function pastOptions(ws: string[], i: number, spec: Spec, name: string, valueMode: boolean, out: { unsure: boolean }): number {
  for (i++; i < ws.length; ) {
    const t = unquote(ws[i]);
    if (t === '--') return i + 1 + (spec.arg ? 1 : 0);
    if (t === '-' && name === 'env') { i++; continue; } // `env -` is `env -i`
    if (!t.startsWith('-') || t === '-') break;
    if (name === 'nice' && /^-\d+$/.test(t)) { i++; continue; } // nice -5
    if (t.startsWith('--')) {
      const eq = t.indexOf('='), n = t.slice(2, eq < 0 ? undefined : eq);
      if (spec.lv?.includes(n)) i += eq < 0 ? 2 : 1;
      else if (spec.lf?.includes(n)) i++;
      else { out.unsure = true; i += eq < 0 && valueMode ? 2 : 1; }
      continue;
    }
    let next = 1; // a cluster: -iu NAME; a stuck value: -uroot
    for (let j = 1; j < t.length; j++) {
      if (spec.v?.includes(t[j])) { next = j === t.length - 1 ? 2 : 1; break; }
      if (!spec.f?.includes(t[j])) { out.unsure = true; next = valueMode && j === t.length - 1 ? 2 : 1; break; }
    }
    i += next;
  }
  return spec.arg && i < ws.length ? i + 1 : i;
}

/** One segment's text with its head read plainly, or null when nothing changes. */
function plainSegment(seg: string, valueMode: boolean, out: { unsure: boolean }): string | null {
  const ws = words(seg);
  let i = 0;
  const cuts: number[] = []; // where each wrapper's options end: a segment break goes there
  for (;;) {
    while (i < ws.length && (LEADERS.has(ws[i]) || /^\w+=/.test(ws[i]))) i++;
    const name = i < ws.length ? nameOf(ws[i]) : '';
    if (!Object.hasOwn(WRAPPERS, name)) break;
    cuts.push((i = pastOptions(ws, i, WRAPPERS[name], name, valueMode, out)));
  }
  if (i >= ws.length) return null;
  const head = ws[i];
  // Only a path or quoted head is renamed (a heredoc's `EOF` line stays as it is); a word the shell builds is left as written.
  const name = /[/\\'"]/.test(head) && !/[$`*?[{]/.test(unquote(head)) ? nameOf(head) : head;
  if (!cuts.length && name === head) return null;
  // Word offsets in order: only whitespace lies between two words, so each indexOf lands on its own word.
  const offs: number[] = [];
  for (let j = 0; j <= i; j++) offs.push(seg.indexOf(ws[j], j ? offs[j - 1] + ws[j - 1].length : 0));
  let text = '', from = 0;
  for (const c of cuts) [text, from] = [`${text}${seg.slice(from, offs[c]).trimEnd()} ; `, offs[c]];
  return text + seg.slice(from, offs[i]) + name + seg.slice(offs[i] + head.length);
}

/**
 * The command with every segment's head read plainly: `sudo -u x nice -n 5 /usr/bin/git push -f` reads as
 * `sudo -u x ; nice -n 5 ; git push -f`, so each rule decides it as the plain form, and a wrapper option that writes a
 * file (time -o) is still a segment of its own. Empty when no segment changes. When a wrapper has an option the table
 * does not know, its value cannot be told from the command, so two readings come back (the option with and without a
 * value) and `unsure` is set: the caller asks when they disagree.
 * ponytail: with two unknown options, mixed readings (one with a value, one without) are not tried.
 */
export function plainHeads(cmd: string): { texts: string[]; unsure: boolean } {
  const out = { unsure: false };
  const read = (valueMode: boolean): string | null => {
    let text = '', from = 0, changed = false;
    for (const p of pieces(cmd)) {
      const k = cmd.indexOf(p.text, from); // pieces are trimmed and in order; only separators lie between them
      const plain = plainSegment(p.text, valueMode, out);
      if (plain !== null) [text, changed] = [text + cmd.slice(from, k) + plain, true];
      else text += cmd.slice(from, k + p.text.length);
      from = k + p.text.length;
    }
    return changed ? text + cmd.slice(from) : null;
  };
  const a = read(false);
  if (a === null || !out.unsure) return { texts: a === null ? [] : [a], unsure: false };
  return { texts: [a, read(true) ?? cmd], unsure: true };
}
