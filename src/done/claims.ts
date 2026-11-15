// Done-claim phrase matcher (spec §4.3). Pure: no I/O. Only flags a plain first-person claim; negated, future, question and quoted uses are not claims.
export const CLAIM_PHRASES: readonly string[] = [
  'done', 'finished', 'complete', 'completed', 'fixed', 'resolved', 'all tests pass', 'all tests passed', 'all tests passing',
  'tests are green', 'verified', 'works now', 'ready to merge',
];

const MAX_INPUT = 64 * 1024;
const NEG = /\b(not|never|no|nothing|yet|until|unless|once|when|after|before|if|will|would|should|could|might|may|going to|to be)\b|n't\b/i;
const PHRASE_RES = CLAIM_PHRASES.map((p) => [p, new RegExp(`\\b${p.replace(/ /g, '\\s+')}\\b`, 'gi')] as const);

/** The first claim phrase (in list order, first sentence that has one) or null. */
export function findClaim(text: string): string | null {
  const prose = text.slice(0, MAX_INPUT)
    .replace(/```[\s\S]*?(```|$)/g, ' ') // an unterminated fence swallows the rest
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  for (const raw of prose.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s || s.endsWith('?')) continue;
    for (const [phrase, re] of PHRASE_RES) {
      for (const m of s.matchAll(re)) {
        const clause = s.slice(0, m.index).split(/[,;:]/).pop()!;
        if (!NEG.test(clause) && !/^\s+yet\b/i.test(s.slice(m.index + m[0].length))) return phrase;
      }
    }
  }
  return null;
}
