import { expect, test } from 'vitest';
import { CLAIM_PHRASES, findClaim } from '../../src/done/claims.js';

test.each([
  ['Everything is done.', 'done'], ['All tests pass now.', 'all tests pass'], ['The fix is complete and verified.', 'complete'],
  ['Tests are green. Ready to merge.', 'tests are green'], ['Fixed the null check in parse().', 'fixed'], ['It works now!', 'works now'],
  ['See [done](http://x.test) for details', 'done'], ['Not sure. It is done.', 'done'], ['all done', 'done'], ['done.', 'done'],
  ['ALL TESTS PASS', 'all tests pass'], ['It is done.\r\nThanks.', 'done'],
])('claims: %j', (t, p) => expect(findClaim(t)).toBe(p));
test.each([
  'not done', 'This will be done after review.', "The bug isn't fixed yet.", 'Once all tests pass, I will open the PR.', 'Done?',
  'When it is finished, run verify.', 'I have not finished the migration.', 'Run `done` to exit.', '```\ndone\n```', 'The label says "done".',
  'It is done yet', 'It is undone.', 'completeness matters', 'Text\n```\ndone, all tests pass\nstill code', 'Done?\r\n', 'The label says “done”.',
])('no claim: %j', (t) => expect(findClaim(t)).toBeNull());

test('a negation in an earlier sentence does not suppress a later claim', () => expect(findClaim('Not yet. Now it is done.')).toBe('done'));
test('a negation before a comma only covers its own clause', () => expect(findClaim('Not sure, but fixed.')).toBe('fixed'));
test('input is capped at the last 64 KiB: the end is kept', () => {
  expect(findClaim(`${'x '.repeat(40000)}done.`)).toBe('done');
  expect(findClaim(`Done. ${'x '.repeat(40000)}`)).toBeNull(); // a claim only in the first part of a message over 64 KiB is not seen
  expect(findClaim(`\`\`\`\n${'x\n'.repeat(40000)}\`\`\`\nDone.`)).toBe('done'); // strip runs on the whole text, so a fence cut by the cap can't swallow the claim
  expect(CLAIM_PHRASES).toContain('ready to merge');
});
