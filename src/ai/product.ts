const SECTIONS = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'];
const MAX_LINES = 40;
// Not \t \n \r. The text reaches the terminal in the update diff.
export const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

/** Errors for the product.md the interview writes: at most 40 lines and every required `## ` section. */
export function validateProduct(text: string): string[] {
  const lines = text.replace(/\n+$/, '').split(/\r?\n/);
  const errors: string[] = [];
  if (lines.length > MAX_LINES) errors.push(`product.md: ${lines.length} lines; at most ${MAX_LINES}`);
  if (RAW_CONTROL.test(text)) errors.push('product.md: must not contain control characters');
  const have = new Set(lines.map((l) => /^## (.+?)\s*$/.exec(l)?.[1]));
  for (const s of SECTIONS) if (!have.has(s)) errors.push(`product.md: missing section "## ${s}"`);
  return errors;
}
