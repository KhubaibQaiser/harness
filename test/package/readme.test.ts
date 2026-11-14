import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { expect, test } from 'vitest';

const readme = readFileSync('README.md', 'utf8');
// The full command flags, config keys and known limits live in docs/reference.md; the README links there.
const reference = readFileSync('docs/reference.md', 'utf8');
const spec = readFileSync('docs/specs/2026-11-01-harness-beta-design.md', 'utf8');
const between = (s: string, a: string, b: string) => s.slice(s.indexOf(a), s.indexOf(b, s.indexOf(a)) + b.length);

test('config reference equals the generator output', () => {
  const generated = execFileSync('node', ['scripts/gen-config-docs.mjs'], { encoding: 'utf8' }).trimEnd();
  expect(between(reference, '<!-- config:start -->', '<!-- config:end -->')).toBe(generated);
  expect(readme).not.toContain('<!-- config:start -->');
});

test('README names the minimum Claude Code version from the source', () => {
  const min = /MIN_CLAUDE_CODE = '([\d.]+)'/.exec(readFileSync('src/core/min-claude.ts', 'utf8'))![1];
  expect(readme).toContain(`Claude Code ${min} or newer`);
});

test('known limits are spec section 10, verbatim', () => {
  const limits = between(spec, '## 10.', '## 11.').split('\n').filter((l) => l.startsWith('- '));
  expect(limits).toHaveLength(5);
  for (const l of limits) expect(reference).toContain(l + '\n');
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

test('the reference carries the platform enforcement known limits, verbatim', () => {
  const limits = between(pe, '## 11.', '## 12.').split('\n').filter((l) => l.startsWith('- '));
  expect(limits).toHaveLength(7);
  for (const l of limits) expect(reference).toContain(l + '\n');
});

const cb = readFileSync('docs/specs/2026-11-03-context-budget-design.md', 'utf8');

test('the reference carries the context-budget known limits, verbatim', () => {
  const limits = between(cb, '## 14.', '## 15.').split('\n').filter((l) => l.startsWith('- '));
  expect(limits).toHaveLength(10);
  for (const l of limits) expect(reference).toContain(l + '\n');
});

const launch = (s: string) => /```sh\n(HARNESS_SANDBOX=1 [^\n]*claude -p [\s\S]+?)\n```/.exec(s)?.[1];

test('README carries the unattended launch command', () => {
  const cmd = launch(between(pe, '### 3.4', '### 3.5'));
  expect(cmd, 'spec 3.4 has the launch block').toBeDefined();
  expect(readme).toContain(cmd);
});

test('the documented launch is one valid --settings JSON, the same in README and reference', () => {
  const cmd = launch(readme)!;
  expect(launch(reference)).toBe(cmd);
  // The whole JSON is one POSIX single-quoted word, so it can't hold a single quote of its own.
  // The env scrub keeps credential-looking variables out of Bash, hooks and MCP servers (and /proc on Linux).
  // The scrub forces the permission mode to default (live, 2.1.322): -p then refuses any tool not named in --allowedTools,
  // and harness sees no dontAsk/bypassPermissions, so HARNESS_UNATTENDED marks the run unattended outside CI.
  const m = /^HARNESS_SANDBOX=1 HARNESS_UNATTENDED=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 claude -p "…" --allowedTools "Bash,Edit,Write" --settings '([^']*)'$/.exec(cmd);
  expect(m, 'the prefix, the allowed tools and one single-quoted --settings argument').not.toBeNull();
  for (const doc of [readme, reference]) {
    expect(doc).toContain('forces the permission mode to `default`, so `bypassPermissions` is ignored');
    expect(doc).toContain('add the tools your run needs');
  }
  expect(notes).toContain('--allowedTools "Bash,Edit,Write"');
  // The scrub strips CLAUDE_CONFIG_DIR from the hooks too, so both docs say how to pass the mirror.
  for (const doc of [readme, reference]) expect(doc).toContain('HARNESS_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"');
  const sb = JSON.parse(m![1]).sandbox;
  expect(sb).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false });
  expect(sb.network).toEqual({ strictAllowlist: true, allowedDomains: [] });
  // The whole lists: dropping one entry must fail.
  const files = sb.credentials.files.map((f: { path: string; mode: string }) => (expect(f.mode).toBe('deny'), f.path));
  expect(files).toEqual([
    '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.docker/config.json', '~/.npmrc', '~/.pypirc', '~/.netrc',
    '~/.git-credentials', '~/.config/git/credentials', '~/.config/gh', '~/.claude/.credentials.json',
  ]);
  const vars = sb.credentials.envVars.map((e: { name: string; mode: string }) => (expect(e.mode).toBe('deny'), e.name));
  expect(vars).toEqual([
    'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  ]);
});

test('README carries the enforcement line', () => {
  const line = /One plain line at the top: "([^"]+)"/.exec(between(pe, '## 9.', '## 10.'))![1];
  expect(readme).toContain(line);
});

// M3 Task 26
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
// The notes of the release being prepared: unreleased.md until the version bump renames it to <version>.md (the
// release workflow needs that name at tag time); a tagged version's notes describe what shipped and are never edited.
const notes = readFileSync(existsSync('docs/release-notes/unreleased.md') ? 'docs/release-notes/unreleased.md' : `docs/release-notes/${pkgVersion}.md`, 'utf8');
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
  expect(reference.toLowerCase()).not.toContain('telemetry');
});

test('the reference states the M3 known limits, with C1 unverified', () => {
  for (const s of ['local only', 'extraKnownMarketplaces', 'folder trust', '`CLAUDECODE`', '`git-subdir`', '`!` prefix', 'Checked live on Claude Code 2.1.322: a `!` command runs outside the sandbox']) expect(reference, s).toContain(s);
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

test('README documents the usage and adherence report and the eval cost', () => {
  expect(readme).toContain('usage and adherence report');
  expect(readme).toContain('| `report ');
  expect(readme).toContain('start Claude Code inside the repo for the report to see it');
  expect(readme).toContain('| `eval ');
  expect(readme).toMatch(/costs money/);
});

test('README links the team decisions reference', () => {
  expect(readme).toContain('docs/reference.md#team-decisions');
});

test('the reference carries every team-decisions known limit (spec section 12) and the build drifts', () => {
  const limits = between(reference, '## Known limits', '## Development');
  const td = readFileSync('docs/specs/2026-11-03-team-decisions-design.md', 'utf8');
  expect(between(td, '## 12.', '## 13.').split('\n').filter((l) => l.startsWith('- '))).toHaveLength(9);
  for (const s of [
    'only through other shell commands, or only searches, may never load the decision',
    'no cap on how many rules load in one session',
    'keeps loading until someone runs `harness remember sync` and commits the result',
    'quote detection is an 8-word exact match on normalised text',
    'the secret scan is a fixed pattern list',
    'the nudge signals are English regexes',
    'a decision path built at run time', // protect is a text check (listed by Task 11)
    '`harness remember` may not be on the PATH in cloud sessions',
    'so a broad glob goes stale often',
    'conflict in `.harness/manifest.json`',
    'names a secrets file, such as `.env`',
    '`--dry-run` and a word holding a glob',
  ]) expect(limits, s).toContain(s);
  expect(reference.match(/^## Team decisions$/gm)).toHaveLength(1);
});
