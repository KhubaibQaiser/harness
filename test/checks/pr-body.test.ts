import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bodyProblems, decidePrBody, HEADINGS, MARKER } from '../../src/checks/pr-body.js';
import { registry } from '../../src/hooks/dispatch.js';
import { makeRepo } from '../install/helpers.js';
import { ctx } from './pr-size/helpers.js';

const skill = readFileSync('templates/skills/pr-ship/SKILL.md', 'utf8');
const template = /```markdown\n([\s\S]*?)\n```/.exec(skill)![1]!;
const filled = (human = 'None.') => [MARKER, ...HEADINGS.map((h) => `## ${h}\n\n${h === HEADINGS[8] ? human : 'not run: no app in this repo'}\n`)].join('\n');
const USE = "Write the body from the pr-ship skill's template to a file and pass --body-file <file>.";
const LABEL = 'the "Human steps before merge or deploy" section lists steps, so the PR needs the needs-human label (`--label needs-human` on create, `--add-label needs-human` on edit); never auto-merge or auto-deploy it';
const reason = (d: ReturnType<typeof decidePrBody>) => ('reason' in d ? d.reason : '');

describe('the template in pr-ship', () => {
  test('carries the marker and every heading, in order', () => {
    expect(template.startsWith(MARKER)).toBe(true);
    expect([...template.matchAll(/^## (.+?)(?: <!--.*-->)?$/gm)].map((m) => m[1])).toEqual(HEADINGS);
  });

  test('unfilled, every section is empty (its guidance is comments only)', () => {
    expect(bodyProblems(template, [])).toEqual([`empty sections: ${HEADINGS.join(', ')} (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`]);
  });
});

describe('bodyProblems', () => {
  test('a body without the marker is a problem, whatever else it has', () => {
    expect(bodyProblems('## Summary\n\nfixes a bug\n', [])![0]).toBe("the body doesn't use the pr-ship template (its `<!-- harness:pr-body -->` line is missing)");
    expect(bodyProblems(filled().replace(MARKER, ''), [])).toHaveLength(1);
  });

  test('a filled body with "None." needs no label', () => {
    expect(bodyProblems(filled(), [])).toEqual([]);
  });

  test('missing headings are listed', () => {
    expect(bodyProblems(filled().replace('## Security\n', '').replace('## Screenshots\n', ''), [])).toEqual(['missing sections: Screenshots, Security']);
  });

  test('human steps need the needs-human label', () => {
    const body = filled('- Run `pnpm db:migrate` on prod before deploy (owner: DBA).');
    expect(bodyProblems(body, ['bug'])).toEqual([LABEL]);
    expect(bodyProblems(body, ['bug', 'needs-human'])).toEqual([]);
  });

  test('"None" must be the whole section; anything more counts as steps', () => {
    expect(bodyProblems(filled('None'), [])).toEqual([]);
    expect(bodyProblems(filled('None, except the secret rotation.'), [])).toEqual([LABEL]);
  });

  test('CRLF bodies parse the same', () => {
    expect(bodyProblems(filled().replace(/\n/g, '\r\n'), [])).toEqual([]);
  });
});

describe('decidePrBody', () => {
  const root = () => {
    const r = makeRepo({ 'README.md': 'hi\n' }, { git: false });
    writeFileSync(join(r, 'ok.md'), filled());
    writeFileSync(join(r, 'steps.md'), filled('Run the migration first.'));
    writeFileSync(join(r, 'plain.md'), 'just a body\n');
    return r;
  };
  const d = (r: string, cmd: string, unattended = false) => decidePrBody(ctx(r, cmd, { unattended }));

  test('a filled template passes; human steps pass only with the label, on create and on edit', () => {
    const r = root();
    expect(d(r, 'gh pr create --base main --body-file ok.md')).toEqual({ kind: 'allow' });
    expect(d(r, `gh pr create -F ${join(r, 'ok.md')}`)).toEqual({ kind: 'allow' });
    expect(reason(d(r, 'gh pr create --body-file steps.md'))).toBe(`PR body: ${LABEL}. ${USE}`);
    expect(d(r, 'gh pr create --body-file steps.md -l bug,needs-human')).toEqual({ kind: 'allow' });
    expect(d(r, 'gh pr create --body-file=steps.md --label=needs-human')).toEqual({ kind: 'allow' });
    expect(d(r, 'gh pr edit 7 --body-file steps.md')).toMatchObject({ kind: 'deny', check: 'pr-body' });
    expect(d(r, 'gh pr edit 7 --body-file steps.md --add-label needs-human')).toEqual({ kind: 'allow' });
  });

  test('every agent create must use the template: an ordinary body, no body, --fill and --web are denied', () => {
    const r = root();
    expect(reason(d(r, 'gh pr create --body-file plain.md'))).toMatch(/^PR body: the body doesn't use the pr-ship template/);
    expect(reason(d(r, 'gh pr create -b "fixes a bug"'))).toMatch(/^PR body: the body doesn't use the pr-ship template/);
    for (const c of ['gh pr create', 'gh pr create --title t', 'gh pr create --web', 'gh pr create -T .github/pull_request_template.md'])
      expect(reason(d(r, c)), c).toBe(`PR body: this gh pr create has no --body or --body-file. ${USE}`);
    for (const c of ['gh pr create --fill', 'gh pr create -f', 'gh pr create --fill-first', 'gh pr create -fw', 'gh pr create --fill-verbose --body-file ok.md'])
      expect(reason(d(r, c)), c).toBe(`PR body: --fill takes the body from the commits, not the pr-ship template. ${USE}`);
    expect(d(r, 'gh pr create --title "--fill" --body-file ok.md')).toEqual({ kind: 'allow' });
  });

  test('a body it cannot read fails closed', () => {
    const r = root();
    mkdirSync(join(r, 'sub'));
    expect(reason(d(r, 'gh pr create --body-file -'))).toBe(`PR body: a body read from stdin (--body-file -) can't be checked. ${USE}`);
    expect(reason(d(r, 'gh pr create --body-file /dev/stdin'))).toBe(`PR body: /dev/stdin is not a regular file of at most 1 MB, so it can't be checked. ${USE}`);
    expect(reason(d(r, 'gh pr create --body-file sub'))).toMatch(/sub is not a regular file/);
    expect(reason(d(r, 'gh pr create --body-file nope.md'))).toBe(`PR body: there is no body file at ${join(r, 'nope.md')}. ${USE}`);
    expect(reason(d(r, 'cd sub && gh pr create --body-file ok.md'))).toBe(`PR body: the command changes directory, so the relative --body-file ok.md can't be resolved; pass an absolute path. ${USE}`);
    expect(d(r, `cd sub && gh pr create --body-file ${join(r, 'ok.md')}`)).toEqual({ kind: 'allow' });
    expect(reason(d(r, 'gh pr create --body "$(cat ok.md)"'))).toBe(`PR body: an inline --body built by a substitution can't be checked. ${USE}`);
    for (const c of ['$GH pr create --body-file ok.md', 'eval "gh pr create --body-file ok.md"'])
      expect(reason(d(r, c)), c).toBe(`PR body: harness can't read the arguments of this gh pr create (a variable, eval or substitution runs it). ${USE}`);
  });

  test('gh pr edit without a body change is not checked', () => {
    expect(d(root(), 'gh pr edit 7 --add-label bug --title x')).toEqual({ kind: 'allow' });
  });

  test('gh pr merge --auto is denied; a plain merge is left to the guard', () => {
    const r = root();
    for (const c of ['gh pr merge 7 --auto --squash', 'gh pr merge --auto', 'gh -R o/r pr merge 7 --auto', 'gh pr merge 7 --auto=true'])
      expect(reason(d(r, c)), c).toMatch(/^gh pr merge --auto lets GitHub merge with no person at the moment of merge/);
    expect(d(r, 'gh pr merge 7 --squash')).toEqual({ kind: 'allow' });
    expect(d(r, 'gh pr merge 7 --disable-auto')).toEqual({ kind: 'allow' });
    expect(d(r, 'gh pr merge 7 --subject "--auto"')).toEqual({ kind: 'allow' });
  });

  test('unattended denies the same; checks.prBody false allows; checks.prSize false keeps it on', () => {
    const r = root();
    expect(decidePrBody(ctx(r, 'gh pr create --body-file steps.md', { unattended: true })).kind).toBe('deny');
    expect(decidePrBody(ctx(r, 'gh pr create', { config: (c) => (c.checks.prBody = false) }))).toEqual({ kind: 'allow' });
    expect(decidePrBody(ctx(r, 'gh pr create', { config: (c) => (c.checks.prSize = false) })).kind).toBe('deny');
    expect(decidePrBody(ctx(r, 'gh pr create', { tool: 'Edit' }))).toEqual({ kind: 'allow' });
  });

  test('the check is registered', () => {
    expect(registry.map((c) => c.name)).toContain('pr-body');
  });
});

test('a heredoc body or a substituted file name fails closed too', () => {
  const r = makeRepo({ 'README.md': 'hi\n' }, { git: false });
  expect(reason(decidePrBody(ctx(r, `gh pr create --body "$(cat <<'EOF'\n${filled()}\nEOF\n)"`)))).toMatch(/^PR body: an inline --body built by a substitution/);
  expect(reason(decidePrBody(ctx(r, 'gh pr create --body-file "$(mktemp)"')))).toMatch(/^PR body: a --body-file named by a substitution/);
});
