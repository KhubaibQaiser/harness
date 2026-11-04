const SECTIONS = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'];
const MAX_LINES = 40;

/** Errors for the product.md the interview writes: at most 40 lines and every required `## ` section. */
export function validateProduct(text: string): string[] {
  const lines = text.replace(/\n+$/, '').split(/\r?\n/);
  const errors: string[] = [];
  if (lines.length > MAX_LINES) errors.push(`product.md: ${lines.length} lines; at most ${MAX_LINES}`);
  const have = new Set(lines.map((l) => /^## (.+?)\s*$/.exec(l)?.[1]));
  for (const s of SECTIONS) if (!have.has(s)) errors.push(`product.md: missing section "## ${s}"`);
  return errors;
}
