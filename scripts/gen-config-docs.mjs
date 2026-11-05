// Prints the config reference in docs/reference.md (between the markers) from the key-rule table in src/core/config.ts.
// `node scripts/gen-config-docs.mjs --write` rewrites that section in docs/reference.md.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const WHAT = {
  version: 'Config schema version.',
  'checks.guard': 'Guard: secret reads, force-push, pushing to main, installs.',
  'checks.protect': 'Protected paths: `.harness/` and `.claude/settings*.json`.',
  'checks.depVerify': 'npm registry check when you allow a JS install. When off, an allowed install is still confirmed with you.',
  'checks.multiFile': 'Multi-file gate.',
  'checks.tdd': 'Red-first TDD, test-lock and tamper check.',
  'checks.stop': 'Stop gate.',
  catalog_version: 'Version of the catalog the recommendations came from. `0` means no catalog.',
  'project.type': 'What kind of project this is. Empty until the interview sets it.',
  'project.domain': 'What the project is about, in a few words.',
  'project.compliance': 'Compliance regimes that apply (for example `gdpr`).',
  'project.data_handling': 'How the project handles personal or sensitive data.',
  'project.team_size': 'People working on it. `0` means unknown.',
  'project.open_source': 'Whether the repo is public.',
  'project.codeowners': 'Owners to consult. Input to recommendations only; harness writes no CODEOWNERS.',
  'project.deploy_target': 'Where it is deployed.',
  'project.run_budget_usd': 'Spend limit, in USD, for one unattended run. `0` means none set.',
  'project.named_items': 'Catalog item ids the owner asked for by name.',
  'project.scope_paths': 'Repo-relative paths the recommendations are limited to. Empty means the whole repo.',
  apps: 'Runnable apps (`dir`, `kind`, `install`, `start`, `ready_url`, `port`, `public_facing`, `login`). `login.credentials` holds file and variable names, never values.',
  items: 'Catalog items chosen for this project (`id`, `include`, `selected`, `reason`, `addresses`, `pin`).',
  'git.commit_trailer': 'Line added to the end of commit messages. Empty adds none.',
  'context.budget_tokens': 'Estimated tokens of always-loaded context harness may add before it asks you to confirm an install. Items you approved earlier are not counted.',
  sandbox: '`unattended`: required when nobody watches; `always`: on in every session; `off`: text checks only.',
  'tdd.paths': 'Globs for the files TDD covers.',
  'tdd.exempt': 'Globs inside `tdd.paths` that TDD skips.',
  'tdd.diff_coverage': 'Minimum coverage, in percent, for changed lines.',
  'tdd.coverage_skip': 'Globs inside `tdd.paths` that changed-line coverage skips. `init` lists a Vitest package here when no coverage provider is installed for it, and a Jest package whose `coverageReporters` leaves out `json` or whose `coverageDirectory` (or preset) moves the output.',
  'tdd.test_lock': 'Changing a test that was written failing needs your approval until it passes.',
  'tdd.results_dir': 'Where the test reporters write JSON results. Keep it inside `.harness/results`, which protect covers.',
  'multi_file_gate.generated': 'Globs for generated files that the multi-file gate does not count.',
  'pr_size.target_lines': 'Changed lines the pr-ship skill aims for in each PR. Guidance only; no gate enforces it.',
  'pr_size.max_lines': 'Changed lines above which opening or growing a PR asks you first (denied when unattended).',
  'pr_size.max_files': 'Changed files above which opening or growing a PR asks you first (denied when unattended).',
  'pr_size.exclude': "Globs not counted toward a PR's size: lockfiles, `.*ignore` files except `.npmignore` and `.harnessignore`, and snapshots. A list you set replaces the whole default, so keep the defaults you want.",
  'unattended.multi_file_gate': 'What the multi-file gate does when no human is watching.',
  'unattended.require_reason': 'With `allow-log`, extra files need a one-line reason. No effect while the gate is `block`.',
  'stop.steps': 'Commands that must pass before the agent may stop.',
  'stop.package_manager': 'Used to run script-name steps.',
  'stop.max_attempts': 'How many times the Stop gate blocks before it gives up and lets the agent stop.',
  'stop.timeout_s': 'Seconds the Stop steps may run in total.',
  'stop.base_ref': 'Git ref that changed lines are compared with.',
  'stop.coverage_globs': 'Globs for the coverage files that diff coverage reads.',
};

const out = await build({
  entryPoints: ['src/core/config.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);" },
});
const tmp = join(mkdtempSync(join(tmpdir(), 'harness-gen-')), 'config.mjs'); // a file, not a data: URL, so import.meta.url works
writeFileSync(tmp, out.outputFiles[0].text);
const { configReference } = await import(pathToFileURL(tmp).href);

const rows = configReference().map(({ key, default: d, rule }) => {
  if (!(key in WHAT)) throw new Error(`gen-config-docs: no description for ${key}`);
  const val = JSON.stringify(d).replaceAll('|', '\\|');
  return `| \`${key}\` | \`${val}\` | ${WHAT[key]}${rule ? ` Value ${rule}.` : ''} |`;
});
const section = ['<!-- config:start -->', '| Key | Default | What it does |', '|---|---|---|', ...rows, '<!-- config:end -->'].join('\n');

if (process.argv.includes('--write')) {
  const md = readFileSync('docs/reference.md', 'utf8');
  writeFileSync('docs/reference.md', md.replace(/<!-- config:start -->[\s\S]*<!-- config:end -->/, () => section));
} else console.log(section);
