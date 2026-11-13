import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { bodyProblems, decidePrBody, HEADINGS, MARKER } from '../../src/checks/pr-body.js';
import { loadConfig } from '../../src/core/config.js';
import { validateConfig } from '../../src/core/config-io.js';
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

  test('says what to write when screenshots are not captured, and makes the body file with harness workdir', () => {
    expect(skill).toContain("not captured: browser capture isn't set up for this repo yet");
    expect(skill).not.toContain('M2b');
    expect(skill).toContain('harness workdir');
  });
});

describe('bodyProblems', () => {
  test('a body without the marker is a problem, whatever else it has', () => {
    expect(bodyProblems('## Summary\n\nfixes a bug\n', [])).toEqual(["the body doesn't use the pr-ship template (its `<!-- harness:pr-body -->` line is missing)"]);
    expect(bodyProblems(filled().replace(MARKER, ''), [])).toHaveLength(1);
  });

  test('a filled body with "None." needs no label; CRLF parses the same', () => {
    expect(bodyProblems(filled(), [])).toEqual([]);
    expect(bodyProblems(filled().replace(/\n/g, '\r\n'), [])).toEqual([]);
  });

  test('missing and duplicate headings are listed', () => {
    expect(bodyProblems(filled().replace('## Security\n', '').replace('## Screenshots\n', ''), [])).toEqual(['missing sections: Screenshots, Security']);
    expect(bodyProblems(`${filled()}\n## ${HEADINGS[8]}\n\nRun migration X on prod.\n`, [])).toEqual([`duplicate sections: ${HEADINGS[8]}`]);
    expect(bodyProblems(`${filled()}\n\`\`\`\n## Summary\n\`\`\`\n`, [])).toEqual(['duplicate sections: Summary']);
  });

  test('whitespace-only or punctuation-only sections are empty', () => {
    expect(bodyProblems(filled().replace('not run: no app in this repo', '   \n\t'), [])).toEqual([`empty sections: Summary (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)`]);
    expect(bodyProblems(filled().replaceAll('not run: no app in this repo', '-'), [])![0]).toMatch(/^empty sections: Summary, What changed and why/);
  });

  test('an unclosed comment hides the rest of the body, as GitHub does', () => {
    expect(bodyProblems(filled().replace('## Performance\n\nnot run: no app in this repo', '## Performance <!-- todo'), [])).toEqual([
      'missing sections: Security, Human steps before merge or deploy, Not verified and known limits',
      'empty sections: Performance (write "not run: <reason>" or "n/a: <reason>" rather than leave one empty)',
    ]);
  });

  test('only exactly "None." means no human steps; anything else needs the label', () => {
    for (const h of ['None', 'NONE', 'None. but run migration X', 'None. <!-- run migration X before deploy -->', 'None, except the secret rotation.', 'Run migration X.'])
      expect(bodyProblems(filled(h), ['bug']), h).toEqual([LABEL]);
    expect(bodyProblems(filled('Run migration X.'), ['bug', 'needs-human'])).toEqual([]);
    expect(bodyProblems(filled('Run migration X.'), ['Needs-Human'])).toEqual([LABEL]);
  });
});

describe('decidePrBody', () => {
  const S = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'pr-body-out-'));
  const root = () => {
    const r = makeRepo({ 'README.md': 'hi\n' }, { git: false });
    writeFileSync(join(r, 'ok.md'), filled());
    writeFileSync(join(r, 'steps.md'), filled('Run the migration first.'));
    writeFileSync(join(r, 'evil.md'), 'just a body\n');
    execFileSync('mkfifo', [join(r, 'fifo')]);
    symlinkSync(join(r, 'fifo'), join(r, 'tofifo.md'));
    symlinkSync('/dev/stdin', join(r, 'tostdin.md'));
    mkdirSync(join(r, 'sub'));
    return r;
  };
  const r = root();
  writeFileSync(join(S, 'outside.md'), filled());
  const d = (cmd: string, o: Parameters<typeof ctx>[2] = {}) => decidePrBody(ctx(r, cmd, o));

  test.each([
    'gh pr create --base main --body-file ok.md', `gh pr create -F ${join(r, 'ok.md')}`, 'gh pr new --body-file ok.md', 'gh pr create -R other/repo --body-file ok.md',
    'gh pr create --body-file steps.md -l bug,needs-human', 'gh pr create --body-file=steps.md --label=needs-human', 'gh pr create --body-file steps.md -lneeds-human',
    'gh pr create --body-file steps.md --label needs-human,other', 'gh pr edit 7 --body-file steps.md --add-label needs-human', 'gh pr edit 7 --add-label bug --title x',
    'gh pr create --title "--fill" --body-file ok.md', `gh pr create --body-file ${join(S, 'outside.md')}`, 'gh pr merge 7 --squash', 'gh pr merge 7 --disable-auto', 'gh pr merge 7 -A',
    'bash -c "gh pr create --body-file ok.md"',
  ])('%s is allowed', (c) => {
    expect(d(c)).toEqual({ kind: 'allow' });
  });

  test.each([
    ['gh pr create --body-file evil.md', /^PR body: the body doesn't use the pr-ship template/],
    ['gh pr new --body-file evil.md', /^PR body: the body doesn't use the pr-ship template/],
    ['gh pr create -Fevil.md', /^PR body: the body doesn't use/],
    ['gh pr create --body-file=evil.md', /^PR body: the body doesn't use/],
    ['gh pr create -R other/repo --body-file evil.md', /^PR body: the body doesn't use/],
    ['gh pr edit 7 -F evil.md', /^PR body: the body doesn't use/],
    ['gh pr create --body-file steps.md', /lists steps, so the PR needs the needs-human label/],
    ['gh pr create --body-file steps.md --label Needs-Human', /lists steps/],
    ['gh pr edit 7 --body-file steps.md', /lists steps/],
    ['gh pr create', /^PR body: this gh pr create has no --body-file\./],
    ['gh pr create --web', /has no --body-file/],
    ['gh pr create -T .github/pull_request_template.md', /has no --body-file/],
    ['gh pr new --title t', /^PR body: this gh pr new has no --body-file/],
    ['gh pr create --fill', /^PR body: --fill takes the body from the commits/],
    ['gh pr create -f', /--fill takes/], ['gh pr create -fw', /--fill takes/], ['gh pr create --fill-first', /--fill takes/], ['gh pr create --fill-verbose --body-file ok.md', /--fill takes/],
    ['gh pr create -b hi', /^PR body: an inline --body can never carry the filled pr-ship template/],
    ['gh pr create --body=hi', /inline --body can never/],
    [`gh pr create --body "${filled().replaceAll('`', '')}"`, /inline --body can never/],
    ['gh pr create --body-file ok.md -F evil.md', /^PR body: this gh pr create has more than one --body or --body-file/],
    ['gh pr create -F ok.md --body-file evil.md', /more than one/], ['gh pr create --body-file ok.md --body-file evil.md', /more than one/], ['gh pr create --body x -b y', /more than one/],
    ['gh pr create --body-file ok.md --recover evil.json', /^PR body: --recover and --editor take the body/], ['gh pr create -e', /--recover and --editor/], ['gh pr edit 7 --editor', /--recover and --editor/],
    ['gh pr create --body-file -', /^PR body: a body read from stdin \(--body-file -\) can't be checked/],
    ['gh pr create --body-file /dev/stdin', /^PR body: \/dev\/stdin is not a regular file of at most 1 MB/],
    ['gh pr create --body-file tofifo.md', /tofifo\.md is not a regular file/], ['gh pr create --body-file tostdin.md', /tostdin\.md is not a regular file/], ['gh pr create --body-file sub', /sub is not a regular file/],
    ['gh pr create --body-file nope.md', /^PR body: there is no body file at /],
    ['gh pr create --body "$(cat ok.md)"', /inline --body can never/],
    [`gh pr create --body "$(cat <<'EOF'\n${filled()}\nEOF\n)"`, /inline --body can never/],
    ['gh pr create --body-file "$(mktemp)"', /^PR body: a --body-file named by a substitution/],
    ['cp evil.md ok.md && gh pr create --body-file ok.md', /^PR body: gh pr create with a --body-file must be the only command on the line/],
    ['printf hi > ok.md; gh pr create --body-file ok.md', /must be the only command/],
    ['cd sub && gh pr create --body-file ok.md', /must be the only command/],
    ['gh pr create --body-file ok.md > ok.md', /must be the only command/], ['gh pr create -F ok.md <ok.md', /must be the only command/],
    ['gh pr create --body-file ok.md 2>&1 | tee ok.md', /must be the only command/],
    ['bash -c "cp evil.md ok.md && gh pr create --body-file ok.md"', /must be the only command/],
    ['$GH pr create --body-file ok.md', /^PR body: harness can't read the arguments of this gh pr command/],
    ['eval "gh pr create --body-file ok.md"', /can't read the arguments/], ['$GH pr edit 7 --body-file evil.md', /can't read the arguments/], ['eval "gh pr edit 7 --body-file evil.md"', /can't read the arguments/],
    ['$GH pr merge 7 --auto', /can't read the arguments/], ['eval "gh pr merge 7 --auto"', /can't read the arguments/],
    ['gh pr edit 7 --remove-label needs-human', /^Only a person removes the needs-human label/], ['gh pr edit 7 --remove-label=bug,needs-human', /^Only a person removes/],
    ['gh pr merge 7 --auto', /^gh pr merge --auto lets GitHub merge with no person/], ['gh pr merge 7 --auto=1', /^gh pr merge --auto/], ['gh pr merge 7 -m --auto', /^gh pr merge --auto/],
    ['gh pr merge 7 -r --auto', /^gh pr merge --auto/], ['gh pr merge 7 -s --auto', /^gh pr merge --auto/], ['gh -R o/r pr merge 7 --auto', /^gh pr merge --auto/],
    ['gh pr merge 7 --subject "--auto"', /^gh pr merge --auto/], ['command gh pr merge 7 --auto', /^gh pr merge --auto/],
    ['gh pr merge 7 --admin', /^gh pr merge --admin skips branch protection/],
  ])('%s is denied', (c, re) => {
    const dec = d(c);
    expect(dec, c).toMatchObject({ kind: 'deny', check: 'pr-body' });
    expect(reason(dec)).toMatch(re);
  });

  test('wrappers still reach the gh command', () => {
    for (const c of ['command gh pr create --body-file evil.md', '/usr/bin/gh pr create --body-file evil.md', 'env gh pr create --body-file evil.md', 'env GH_REPO=o/r gh pr create --body-file evil.md', 'sudo gh pr create --body-file evil.md', 'xargs gh pr create --body-file evil.md', '(gh pr create --body-file evil.md)'])
      expect(d(c).kind, c).toBe('deny');
  });

  test('body reasons end with how to fix it; the label and merge reasons do not', () => {
    expect(reason(d('gh pr create'))).toBe(`PR body: this gh pr create has no --body-file. ${USE}`);
    expect(reason(d('gh pr merge 7 --auto'))).not.toContain(USE);
  });

  test('left to the coming gh-writes ask (documented limits): gh api, hub, aliases, GitLab push options', () => {
    for (const c of ['gh api repos/o/r/pulls -f title=t -f head=x -f base=main -f body=hi', 'hub pull-request -m hi', 'git push -o merge_request.create origin HEAD', 'gh alias set pc "pr create" && gh pc --body-file evil.md', 'gh api -X PUT repos/o/r/pulls/7/merge'])
      expect(d(c), c).toEqual({ kind: 'allow' });
  });

  test('unattended denies the same; checks.prBody false allows; checks.prSize false keeps it on; edits allow', () => {
    expect(d('gh pr create --body-file steps.md', { unattended: true }).kind).toBe('deny');
    expect(d('gh pr create', { config: (c) => (c.checks.prBody = false) })).toEqual({ kind: 'allow' });
    expect(d('gh pr create', { config: (c) => (c.checks.prSize = false) }).kind).toBe('deny');
    expect(d('gh pr create', { tool: 'Edit' })).toEqual({ kind: 'allow' });
  });

  test('the check is registered', () => {
    expect(registry.map((c) => c.name)).toContain('pr-body');
  });
});

describe('checks.prBody follows checks.prSize when the key is missing', () => {
  const load = (checks: string) => {
    const r = makeRepo({ '.harness/config.yaml': `version: 1\nchecks: ${checks}\n` }, { git: false });
    return loadConfig(r);
  };
  test('an install without pr-ship (prSize false) stays off; with it, on; an explicit key wins', () => {
    const off = load('{ guard: true, protect: true, depVerify: true, multiFile: false, tdd: false, stop: true, prSize: false, decisions: true }');
    expect([off.config.checks.prSize, off.config.checks.prBody, off.errors]).toEqual([false, false, []]);
    expect(load('{ prSize: true }').config.checks.prBody).toBe(true);
    expect(load('{ prSize: false, prBody: true }').config.checks.prBody).toBe(true);
    expect(load('{ prSize: true, prBody: false }').config.checks.prBody).toBe(false);
  });
  test('validateConfig (doctor, init) reads it the same way', () => {
    const v = validateConfig({ checks: { prSize: false } });
    expect(v.ok && v.config.checks.prBody).toBe(false);
  });
});
