// `harness remember`'s argument parser, shared by the CLI and the guard so both read the same words the same way
// (a flag's value is never read as a flag). A leaf module: no harness imports.
export interface Flags { values: Map<string, string[]>; switches: Set<string>; rest: string[] }

/** Each write subcommand's value flags and switches, as the CLI parses them. */
export const REMEMBER_SPECS: Record<string, { valued: string[]; switches: string[] }> = {
  add: { valued: ['--title', '--rule', '--why', '--path', '--supersedes'], switches: ['--quoted', '--dry-run', '--yes'] },
  confirm: { valued: [], switches: ['--dry-run', '--yes'] },
  retire: { valued: ['--by'], switches: ['--dry-run', '--yes'] },
  sync: { valued: [], switches: ['--dry-run', '--yes'] },
};

/** null for a usage error: an unknown flag, a repeated switch, or a value flag with no value. */
export function parseFlags(args: string[], valued: string[], switches: string[]): Flags | null {
  const f: Flags = { values: new Map(), switches: new Set(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[++i];
      if (v === undefined) return null;
      f.values.set(a, [...(f.values.get(a) ?? []), v]);
    } else if (switches.includes(a)) {
      if (f.switches.has(a)) return null;
      f.switches.add(a);
    } else if (a.startsWith('-')) return null;
    else f.rest.push(a);
  }
  return f;
}

const count = (f: Flags, k: string): number => f.values.get(k)?.length ?? 0;
/** True when the CLI runs these flags (not a usage error) for `sub`. */
export function argsValid(sub: string, f: Flags): boolean {
  if (sub === 'add') return !f.rest.length && count(f, '--title') === 1 && count(f, '--rule') === 1 && count(f, '--why') <= 1 && count(f, '--supersedes') <= 1 && count(f, '--path') > 0;
  if (sub === 'confirm' || sub === 'retire') return f.rest.length === 1 && count(f, '--by') <= 1;
  return sub === 'sync' && !f.rest.length;
}

/** The words after `remember`, parsed as the CLI parses them, or null when the CLI would print its usage. */
export function parseRemember(args: string[]): { sub: string; flags: Flags } | null {
  const [sub = '', ...rest] = args;
  const spec = REMEMBER_SPECS[sub];
  const flags = spec ? parseFlags(rest, spec.valued, spec.switches) : null;
  return flags && argsValid(sub, flags) ? { sub, flags } : null;
}

/** The forms that write nothing: `list`, `check`, `--help`, and a write subcommand with a real `--dry-run` or
 *  `--help` switch (the CLI prints its usage for `--help`). A flag's value never counts as a switch. */
export function rememberReadOnly(args: string[]): boolean {
  const [sub = '', ...rest] = args;
  if (sub === 'list' || sub === 'check' || sub === '--help') return true;
  const spec = REMEMBER_SPECS[sub];
  const f = spec ? parseFlags(rest, spec.valued, [...spec.switches, '--help']) : null;
  return !!f && (f.switches.has('--dry-run') || f.switches.has('--help'));
}
