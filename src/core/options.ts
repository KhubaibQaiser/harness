// One getopt-style reader for every command whose options the guard and protect read: which words are option values
// (and of which option), which are flags, and which are positionals. Each caller gives a table; nothing per tool here.

/** A command's options. `v`: short letters that take a value. `lv`/`lf`: long names that take a value / none. `lo`: long
 *  names whose value is optional (only with `=`). `prefix`: an unambiguous long prefix counts (GNU getopt_long, git).
 *  `single`: single-dash long names that take a value (openssl's `-out`, xxd's `-cols`); `sf`: single-dash long flags (xxd's `-ps`). */
export type OptTable = { v?: string; lv?: readonly string[]; lf?: readonly string[]; lo?: readonly string[]; prefix?: boolean; single?: readonly string[]; sf?: readonly string[] };
export type Parsed = { values: { name: string; value: string }[]; flags: string[]; pos: string[] };

/**
 * Reads `words` (already unquoted) the getopt way. `--name=v` and `--name v` (an unambiguous prefix with `prefix`),
 * `-abv` clusters where a value letter takes the rest of the word or the next word, single-dash long names (`-out F`,
 * `-out=F`, and stuck `-outF`), and `--` ending the options. Options may come after positionals (GNU permutes). Names
 * come back canonical: `-t`, `--target-directory`, `-out`. An unknown short letter is a flag, an unknown long option
 * takes no value; a word `-` alone is a positional.
 * ponytail: an unknown short letter that really takes a value shifts the words after it; tables list each tool's value letters.
 */
export function readOptions(words: readonly string[], t: OptTable): Parsed {
  const out: Parsed = { values: [], flags: [], pos: [] };
  const all = [...(t.lv ?? []), ...(t.lf ?? []), ...(t.lo ?? [])];
  const resolve = (n: string): string | null => {
    if (all.includes(n)) return n;
    if (!t.prefix || !n) return null;
    const m = all.filter((x) => x.startsWith(n));
    return m.length === 1 ? m[0] : null;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { out.pos.push(...words.slice(i + 1)); break; }
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('='), n = resolve(w.slice(2, eq < 0 ? undefined : eq));
      if (n && t.lv?.includes(n)) out.values.push({ name: `--${n}`, value: eq >= 0 ? w.slice(eq + 1) : (words[++i] ?? '') });
      else if (n && t.lo?.includes(n) && eq >= 0) out.values.push({ name: `--${n}`, value: w.slice(eq + 1) });
      else out.flags.push(`--${n ?? w.slice(2, eq < 0 ? undefined : eq)}`);
      continue;
    }
    if (t.sf?.includes(w.slice(1))) { out.flags.push(w); continue; }
    if (t.single?.length && /^-[a-zA-Z]{2,}/.test(w)) {
      const body = w.slice(1), eq = body.indexOf('='), n = eq < 0 ? body : body.slice(0, eq);
      if (t.single.includes(n)) { out.values.push({ name: `-${n}`, value: eq >= 0 ? body.slice(eq + 1) : (words[++i] ?? '') }); continue; }
      const stuck = t.single.filter((s) => body.startsWith(s) && body.length > s.length).sort((a, b) => b.length - a.length)[0];
      if (stuck) { out.values.push({ name: `-${stuck}`, value: body.slice(stuck.length) }); continue; }
    }
    if (/^-[^-]/.test(w)) {
      for (let j = 1; j < w.length; j++) {
        if (t.v?.includes(w[j])) { out.values.push({ name: `-${w[j]}`, value: j < w.length - 1 ? w.slice(j + 1) : (words[++i] ?? '') }); break; }
        out.flags.push(`-${w[j]}`);
      }
      continue;
    }
    out.pos.push(w);
  }
  return out;
}

/** The values `parsed` holds for any of `names` (canonical option names). */
export const valuesOf = (p: Parsed, names: readonly string[]): string[] => p.values.filter((v) => names.includes(v.name)).map((v) => v.value);

/** Words without their redirections (`<f`, `> f`, `2>/dev/null`, `<<<s`): a redirect target is not an argument. */
export function withoutRedirects(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d*|&)(<<<|<<-?|<>|>>|>\||[<>]&?)(.*)$/.exec(words[i]);
    if (!m) out.push(words[i]);
    else if (m[3] === '') i++; // a bare operator: its target is the next word
  }
  return out;
}
