// The command head of each segment, read once for every rule. A known wrapper (sudo, env, nice, timeout, caffeinate, …)
// and its options are split off into their own segment, and the command word left after them — a path or quoted spelling
// such as /usr/bin/git or "git" — is reduced to its bare name. This reading is judged beside the command as written, the
// stricter winning, so a wrapper or a path spelling only ever adds an ask or a deny. Only the head is reduced: an
// argument path (the `/` of `rm -rf /`, `.harness/config.yaml` passed to tee) is left whole, so no target is lost. A
// word the shell builds at run time is left as written.
import { commandName, pieces, unquote, words } from './shell-words.js';

/** A wrapper's short options that take a value (`v`) or none (`f`), its long ones (`lv`/`lf`), and whether one
 *  positional word (timeout's duration, flock's lockfile) comes before the command. GNU and BSD/macOS forms. */
type Spec = { v?: string; f?: string; lv?: string[]; lf?: string[]; arg?: true; mask?: RegExp };
const WRAPPERS: Record<string, Spec> = {
  command: { f: 'pvV' },
  builtin: {},
  exec: { v: 'a', f: 'cl' },
  env: { v: 'uCSPa', f: 'i0v', lv: ['unset', 'chdir', 'split-string', 'argv0'], lf: ['ignore-environment', 'null', 'debug', 'default-signal', 'ignore-signal', 'block-signal', 'list-signal-handling'] },
  sudo: { v: 'ugCDhprtUTR', f: 'AbBEHiKklnNPSsVv', lv: ['user', 'group', 'close-from', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'command-timeout', 'chroot'], lf: ['askpass', 'background', 'bell', 'preserve-env', 'set-home', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'validate'] },
  doas: { v: 'uC', f: 'nsL' },
  runuser: { v: 'ugG', f: 'lmPc', lv: ['user', 'group', 'supp-group'], lf: ['login', 'preserve-environment', 'pty'] },
  nice: { v: 'n', lv: ['adjustment'] },
  nohup: {},
  time: { v: 'of', f: 'pvalqh', lv: ['output', 'format'], lf: ['portability', 'verbose', 'append', 'quiet'] },
  timeout: { v: 'sk', f: 'vfp', lv: ['signal', 'kill-after'], lf: ['verbose', 'foreground', 'preserve-status'], arg: true },
  xargs: { v: 'InPLsdEaJRS', f: '0rtpxoile', lv: ['max-args', 'max-procs', 'max-lines', 'max-chars', 'delimiter', 'arg-file', 'process-slot-var'], lf: ['eof', 'replace', 'null', 'no-run-if-empty', 'verbose', 'interactive', 'exit', 'open-tty'] },
  stdbuf: { v: 'ioe', lv: ['input', 'output', 'error'] },
  setsid: { f: 'cfw', lf: ['ctty', 'fork', 'wait'] },
  ionice: { v: 'cnpPu', f: 't', lv: ['class', 'classdata', 'pid', 'pgid', 'uid'], lf: ['ignore'] },
  busybox: {},
  caffeinate: { v: 'tw', f: 'dimsu' },
  arch: { v: '', f: '', lv: ['arch'] }, // `arch -arm64 CMD`: -arm64/-x86_64 are unknown short flags, read as the next word being the command
  chrt: { f: 'bfioRrmpvh', arg: true }, // `chrt [policy] <prio> CMD`
  taskset: { v: 'c', f: 'ap', mask: /^(0x[0-9a-f]+|[0-9]+|[0-9,-]+)$/i }, // `taskset <mask> CMD`; with -c the list is -c's value, so skip a positional mask only when it looks like one
  coproc: {}, // `coproc CMD` runs CMD as a coprocess: split it off so the writer/command rules see CMD
  unbuffer: { f: 'p' },
  watch: { v: 'ndptg', f: 'bcehvx', lv: ['interval', 'precise'], lf: ['beep', 'color', 'no-title', 'differences', 'errexit', 'chgexit', 'equexit', 'help', 'version'] },
  pkexec: { f: 'c', lf: ['keep-cwd', 'disable-internal-agent', 'user'] },
  xcrun: { v: 'sdkt', f: 'fl', lv: ['sdk', 'toolchain', 'log', 'find', 'run'], lf: ['verbose', 'no-cache', 'kill-cache', 'show-sdk-path'] },
  strace: { v: 'opesExPIabuS', f: 'fFrtTcdDkZyY' },
  ltrace: { v: 'oepExFlbsu', f: 'fScCtTdw' },
  catchsegv: {},
  'sandbox-exec': { v: 'pfD', f: 'n' },
  proxychains: { v: 'f', f: 'q' },
  firejail: {},
  'systemd-run': { v: 'punGH', f: 'tdrq', lv: ['unit', 'property', 'uid', 'gid', 'setenv', 'on-active', 'on-calendar', 'slice'], lf: ['user', 'system', 'scope', 'pty', 'pipe', 'quiet', 'wait', 'collect'] },
  flock: { v: 'wE', f: 'sxnuoF', lv: ['timeout', 'wait', 'conflict-exit-code'], lf: ['shared', 'exclusive', 'unlock', 'nonblock', 'nb', 'close', 'no-fork', 'verbose'], arg: true },
  chroot: { v: '', f: '', lv: ['userspec', 'groups', 'skip-chdir'], arg: true },
  nsenter: { v: 'tSGCupnimPUTAZ', f: 'aFZ', lv: ['target', 'mount', 'uts', 'ipc', 'net', 'pid', 'user', 'cgroup', 'setuid', 'setgid', 'wd', 'root'] },
  setarch: { f: 'RFZLXBI3', v: '', arg: true },
};
// Keywords and shell openers before the command word. `function NAME {` leaves NAME and `{`, both skipped here.
const LEADERS = new Set(['{', '}', '!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'function', '[[', '((', '&&', '||', ';', '|', '&', '`']);
const nameOf = (w: string): string => commandName(unquote(w));

/** One unambiguous long-option match across a wrapper's value and flag names: its kind, or '' when none or ambiguous. */
function longKind(spec: Spec, n: string): '' | 'v' | 'f' {
  if (spec.lv?.includes(n)) return 'v';
  if (spec.lf?.includes(n)) return 'f';
  const v = (spec.lv ?? []).filter((x) => x.startsWith(n)), f = (spec.lf ?? []).filter((x) => x.startsWith(n));
  return v.length + f.length !== 1 ? '' : v.length ? 'v' : 'f';
}

/** Where the options of the wrapper at `i` end. An option the table does not know sets `unsure`; it is read as taking
 *  the next word only when `valueMode` is set, so the two readings bracket what the option might consume. */
function pastOptions(ws: string[], i: number, spec: Spec, name: string, valueMode: boolean, out: { unsure: boolean }): number {
  for (i++; i < ws.length; ) {
    const t = unquote(ws[i]);
    if (t === '--') return i + 1 + (spec.arg ? 1 : 0);
    if (t === '-' && name === 'env') { i++; continue; } // `env -` is `env -i`
    if (!t.startsWith('-') || t === '-') break;
    if (name === 'nice' && /^-\d+$/.test(t)) { i++; continue; } // nice -5
    if (t.startsWith('--')) {
      const eq = t.indexOf('='), n = t.slice(2, eq < 0 ? undefined : eq);
      const kind = longKind(spec, n);
      if (kind === 'v') i += eq < 0 ? 2 : 1;
      else if (kind === 'f') i++;
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
  if (spec.arg && i < ws.length) i++; // timeout's duration, flock's lockfile, chrt's priority
  else if (spec.mask && i < ws.length && spec.mask.test(unquote(ws[i]))) i++; // taskset's cpu mask
  while (i < ws.length && unquote(ws[i]) === '--') i++; // `timeout 5s -- CMD`, `nice -- CMD`
  return i;
}

/** One segment with its wrappers split off by `;` and the command head reduced to its name, or null when nothing changes. */
function plainSegment(seg: string, valueMode: boolean, out: { unsure: boolean }): string | null {
  const ws = words(seg);
  let i = 0;
  const cuts: number[] = []; // word indices where a wrapper's options ended: a `;` goes before the head after each
  for (;;) {
    while (i < ws.length && (LEADERS.has(ws[i]) || /^\w+=/.test(ws[i]))) i += ws[i] === 'function' ? 2 : 1; // `function NAME {`: skip NAME too
    const name = i < ws.length ? nameOf(ws[i]) : '';
    if (!Object.hasOwn(WRAPPERS, name)) break;
    cuts.push((i = pastOptions(ws, i, WRAPPERS[name], name, valueMode, out)));
  }
  if (i >= ws.length) return null;
  const head = ws[i];
  // The head: a path or quoted spelling is reduced to its name; a word the shell builds at run time is left as written.
  const name = /[/\\'"]/.test(head) && !/[$`*?[{]/.test(unquote(head)) ? nameOf(head) : head;
  if (!cuts.length && name === head) return null;
  // Word offsets in order: only whitespace lies between two words, so each indexOf lands on its own word.
  const offs: number[] = [];
  for (let j = 0; j <= i; j++) offs.push(seg.indexOf(ws[j], j ? offs[j - 1] + ws[j - 1].length : 0));
  let text = '', from = 0;
  for (const c of cuts) [text, from] = [`${text}${seg.slice(from, offs[c]).replace(/\s+$/, '')} ; `, offs[c]];
  return text + seg.slice(from, offs[i]) + name + seg.slice(offs[i] + head.length);
}

/**
 * The command with every segment read plainly (wrappers split off, the command head reduced to its name), so each rule
 * decides it as the plain command and a wrapper option that writes a file (time -o) is still its own segment.
 * Empty when no segment changes. When a wrapper has an option the table does not know, its value can't be told from the
 * command, so two readings come back — the option taking a value, and not — and `unsure` is set; the caller takes the
 * strictest decision across them, so either reading's deny is a deny.
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
