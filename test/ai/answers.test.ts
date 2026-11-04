import { expect, test } from 'vitest';
import { answersToConfig, validateAnswers } from '../../src/ai/answers.js';
import { defaults } from '../../src/core/config.js';
import { detect } from '../../src/install/detect.js';
import { makeRepo } from '../install/helpers.js';

const root = makeRepo({ 'package.json': JSON.stringify({ devDependencies: { next: '1' } }), 'web/package.json': JSON.stringify({ dependencies: { next: '1' } }), '.harnessignore': 'secret-dir/\n' }, { git: false });
const facts = { ...detect(root), apps: [{ dir: 'web', kind: 'web' as const }] };
const app = (over: Record<string, unknown> = {}, creds: Record<string, unknown> = {}) => ({
  dir: 'web', kind: 'web', install: ['pnpm i'], start: ['pnpm dev'], ready_url: 'http://localhost:3000', port: 3000, public_facing: false,
  login: { needed: true, credentials: { file: '', keys: [], env: [], ...creds }, login_url: '/login', post_login: '/' }, ...over,
});
const answers = (over: Record<string, unknown> = {}) => ({
  scope: { paths: ['web'] },
  project: { type: 'web', domain: 'shop', compliance: [], data_handling: '', team_size: 2, open_source: false, codeowners: [], deploy_target: '', run_budget_usd: 5, named_items: [] },
  apps: [app()],
  unattended: { multi_file_gate: 'block', require_reason: false },
  tdd: { paths: ['web/**'], diff_coverage: 80 },
  ...over,
});
const errs = (raw: unknown) => {
  const r = validateAnswers(raw, facts);
  return r.ok ? [] : r.errors;
};

test('a valid answers file passes', () => {
  expect(validateAnswers(answers(), facts).ok).toBe(true);
});

test('apps must exist in facts', () => {
  expect(errs(answers({ apps: [app({ dir: 'nope' })] }))).toEqual(['apps[0].dir: no app at "nope" in this repo']);
});

test('scope paths must be repo-relative and not ignored', () => {
  for (const p of ['/etc/passwd', '../x', '.env', '.harness/state/x', 'secret-dir/a.ts']) {
    const e = errs(answers({ scope: { paths: [p] } }));
    expect(e, p).toHaveLength(1);
    expect(e[0]).toContain(p);
  }
});

test('scope text is accepted; other scope shapes are not', () => {
  expect(errs(answers({ scope: { text: 'the checkout flow' } }))).toEqual([]);
  expect(errs(answers({ scope: {} }))).toHaveLength(1);
});

test('credential names reject values and never echo them', () => {
  const e = errs(answers({ apps: [app({}, { keys: ['sk_live_abc123='] })] }));
  expect(e).toEqual(['apps[0].login.credentials.keys[0]: must be a name such as API_KEY, not a value']);
  expect(e.join()).not.toContain('sk_live_abc123');
  expect(errs(answers({ apps: [app({}, { env: ['MY TOKEN'] })] }))).toEqual(['apps[0].login.credentials.env[0]: must be a name such as API_KEY, not a value']);
  expect(errs(answers({ apps: [app({}, { keys: ['API_KEY', '_x1'], env: ['TOKEN'] })] }))).toEqual([]);
  expect(errs(answers({ apps: [app({}, { file: '/abs/creds.json' })] }))).toHaveLength(1);
  expect(errs(answers({ apps: [app({}, { file: '../creds.json' })] }))).toHaveLength(1);
});

test('range errors from the config table are reused', () => {
  expect(errs(answers({ tdd: { paths: [], diff_coverage: 101 } }))).toEqual(['tdd.diff_coverage: must be a number from 0 to 100']);
  expect(errs(answers({ unattended: { multi_file_gate: 'x', require_reason: false } }))[0]).toMatch(/^unattended\.multi_file_gate: must be one of/);
  expect(errs(answers({ project: { ...answers().project, team_size: -1 } }))[0]).toMatch(/^project\.team_size:/);
  expect(errs(null)).toHaveLength(1);
});

test('answersToConfig leaves sandbox and results_dir alone', () => {
  const base = defaults();
  base.sandbox = 'always';
  base.tdd.results_dir = '.harness/results/x';
  base.checks.tdd = true;
  const r = validateAnswers(answers(), facts);
  if (!r.ok) throw new Error(r.errors.join());
  const c = answersToConfig(base, r.answers);
  expect(c.sandbox).toBe('always');
  expect(c.tdd.results_dir).toBe('.harness/results/x');
  expect(c.checks).toEqual(base.checks);
  expect(c.project.scope_paths).toEqual(['web']);
  expect(c.project.type).toBe('web');
  expect(c.apps[0].port).toBe(3000);
  expect(c.tdd.paths).toEqual(['web/**']);
  expect(base.apps).toEqual([]);
});

test('echoed input is escaped, never raw', () => {
  const esc = '\u001b[31m';
  const e = errs(answers({ apps: [app({ dir: `x${esc}` })], [`k${esc}`]: 1, project: { ...answers().project, [`p${esc}`]: 1 } }));
  expect(e.length).toBeGreaterThanOrEqual(3);
  for (const line of e) expect(line).not.toContain('\u001b');
  expect(e.join('\n')).toContain('\\u001b');
});

test('every project, tdd and unattended key is required', () => {
  const { domain: _d, ...project } = answers().project;
  expect(errs(answers({ project }))).toEqual(['project.domain: required']);
  expect(errs(answers({ tdd: { paths: [] } }))).toEqual(['tdd.diff_coverage: required']);
  expect(errs(answers({ unattended: { require_reason: false } }))).toEqual(['unattended.multi_file_gate: required']);
});

test('dotenv check is per segment: .env and .env.local rejected, .environments passes', () => {
  for (const p of ['.env', '.env.local', 'web/.env.production']) expect(errs(answers({ scope: { paths: [p] } })), p).toHaveLength(1);
  expect(errs(answers({ scope: { paths: ['.environments/a'] } }))).toEqual([]);
});
