const GITHUB = ['github.com', 'githubusercontent.com'];
const MUST_STAY = [...GITHUB, 'example.com'];
/** A `*.x` entry covers h when h is x or ends with .x; `*` covers everything. */
const covers = (entry: string, h: string): boolean => entry === '*' || entry === h || (entry.startsWith('*.') && (h === entry.slice(2) || h.endsWith(entry.slice(1))));

/** Why a host can't go in stop.allowed_domains, or null. */
export function hostProblem(host: string): string | null {
  const e = host.toLowerCase();
  const base = e.replace(/^\*\./, '');
  const bad = MUST_STAY.some((h) => covers(e, h)) || GITHUB.some((g) => base.endsWith(`.${g}`));
  return bad ? `can't list ${host}: GitHub is reachable only in runs that push (harness-run --push), and example.com must stay unreachable for the container check` : null;
}
