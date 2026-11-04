import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { expect, test } from 'vitest';

const readme = readFileSync('README.md', 'utf8');
const spec = readFileSync('docs/specs/2026-11-01-harness-beta-design.md', 'utf8');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)) + b.length);

test('config reference equals the generator output', () => {
  const generated = execFileSync('node', ['scripts/gen-config-docs.mjs'], { encoding: 'utf8' }).trimEnd();
  expect(between(readme, '<!-- config:start -->', '<!-- config:end -->')).toBe(generated);
});

test('README names the minimum Claude Code version from the source', () => {
  const min = /MIN_CLAUDE_CODE = '([\d.]+)'/.exec(readFileSync('src/core/min-claude.ts', 'utf8'))![1];
  expect(readme).toContain(`Claude Code ${min} or newer`);
});

test('known limits are spec section 10, verbatim', () => {
  const limits = between(spec, '## 10.', '## 11.').split('\n').filter((l) => l.startsWith('- '));
  expect(limits).toHaveLength(5);
  for (const l of limits) expect(readme).toContain(l + '\n');
});

test('gate table is spec section 3, verbatim', () => {
  const table = between(spec, '| Gate |', '| Changed-line coverage | no | yes |');
  expect(readme).toContain(table);
});

test('install commands match the spec and every CLI command is documented', () => {
  for (const c of ['claude plugin marketplace add KhubaibQaiser/harness', 'claude plugin install harness@harness', '/harness:init', 'npx @khubaibqaiser/harness init']) {
    expect(spec, c).toContain(c);
    expect(readme, c).toContain(c);
  }
  for (const c of ['`init ', '`status`', '`doctor`', '`update ', '`uninstall ', '`stats ', '`tdd off|on|status`']) expect(readme.replace(/\\\|/g, '|'), c).toContain(`| ${c}`);
});

const pe = readFileSync('docs/specs/2026-11-03-platform-enforcement-design.md', 'utf8');

test('README carries the platform enforcement known limits, verbatim', () => {
  const limits = between(pe, '## 11.', '## 12.').split('\n').filter((l) => l.startsWith('- '));
  expect(limits).toHaveLength(7);
  for (const l of limits) expect(readme).toContain(l + '\n');
});

test('README carries the unattended launch command', () => {
  const cmd = /```sh\n(HARNESS_SANDBOX=1 claude -p [^\n]+)\n```/.exec(between(pe, '### 3.4', '### 3.5'))![1];
  expect(readme).toContain(cmd);
});

test('README carries the enforcement line', () => {
  const line = /One plain line at the top: "([^"]+)"/.exec(between(pe, '## 9.', '## 10.'))![1];
  expect(readme).toContain(line);
});

// M3 Task 26
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
const notes = readFileSync(`docs/release-notes/${pkgVersion}.md`, 'utf8');
const catalogItems = readdirSync('catalog/items').map((f) => parseYaml(readFileSync(`catalog/items/${f}`, 'utf8')) as { id: string; source: { type: string }; plugin_version?: string });

test('README carries neither test variable and names the budget key', () => {
  expect(readme).not.toContain('HARNESS_PLAIN_INIT');
  expect(readme).not.toContain('HARNESS_CATALOG_DIR');
  expect(readme).toContain('context.budget_tokens');
  expect(readme).toContain('--over-budget');
});

test('README has no stale out-of-scope line and promises no telemetry', () => {
  expect(readme).not.toContain('the interview and catalog, committing');
  expect(readme.toLowerCase()).not.toContain('telemetry');
});

test('README states the M3 known limits, with C1 unverified', () => {
  for (const s of ['local only', 'extraKnownMarketplaces', 'folder trust', '`CLAUDECODE`', '`git-subdir`', '`!` prefix', 'Unverified, pending the live check']) expect(readme, s).toContain(s);
});

test('release notes list every excluded id and every unpinned git-subdir item', () => {
  const excluded = (parseYaml(readFileSync('catalog/excluded.yaml', 'utf8')) as { id: string }[]).map((e) => e.id);
  const subdir = catalogItems.filter((i) => i.source.type === 'git-subdir' && !i.plugin_version).map((i) => i.id);
  for (const id of [...excluded, ...subdir]) expect(notes, id).toContain(`\`${id}\``);
  const version = (parseYaml(readFileSync('catalog/catalog.yaml', 'utf8')) as { version: number }).version;
  expect(notes).toContain(`Catalog version ${version}, ${catalogItems.length} items`);
});

test('the README status line shows the package version', () => {
  expect(readme).toContain(`version \`${pkgVersion}\``);
});
