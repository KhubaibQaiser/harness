import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { addBody, DECISIONS_DIR, globProblem, isDecisionText, parseDecision, SCHEMA, serializeDecision, slugId, type TeamDecision } from '../../src/core/decision-file.js';

const ID = '2026-11-03-validate-env-with-zod';
const REL = `${DECISIONS_DIR}/${ID}.md`;
const TODAY = '2026-11-10';
const FIXTURE = readFileSync(join(__dirname, '../fixtures/decisions', `${ID}.md`), 'utf8');
const BODY = addBody('Parse every environment variable through `src/env/schema.ts`; never read `process.env` elsewhere.', 'Two outages came from typos in env names that nothing checked.');
const BASE: Omit<TeamDecision, 'rel'> = {
  id: ID,
  title: 'Validate env with zod',
  status: 'active',
  paths: ['src/env/**', 'src/config.ts'],
  verified_at: '4f0c2a9e1b7d3c5a6e8f0a1b2c3d4e5f6a7b8c9d',
  verified_on: '2026-11-03',
  body: BODY,
};

// Build a file from BASE with fields overridden; `undefined` drops a key.
const file = (over: Record<string, unknown> = {}, rel = REL) => {
  const text = serializeDecision({ ...BASE, ...over } as Omit<TeamDecision, 'rel'>);
  return parseDecision(rel, text, TODAY);
};
const errorsOf = (over: Record<string, unknown>, rel = REL) => file(over, rel).errors;
// Replace one frontmatter line of the fixture.
const edit = (from: RegExp, to: string) => parseDecision(REL, FIXTURE.replace(from, to), TODAY);

describe('parseDecision', () => {
  test('the fixture parses to the spec example', () => {
    const r = parseDecision(REL, FIXTURE, TODAY);
    expect(r.errors).toEqual([]);
    expect(r.decision).toEqual({ ...BASE, body: BODY + '\n', rel: REL });
  });
  test('serializeDecision writes the fixture bytes', () => expect(serializeDecision(BASE)).toBe(FIXTURE));
  test('a file without the schema line is not a decision', () => {
    const adr = '---\ntitle: Use Postgres\nstatus: accepted\n---\n# ADR 1\n';
    expect(isDecisionText(adr)).toBe(false);
    expect(parseDecision(`${DECISIONS_DIR}/0001-postgres.md`, adr, TODAY)).toEqual({ decision: null, errors: [] });
    expect(parseDecision(`${DECISIONS_DIR}/README.md`, '# Decisions\nschema: harness-decision/1\n', TODAY)).toEqual({ decision: null, errors: [] });
  });
  test('isDecisionText sees the schema line even when the YAML is broken', () => {
    expect(isDecisionText(FIXTURE)).toBe(true);
    expect(isDecisionText(FIXTURE.replace(/\n/g, '\r\n'))).toBe(true);
    const broken = FIXTURE.replace('title: Validate env with zod', 'title: [unclosed');
    expect(isDecisionText(broken)).toBe(true);
    expect(parseDecision(REL, broken, TODAY)).toEqual({ decision: null, errors: [`${REL}: frontmatter must be valid YAML`] });
  });
  test('other YAML spellings of the schema key count', () => {
    for (const line of ['"schema": harness-decision/1', "'schema': 'harness-decision/1'", 'schema: !!str harness-decision/1', '? schema\n: harness-decision/1']) {
      const t = FIXTURE.replace(/^schema: .*$/m, line);
      expect(isDecisionText(t)).toBe(true);
      expect(parseDecision(REL, t, TODAY).errors).toEqual([]);
    }
  });
  test('broken or oversized frontmatter that mentions schema in any spelling is reported, not ignored', () => {
    for (const line of ['schema: >-\n  harness-decision/1', 'schema: !!str harness-decision/1', '? schema\n: harness-decision/1', 'schema : harness-decision/1', '  schema: harness-decision/1', '{schema: harness-decision/1}', 'Schema: harness-decision/1', 'x: "SCHEMA"']) {
      const t = `---\n${line}\ntitle: [unclosed\n---\nbody\n`;
      expect(isDecisionText(t), line).toBe(true);
      expect(parseDecision(REL, t, TODAY).errors, line).toEqual([`${REL}: frontmatter must be valid YAML`]);
    }
    const big = `---\nschema: harness-decision/1\nnotes: ${'x'.repeat(40 * 1024)}\n---\nbody\n`;
    expect(parseDecision(REL, big, TODAY).errors).toEqual([`${REL}: file must be at most 32768 bytes`]);
  });
  test('broken frontmatter with no schema mention is not a decision', () => {
    expect(parseDecision(`${DECISIONS_DIR}/0002-adr.md`, '---\ntitle: [unclosed\n---\nbody\n', TODAY)).toEqual({ decision: null, errors: [] });
  });
  test('a huge non-decision file is still ignored', () => {
    const adr = `---\ntitle: ADR\nnotes: ${'x'.repeat(64 * 1024)}\n---\nbody\n`;
    expect(parseDecision(`${DECISIONS_DIR}/0001-adr.md`, adr, TODAY)).toEqual({ decision: null, errors: [] });
  });
  test('a YAML warning is invalid YAML and prints nothing', () => {
    const warn = vi.spyOn(process, 'emitWarning');
    const write = vi.spyOn(process.stderr, 'write');
    try {
      const t = FIXTURE.replace(/^status: active$/m, 'status: !evil "\u001b]0;pwn\u0007"');
      expect(parseDecision(REL, t, TODAY)).toEqual({ decision: null, errors: [`${REL}: frontmatter must be valid YAML`] });
      expect(isDecisionText(t)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      write.mockRestore();
    }
  });
  test('schema must be exact: a quoted value counts, another version is not a decision', () => {
    expect(edit(/^schema: .*$/m, 'schema: "harness-decision/1"').errors).toEqual([]);
    expect(edit(/^schema: .*$/m, 'schema: harness-decision/2')).toEqual({ decision: null, errors: [] });
  });
  test('an unknown key is an error, and its name is shown safely', () => {
    expect(edit(/^status: active$/m, 'status: active\nowner: me').errors).toEqual([`${REL}: owner must not be here (unknown key)`]);
    expect(edit(/^status: active$/m, 'status: active\n"\\e[31m": x').errors).toEqual([`${REL}: ?[31m must not be here (unknown key)`]);
  });
  test('id must equal the file name', () => {
    expect(errorsOf({}, `${DECISIONS_DIR}/2026-11-03-other.md`)).toEqual([`${DECISIONS_DIR}/2026-11-03-other.md: id must equal the file name without .md`]);
    expect(errorsOf({}, `docs/other/${ID}.md`)).toEqual([`docs/other/${ID}.md: id must equal the file name without .md`]);
  });
  test('id must be a safe file-name segment', () => {
    for (const id of ['2026-11-03-Upper', '2026-11-03-a/b', '2026-11-03-a.b', '../2026-11-03-x', '2026-11-03-', 'x-2026-11-03-a', `2026-11-03-${'a'.repeat(41)}`]) {
      expect(errorsOf({ id }, `${DECISIONS_DIR}/${id}.md`)).toContain(`${DECISIONS_DIR}/${id}.md: id must match YYYY-MM-DD-<slug of a-z, 0-9 and ->`);
    }
    expect(errorsOf({ id: `${ID}-2` }, `${DECISIONS_DIR}/${ID}-2.md`)).toEqual([]);
  });
  test('the id date is a real calendar date and the slug has no -- or trailing -', () => {
    for (const id of ['9999-99-99-x', '2026-02-30-x', '2026-11-03--', '2026-11-03-a--b', '2026-11-03-a-']) {
      expect(errorsOf({ id }, `${DECISIONS_DIR}/${id}.md`)).toEqual([`${DECISIONS_DIR}/${id}.md: id must match YYYY-MM-DD-<slug of a-z, 0-9 and ->`]);
    }
  });
  test('the shown file name drops control characters', () => {
    expect(errorsOf({}, `${DECISIONS_DIR}/a\u001b[2Jb.md`)).toEqual([`${DECISIONS_DIR}/a?[2Jb.md: id must equal the file name without .md`]);
  });
  test('title is 1 to 80 characters on one line', () => {
    const msg = `${REL}: title must be one line of 1 to 80 characters`;
    expect(errorsOf({ title: 'x'.repeat(80) })).toEqual([]);
    expect(errorsOf({ title: 'x'.repeat(81) })).toEqual([msg]);
    expect(errorsOf({ title: '' })).toEqual([msg]);
    expect(errorsOf({ title: 'two\nlines' })).toEqual([msg]);
    expect(errorsOf({ title: 'tab\tbell\u0007' })).toEqual([msg]);
    expect(errorsOf({ title: 'sep\u2028x' })).toEqual([msg]);
    for (const c of ['\u202e', '\u200b', '\u2066', '\u2060', '\ufeff', '\u001b']) expect(errorsOf({ title: `ok${c}evil` })).toEqual([msg]);
    expect(edit(/^title: .*$/m, 'title: 42').errors).toEqual([msg]);
  });
  test('a title that looks like YAML is quoted and round-trips', () => {
    const r = file({ title: 'a: b # c' });
    expect(r.errors).toEqual([]);
    expect(r.decision?.title).toBe('a: b # c');
  });
  test('the body refuses control and invisible format characters, by field and without echoing them', () => {
    for (const c of ['\u001b[8m', '\u0007', '\u009b', '\u202e', '\u202a', '\u2069', '\u200b', '\u200f', '\u2060', '\ufeff']) {
      expect(errorsOf({ body: `**Rule:** a${c}b` })).toEqual([`${REL}: body must not hold control or invisible format characters`]);
    }
    expect(errorsOf({ body: '**Rule:** tabs\tand\nnew lines are fine' })).toEqual([]);
  });
  test('status is one of three', () => expect(errorsOf({ status: 'draft' })).toEqual([`${REL}: status must be active, superseded or retired`]));
  test('superseded_by is required with superseded and forbidden otherwise', () => {
    expect(errorsOf({ status: 'superseded' })).toEqual([`${REL}: superseded_by must be set when status is superseded`]);
    expect(errorsOf({ superseded_by: '2026-11-04-x' })).toEqual([`${REL}: superseded_by must be absent unless status is superseded`]);
    expect(errorsOf({ status: 'retired', superseded_by: '2026-11-04-x' })).toEqual([`${REL}: superseded_by must be absent unless status is superseded`]);
    expect(errorsOf({ status: 'superseded', superseded_by: '../x' })).toEqual([`${REL}: superseded_by must be a decision id`]);
    expect(file({ status: 'superseded', superseded_by: '2026-11-04-x' }).decision?.superseded_by).toBe('2026-11-04-x');
  });
  test('paths holds 1 to 10 strings', () => {
    const msg = `${REL}: paths must be a list of 1 to 10 globs`;
    expect(errorsOf({ paths: [] })).toEqual([msg]);
    expect(errorsOf({ paths: Array.from({ length: 11 }, (_, i) => `src/${i}.ts`) })).toEqual([msg]);
    expect(errorsOf({ paths: Array.from({ length: 10 }, (_, i) => `src/${i}.ts`) })).toEqual([]);
    expect(edit(/^paths:\n(?: {2}- .*\n)+/m, 'paths: "src/**"\n').errors).toEqual([msg]);
    expect(edit(/^ {2}- "src\/config.ts"$/m, '  - 7').errors).toEqual([`${REL}: paths[1] must be a string`]);
  });
  test('each forbidden glob is refused by index, without echoing it', () => {
    for (const g of ['/a', './a', 'a/../b', '..', 'a\\b', '*', '**', '**/*', 'C:/a', 'a\nb', '']) {
      const errs = errorsOf({ paths: ['src/a.ts', g] });
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatch(new RegExp(`^${REL}: paths\\[1\\] must `));
    }
  });
  test('a missing key is an error', () => {
    expect(edit(/^verified_at: .*\n/m, '').errors).toEqual([`${REL}: verified_at must be a 40-character lowercase hex commit sha`]);
    expect(edit(/^title: .*\n/m, '').errors).toEqual([`${REL}: title must be one line of 1 to 80 characters`]);
  });
  test('verified_at is a 40-character lowercase hex sha', () => {
    const msg = `${REL}: verified_at must be a 40-character lowercase hex commit sha`;
    expect(errorsOf({ verified_at: BASE.verified_at.toUpperCase() })).toEqual([msg]);
    expect(errorsOf({ verified_at: BASE.verified_at.slice(1) })).toEqual([msg]);
  });
  test('an all-digit sha is quoted so it stays a string', () => expect(file({ verified_at: '1'.repeat(40) }).errors).toEqual([]));
  test('verified_on is a real date, not in the future', () => {
    const msg = `${REL}: verified_on must be an ISO date (YYYY-MM-DD), not in the future`;
    expect(errorsOf({ verified_on: TODAY })).toEqual([]);
    expect(errorsOf({ verified_on: '2026-11-11' })).toEqual([msg]);
    expect(errorsOf({ verified_on: '2026-02-30' })).toEqual([msg]);
    expect(errorsOf({ verified_on: '3 Nov 2026' })).toEqual([msg]);
  });
  test('a file over the size cap is refused before parsing', () => {
    const big = FIXTURE + 'x'.repeat(40 * 1024);
    expect(parseDecision(REL, big, TODAY)).toEqual({ decision: null, errors: [`${REL}: file must be at most 32768 bytes`] });
  });
  test('the frontmatter must be a mapping', () => {
    expect(parseDecision(REL, '---\nschema: harness-decision/1\n- x\n---\n', TODAY).errors).toEqual([`${REL}: frontmatter must be valid YAML`]);
  });
});

describe('globProblem', () => {
  test('ordinary globs pass', () => {
    for (const g of ['src/env/**', 'src/config.ts', '.github/*.yml', 'src/**/*.ts', 'src/**/*.{ts,tsx}', 'docs/a b.md', '**/*.ts', '**/*.{ts,tsx}', 'docs/**', '**/*.md', '**/*.test.ts', 'src/[ab]/*.ts', 'src/file?.ts', 'src/a!b@c+d.ts']) expect(globProblem(g), g).toBeNull();
  });
  test('forbidden forms', () => {
    for (const g of ['/a', './a', 'a/../b', 'a\\b', '*', '**', '**/*', '**/**', 'C:/x', 'c:x', 'a\u0000b', 'a\u009bb', '', 'x'.repeat(201)]) expect(globProblem(g)).not.toBeNull();
  });
  test('brace, extglob and negation forms that cover the repo are refused', () => {
    for (const g of ['{**,x}', '{,**}', '**/{*,}', '**/*{,}', '{*,*/**}', '*{,/**}', '@(**)', '?(**)', '**/!(x)', '!src/x']) expect(globProblem(g), g).not.toBeNull();
  });
  test('negated-name and other grammar-breaking forms are refused', () => {
    const forms = [
      '**/!(zq9)', '**/!(zq9)/**', '**/!(zq9|.zq9)', '**/!(zq9.zq9)', '**/!(*.zq9)', '**/!(zq9)*', '**/!(*q9)', '{**,!(zq9)}',
      '@(!(zq9))', '**/!(zq9)/!(zq9)', '+(a)', '*(a)', 'src/(a|b)', 'src/a|b',
      'src/**.ts', 'src/a**', '{a,}/b', '{a,*}/b', '{a,{b,c}}', '{..,x}/y', 'src/{a', 'src/a}', 'src/[a', 'src/a]', 'src/[]', 'src//a', 'src/',
    ];
    for (const g of forms) expect(globProblem(g), g).not.toBeNull();
  });
  test('the probe backstop refuses globs that match 4 or more of 8 probes', () => expect(globProblem('**/*.*')).toMatch(/whole repo/));
  test('a leading ! is refused by its own rule, even when it matches few probes', () => expect(globProblem('!x/y')).toBe('must not start with ! (a negation matches nearly everything)'));
  test('invisible format characters are refused', () => {
    for (const g of ['src/\u200b**', 'src/\u202e**', 'src/\u2066a', 'src/\ufeffa', 'src/\u2060a']) expect(globProblem(g)).toBe('must not hold control or invisible format characters');
  });
});

describe('slugId', () => {
  test('the spec example', () => expect(slugId('Validate env with Zod!', '2026-11-03', () => false)).toBe(ID));
  test('a long title is cut to 40 slug characters', () => {
    const title = 'abcdefghij'.repeat(6);
    const id = slugId(title, '2026-11-03', () => false);
    expect(id).toBe(`2026-11-03-${title.slice(0, 40)}`);
  });
  test('a dash left at the cut is trimmed', () => {
    expect(slugId('a'.repeat(39) + ' bcd', '2026-11-03', () => false)).toBe(`2026-11-03-${'a'.repeat(39)}`);
  });
  test('a taken id gets -2, then -3', () => {
    expect(slugId('Validate env with Zod!', '2026-11-03', (id) => id === ID)).toBe(`${ID}-2`);
    expect(slugId('Validate env with Zod!', '2026-11-03', (id) => id === ID || id === `${ID}-2`)).toBe(`${ID}-3`);
  });
  test('a title with no a-z or 0-9 still gives a valid id', () => {
    const id = slugId('¡¿!', '2026-11-03', () => false);
    expect(errorsOf({ id }, `${DECISIONS_DIR}/${id}.md`)).toEqual([]);
  });
});

describe('addBody and serializeDecision', () => {
  test('the why paragraph is left out when empty', () => {
    expect(addBody('Do x.', 'Because y.')).toBe('**Rule:** Do x.\n\n**Why:** Because y.');
    expect(addBody('Do x.', '')).toBe('**Rule:** Do x.');
  });
  test('LF only, a final newline, superseded_by after status', () => {
    const t = serializeDecision({ ...BASE, status: 'superseded', superseded_by: '2026-11-04-x', body: 'a\r\nb' });
    expect(t).not.toContain('\r');
    expect(t.endsWith('b\n')).toBe(true);
    expect(t).toContain('status: superseded\nsuperseded_by: 2026-11-04-x\npaths:\n');
    expect(SCHEMA).toBe('harness-decision/1');
  });
});
