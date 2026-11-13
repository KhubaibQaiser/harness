import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { bodyProblems, HEADINGS, MARKER } from '../../../src/checks/pr-size/body.js';

const skill = readFileSync('templates/skills/pr-ship/SKILL.md', 'utf8');
const template = /```markdown\n([\s\S]*?)\n```/.exec(skill)![1]!;
const filled = (human = 'None.') => [MARKER, ...HEADINGS.map((h) => `## ${h}\n\n${h === HEADINGS[8] ? human : 'not run: no app in this repo'}\n`)].join('\n');

describe('the template in pr-ship', () => {
  test('carries the marker and every heading, in order', () => {
    expect(template.startsWith(MARKER)).toBe(true);
    const found = [...template.matchAll(/^## (.+?)(?: <!--.*-->)?$/gm)].map((m) => m[1]);
    expect(found).toEqual(HEADINGS);
  });

  test('unfilled, every section is empty (its guidance is comments only)', () => {
    expect(bodyProblems(template, [])).toEqual([`empty sections: ${HEADINGS.join(', ')} (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`]);
  });
});

describe('bodyProblems', () => {
  test('a body without the marker or the human-steps heading is not checked', () => {
    expect(bodyProblems('## Summary\n\nfixes a bug\n', [])).toBeNull();
  });

  test('a filled body with "None." needs no label', () => {
    expect(bodyProblems(filled(), [])).toEqual([]);
  });

  test('missing headings are listed', () => {
    const body = filled().replace('## Security\n', '').replace('## Screenshots\n', '');
    expect(bodyProblems(body, [])).toEqual(['missing sections: Screenshots, Security']);
  });

  test('human steps without the needs-human label are refused; with it they pass', () => {
    const body = filled('- Run `pnpm db:migrate` on prod before deploy (owner: DBA).');
    expect(bodyProblems(body, ['bug'])).toEqual([
      'the "Human steps before merge or deploy" section lists steps, so the PR needs `--label needs-human`; never auto-merge or auto-deploy it',
    ]);
    expect(bodyProblems(body, ['bug', 'needs-human'])).toEqual([]);
  });

  test('the human-steps heading alone (marker removed) still turns the check on', () => {
    expect(bodyProblems(filled('Set FLAG_X=on').replace(MARKER, ''), [])).toHaveLength(1);
  });

  test('"None" must be the whole section; anything more counts as steps', () => {
    expect(bodyProblems(filled('None'), [])).toEqual([]);
    expect(bodyProblems(filled('None, except the secret rotation.'), [])).toHaveLength(1);
  });

  test('CRLF bodies parse the same', () => {
    expect(bodyProblems(filled().replace(/\n/g, '\r\n'), [])).toEqual([]);
  });
});
