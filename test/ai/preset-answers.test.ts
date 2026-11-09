import { expect, test } from 'vitest';
import { loadCatalog } from '../../src/catalog/load.js';
import { validatePresetAnswers } from '../../src/ai/preset-answers.js';

const { catalog } = loadCatalog('catalog');
const good = {
  id: 'my-frontend',
  title: 'My frontend',
  description: 'Rules for my React apps.',
  target: 'repo',
  rules: ['TDD: write a failing test first.', 'Pin react@19.0.0 and use @tanstack/react-query.'],
  preselect: ['superpowers', 'ponytail'],
  git: { branch_prefixes: ['feature/', 'fix/'], no_ai_trailer: true, pr_size_warning: false },
  stacks: { react: { folders: 'By feature.', forms: 'React Hook Form with Zod.' }, next: { server_data: 'Server Components first.' } },
};
const errs = (raw: unknown) => {
  const r = validatePresetAnswers(raw, catalog, process.cwd());
  return r.ok ? [] : r.errors;
};

test('a full valid file passes', () => {
  expect(validatePresetAnswers(good, catalog, process.cwd())).toEqual({ ok: true, answers: good });
});

test('a skipped topic is simply absent; nothing is filled in', () => {
  const r = validatePresetAnswers({ ...good, stacks: { 'react-native': { platform: 'Expo.' } } }, catalog, process.cwd());
  expect(r.ok && r.answers.stacks).toEqual({ 'react-native': { platform: 'Expo.' } });
});

test('each problem gives its own error', () => {
  expect(errs({ ...good, id: 'khubaib-frontend' })).toEqual(['id: "khubaib-frontend" is already a shipped preset']);
  expect(errs({ ...good, preselect: ['caveman'] })).toEqual(['preselect[0]: "caveman" is discouraged in the catalog']);
  expect(errs({ ...good, preselect: ['zzz'] })).toEqual(['preselect[0]: "zzz" is not a catalog id']);
  expect(errs({ ...good, git: { ...good.git, branch_prefixes: ['feature'] } })).toEqual(['git.branch_prefixes[0]: "feature" must match ^[a-z0-9-]+/$']);
  expect(errs({ ...good, rules: ['a‮b'] })).toEqual(['rules[0]: must not contain control characters']);
  expect(errs({ ...good, stacks: { react: { style: 'ask jane@example.com' } } })).toEqual(['stacks.react.style: contains an email address']);
  expect(errs({ ...good, description: 'Set user.email first.' })).toEqual(['description: mentions user.name or user.email']);
  expect(errs({ ...good, stacks: { react: { i18n: 'x' } } })).toEqual(['stacks.react.i18n: unknown topic']);
  expect(errs({ ...good, stacks: { vue: {} } })).toEqual(['stacks.vue: unknown stack (react, next, react-native)']);
  expect(errs({ ...good, extra: 1 })).toEqual(['extra: unknown key']);
});

test('shape errors', () => {
  expect(errs([])).toEqual(['preset-answers: must be a mapping']);
  expect(errs({ ...good, target: 'team' })).toEqual(['target: must be repo or global']);
  expect(errs({ ...good, id: 'Bad Id' })).toEqual(['id: must be lowercase letters, digits and hyphens']);
  expect(errs({ ...good, git: { branch_prefixes: [], no_ai_trailer: 'yes', pr_size_warning: true } })).toEqual(['git.branch_prefixes: must be a non-empty list', 'git.no_ai_trailer: must be true or false']);
  expect(errs({ ...good, rules: [''] })).toEqual(['rules[0]: must be a non-empty string']);
});

test('ids that could escape a folder are rejected', () => {
  for (const id of ['../x', 'a/b', '/etc', '.x', '']) expect(errs({ ...good, id }), id).toEqual(['id: must be lowercase letters, digits and hyphens']);
});

test('the other shape branches', () => {
  expect(errs({ ...good, title: 3 })).toEqual(['title: must be a non-empty string']);
  expect(errs({ ...good, rules: 'x', preselect: 'y' })).toEqual(['rules: must be a list', 'preselect: must be a list']);
  expect(errs({ ...good, rules: ['a'.repeat(2001)] })).toEqual(['rules[0]: must be at most 2000 characters']);
  expect(errs({ ...good, git: { ...good.git, sign: true } })).toEqual(['git.sign: unknown key']);
  expect(errs({ ...good, stacks: [] })).toEqual(['stacks: must be a mapping']);
  expect(errs({ ...good, stacks: { react: 'x' } })).toEqual(['stacks.react: must be a mapping']);
});

test('duplicates in preselect and branch_prefixes give one error each', () => {
  expect(errs({ ...good, preselect: ['ponytail', 'ponytail', 'ponytail'] })).toEqual(['preselect: "ponytail" is listed more than once']);
  expect(errs({ ...good, git: { ...good.git, branch_prefixes: ['fix/', 'fix/'] } })).toEqual(['git.branch_prefixes: "fix/" is listed more than once']);
});

test('values that look like keys or tokens are rejected without echoing them', () => {
  // Fake values, built at runtime so no secret-shaped literal sits in the repo.
  const fakes = [
    ['sk', '-', 'x'.repeat(24)].join(''),
    ['gh', 'p_', 'A1'.repeat(10)].join(''),
    ['github', '_pat_', 'B2'.repeat(10)].join(''),
    ['xo', 'xb-', '1234-abcd'].join(''),
    ['AK', 'IA', 'Q'.repeat(16)].join(''),
    ['-----BEGIN', ' PRIVATE KEY-----'].join(''),
    'aZ09'.repeat(9),
  ];
  for (const f of fakes) {
    const e = errs({ ...good, rules: [`use ${f} here`] });
    expect(e, f).toEqual(['rules[0]: looks like a key or token; never put secrets in a preset']);
    expect(e.join('\n')).not.toContain(f);
  }
  expect(errs({ ...good, rules: ['Use @tanstack/react-query and react@19.0.0 with kebab-case-file-names.'] })).toEqual([]);
});
