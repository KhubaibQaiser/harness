import { expect, test } from 'vitest';
import { validateProduct } from '../../src/ai/product.js';

const SECTIONS = ['Purpose', 'Users', 'Core features', 'Constraints', 'Non-goals', 'Sources'];
const good = `# Shop\n\n${SECTIONS.map((s) => `## ${s}\n- x\n`).join('\n')}`;

test('a valid file passes', () => expect(validateProduct(good)).toEqual([]));

test('more than 40 lines fails', () => {
  expect(validateProduct(Array(41).fill('## Purpose').join('\n'))).toContain('product.md: 41 lines; at most 40');
});

test.each(SECTIONS)('missing %s fails by name', (s) => {
  expect(validateProduct(good.replace(`## ${s}`, `### ${s}`))).toEqual([`product.md: missing section "## ${s}"`]);
});
