// The pr-ship PR body template (templates/skills/pr-ship/SKILL.md holds the same text; a test pins the two together).
export const MARKER = '<!-- harness:pr-body -->';
export const HEADINGS = [
  'Summary', 'What changed and why', 'Alternatives considered', 'How to review', 'How to verify', 'Screenshots', 'Performance', 'Security',
  'Human steps before merge or deploy', 'Not verified and known limits',
];
const HUMAN = HEADINGS[8]!;
export const NEEDS_HUMAN = 'needs-human';

/** The problems of a templated body, or null when the body does not use the template (neither the marker nor the
 *  human-steps heading), so ordinary PR bodies are never checked. Never echoes body text: it may hold secrets. */
export function bodyProblems(text: string, labels: string[]): string[] | null {
  const raw = text.replace(/\r\n?/g, '\n');
  const t = raw.replace(/<!--[\s\S]*?-->/g, ''); // the template's guidance is comments, on or under each heading
  if (!raw.includes(MARKER) && !new RegExp(`^## ${HUMAN}\\s*$`, 'm').test(t)) return null;
  const sections = new Map<string, string>();
  // ponytail: a `## ` line inside a code fence also starts a section; the template has no fences.
  for (const part of t.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    if (!sections.has(head)) sections.set(head, (nl < 0 ? '' : part.slice(nl)).trim());
  }
  const missing = HEADINGS.filter((h) => !sections.has(h));
  const empty = HEADINGS.filter((h) => sections.get(h) === '');
  const out: string[] = [];
  if (missing.length) out.push(`missing sections: ${missing.join(', ')}`);
  if (empty.length) out.push(`empty sections: ${empty.join(', ')} (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`);
  const steps = sections.get(HUMAN);
  if (steps && !/^none\.?$/i.test(steps) && !labels.includes(NEEDS_HUMAN)) {
    out.push(`the "${HUMAN}" section lists steps, so the PR needs \`--label ${NEEDS_HUMAN}\`; never auto-merge or auto-deploy it`);
  }
  return out;
}
