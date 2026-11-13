# Harness beta: design spec

- Status: draft, awaiting owner review
- Date: 2026-11-01
- Owner: khubaibqaiser
- Amends: [`2026-10-30-harness-design.md`](2026-10-30-harness-design.md). Where the two disagree, this spec wins for the beta. Sections of the original that this spec doesn't mention are unchanged but out of the beta (section 10).

## 1. Goal

A production-grade beta that test users install into their own repos, of any kind, and use like any developer would use a finished harness. The owner shares it privately with test users and collects feedback. It is to be ready in about two days (an estimate).

What the owner decided on 2026-11-01:

- Finish a releasable harness first, then trial it with test users. The week of fitness-app use that gated M1 (original section 13) no longer blocks the beta. The test-user trial takes over that job.
- No compromise on quality. Any corner that has to be cut is flagged to the owner first.
- I run tests and live checks myself, often, so the beta ships with as few bugs as possible.
- JS/TS is the first language, then Python, then others.
- The GitHub repo stays private. Test users are added as collaborators.
- The npm package is public, published by CI/CD.
- Windows is supported but marked untested.

## 2. Scope

**In the beta**

- The M1 gates, hardened (section 7).
- An installer that works in any git repo: `init`, `doctor`, `status`, `update` and `uninstall` (section 5).
- The `/harness` Claude Code plugin (section 4).
- Stop steps that run any command, so non-JS repos get a real Stop gate (section 6).
- CI on Ubuntu, macOS and Windows, plus a release pipeline that publishes to npm (section 9).
- A beta README with install steps, what each gate does, and known limits.

**Out of the beta** (scope cuts, not quality cuts)

- The PR reviewer (original M2).
- The AI-led interview, catalog, recommend step and outside plugins (original M3 catalog work, plus `sync`, `add`, `remove` and `why`). The beta installer uses detection plus the user's confirmation instead.
- TDD and coverage gates for languages other than JS/TS.
- `init` doesn't commit, push or open a PR. It writes the files and tells the user what to commit. (Original section 2, "Git", moves to a later release.)
- CODEOWNERS and the `harness-integrity` CI item for target repos.
- `report.md`, `context/product.md` and `.harnessignore`.

## 3. What each repo gets

| Gate | Any repo | JS/TS (npm, pnpm, yarn, bun; Vitest or Jest) |
|---|---|---|
| Guard: secret reads, force-push, pushing to main, installs; asks on GitHub writes (gh, hub, gh api, MCP write tools) | yes | yes |
| Protected paths: `.harness/`, `.claude/settings*.json` | yes | yes |
| Multi-file gate, including the unattended reason requirement | yes | yes |
| Stop gate with the commands the user confirms | yes | yes |
| `harness stats` | yes | yes |
| Installs denied by default | yes | yes |
| npm registry check when the user allows an install | no | yes |
| Red-first TDD, test-lock, tamper check | no | yes |
| Changed-line coverage | no | yes |

Where a gate is off for the repo's stack, `init`, `status` and `doctor` say so in plain words. A gate never turns itself off without saying so.

## 4. Distribution

- **One npm package,** `@khubaibqaiser/harness`. It holds the CLI (`dist/cli.mjs`), the bundled hook dispatcher, the templates and the plugin directory (`plugin/`).
- **One private GitHub repo,** `KhubaibQaiser/harness`. It holds `.claude-plugin/marketplace.json`, whose single plugin entry uses an `npm` source pinned to the exact released version.
- **How a test user installs it:**
  1. `claude plugin marketplace add KhubaibQaiser/harness`. This works through their collaborator access.
  2. `claude plugin install harness@harness`.
  3. `/harness:init` inside their repo.
- **No CLI or plugin drift.** The npm package root is the plugin root, so the plugin's skills run the CLI bundled next to them: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"`. Plugin and CLI are always the same files. A test that checks the plugin version, package version and marketplace pin are equal runs in CI and before every release.
- **Without the plugin:** `npx @khubaibqaiser/harness init` does the same thing in a terminal.
- **Still to verify on day 1:** that an `npm` plugin source installs cleanly from a private-repo marketplace for a collaborator. If it doesn't, the plugin entry switches to a relative path inside the repo, and the version-equality test still applies.

## 5. Installer

### 5.1 `harness init`

1. **Preflight.** Refuse with a clear message when:
   - the directory isn't a git repo
   - Node is older than 22.11
   - `.harness/manifest.json` already exists (point the user to `update`)
   - the working tree has uncommitted changes to files `init` would touch (list them)
2. **Detect.** Write `facts` (in memory, shown to the user) covering:
   - package manager, from the lockfile and the `packageManager` field
   - workspaces (pnpm, npm, yarn, bun) and their package directories
   - `package.json` scripts per package, to suggest the Stop steps
   - test framework per package (Vitest or Jest, from dependencies and config files)
   - Python markers (`pyproject.toml`, `setup.cfg`, `requirements*.txt`, `pytest.ini`), to suggest Stop steps such as `ruff check .` and `pytest` when those tools are declared
   - existing `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.claude/settings.local.json` and existing hooks
   - the default branch, from `origin/HEAD`, falling back to `main` and then `master`
3. **Preset.** Build a recommended config from the facts:
   - TDD paths: each JS/TS package's `src/**`
   - exempt: the M1 list
   - diff coverage: 80
   - multi-file gate: on, with unattended `block`
   - Stop steps: the detected format, lint, typecheck and test commands
   Show every value, with a one-line reason, and let the user edit any of them. `--yes` accepts the preset, which is used by tests and CI.
4. **Plan.** Show every file `init` will create or change, with a diff for each changed file, including the test-config edits (5.4). The user confirms once.
5. **Apply** (5.2).
6. **Report.** List:
   - which gates are on, which are off and why
   - the files to commit
   - the next step for teammates (install the plugin, or nothing if they only use the committed hooks)

`/harness:init` runs the same CLI steps in the user's Claude Code session, asks the questions through Claude Code's own prompts, and explains each step. It passes the user's answers to the CLI as a JSON file. The CLI validates that file against a schema, rejects it with the exact error, and the skill retries once and then stops (original section 2, "Model output").

### 5.2 Apply, manifest and rollback

- **Before any write:**
  - render every file into memory
  - back up every existing file it will change into `.harness/backup/<timestamp>/`
- **The write:** write each file to a temporary path next to its target, then rename it into place.
- **If any step fails:**
  - restore every backed-up file
  - delete every created file
  - report the failure
  - exit non-zero
- **`.harness/manifest.json`** records:
  - the package version
  - every file created, with its hash
  - every file changed, with its backup path and the hash of the written content
  - every merged block (the `AGENTS.md` markers, settings keys and test-config edits), with the exact inserted text
- **Format preservation:** merging keeps each file's existing line endings (LF or CRLF), its trailing newline and its JSON indentation.
- **Merge rules:**
  - A `null` or malformed hook entry in existing settings is reported and left untouched, never crashed on.
  - Malformed JSON in a file `init` must change stops the install, with the file and the parse error.
  - Existing hooks from other tools are kept. The harness entries are added next to them, and the plan shows both.

### 5.3 `uninstall`, `update`, `doctor` and `status`

**`uninstall`** removes only what the manifest lists:
- Created files are deleted if their hash still matches. If a user edited one, it is listed and kept unless they pass `--force`.
- Merged blocks are removed by their exact inserted text.
- If nobody touched a changed file since install, it is restored from its backup.
- An end-to-end test requires the repo to be byte-identical to before after `init` then `uninstall`.

**`update`:**
- runs under the newer package version
- re-renders the templates with the existing config
- shows the diff
- applies it with the same backup and rollback as `init`
- rewrites the manifest

`update --check` reports whether npm has a newer version.

**`doctor`** checks:
- the Node version
- the Claude Code version, against the minimum the hooks need
- that the hook dispatcher is wired in settings and its file hash matches the manifest
- that the config parses against the schema
- that each TDD package has the JSON reporter and coverage output in place
- that each Stop step's command exists

Each failure prints the fix. Exit code 0 means healthy, 1 means at least one problem.

**`status`** shows:
- each gate's on/off state, with the reason when off
- whether TDD is paused, and since when
- the installed version
- the last 24 hours of `stats`

### 5.4 Test-config edits (owner choice 4a)

To read results, the TDD gate needs a JSON reporter writing to `.harness/state/test-results/<package>.json`, plus coverage output.

- **Vitest:** add `'json'` to `test.reporters` (keeping `'default'` or the existing reporters) and set `outputFile.json`. Add `json` to `coverage.reporter`.
- **Jest:** add `--json --outputFile=<path> --coverage` to the package's test script, as in fitness-app. If the script already passes those flags, the gate reads its configured paths instead.
- **Edits are done with an AST parser**, never regex. Only plain object-literal configs (`defineConfig({...})` or `export default {...}`) are edited. The plan shows the exact diff, and nothing is written without confirmation.
- **Configs that can't be edited safely** (computed configs, `mergeConfig` chains, workspace configs it doesn't understand): print the exact lines to add, keep TDD off for that package, and have `doctor` turn it on once the lines are found. It never guesses.
- Adding `.harness/` to an existing ESLint ignore list or `.prettierignore` follows the same rules: AST or line edit, shown in the plan.

## 6. Stop steps for any repo

- A step is either a script name (run with the package manager, as in M1) or a command object `{ name, run }`, where `run` is an argv array, run without a shell.
- Python and other repos use command objects, for example `{ name: lint, run: [ruff, check, .] }`.
- The package manager is `npm`, `pnpm`, `yarn` or `bun`, and the run command matches each one.
- Detection suggests the steps, and the user confirms them. A repo with no detectable steps gets an empty list and a `status` line saying the Stop gate has nothing to run.

## 7. Hardening carried in from M1

All required for the beta, each with a test:

- **Rollback, CRLF and malformed settings:** handled by the installer (5.2).
- **F5:** time limits on install-path checks, so the dependency lookup can't hang a hook past its time limit.
- **F11:** one shared `editTarget(input)` helper replaces the six copies that work out which file an edit targets. Today they disagree on `NotebookEdit`.
- **Earlier deferred minors that strangers would hit:**
  - numeric config keys accept `NaN` and negative values
  - Stop steps can leave child processes holding pipes after a timeout (pnpm grandchildren)
  - `git status` is parsed without `-z`, so unusual file names break
  - `stop-skipped` is logged on every Stop in a non-git folder
  - `dist/cli.mjs` is not executable
- **Co-denies:** when several checks deny the same action, each is logged, with the first one shown to the agent, so `harness stats` counts them all.
- **Test-lock:** a file is recorded as touched only after the edit is allowed, so declining a test-lock ask doesn't trigger a later multi-file ask.
- **Red-first message:** when the test exists but has no fresh failing result, the message says "Run the test for `<file>` and see it fail first" instead of "No test for `<file>`".
- **Guard on Windows:** commands are checked on their parsed argv as today. PowerShell syntax is out of scope and listed as a known limit. The existing deny rules in settings still apply.

## 8. Testing

Every item below runs in CI unless marked otherwise.

- **Unit and golden-file tests** for detection, preset, apply, merge, manifest, rollback, uninstall, update and doctor, plus every existing M1 test.
- **Fixture repos** under `test/fixtures/repos/`, each a small git repo created by the test:
  - npm with Vitest
  - a pnpm monorepo with Vitest
  - yarn with Jest
  - bun with Vitest
  - Python with pytest and ruff
  - a repo with no tests
  - a repo that already has `CLAUDE.md`, `AGENTS.md`, settings with other hooks, and CRLF files
  - a Vitest config that can't be edited safely
- **End-to-end per fixture:**
  1. `init --yes`
  2. pipe hook inputs into the installed dispatcher and check each gate's decision
  3. run the Stop steps
  4. `uninstall`
  5. confirm the repo is byte-identical to before
- **Live runs (not in CI; I ask the owner before each batch).** Real `claude -p` sessions against the fixtures, covering:
  - red-first deny, then allow after a failing test
  - the multi-file ask
  - the unattended reason gate, including whether the reason is in the transcript before the hook reads it
  - the guard blocking `harness tdd off`
  - the Stop gate blocking on a failing lint
- **Plugin check (live, before release).** Add the marketplace and install the plugin from the private repo, then run `/harness:init` on a fixture.
- **CI matrix:** Ubuntu, macOS and Windows on Node 22 and the current Node LTS. Windows runs the unit tests, the golden-file tests and the fixture end-to-end tests. Live Claude Code on Windows stays untested and is listed as a known limit.

## 9. Release

- **CI on every push and PR:** typecheck, tests (the matrix in section 8), build, the version-equality test, `claude plugin validate`, and gitleaks.
- **Releasing:**
  1. The owner pushes a `v<semver>` tag. I can't push tags to `main` because of the global guard.
  2. CI runs the full matrix.
  3. `npm publish --access public`, then the marketplace pin is updated to the new version through a PR the owner merges.
- **npm authentication:** npm trusted publishing (OIDC) if npm allows it from a private repo; otherwise a granular npm token stored as a repo secret. The owner sets either one up.
- **Provenance:** not available while the repo is private, because npm requires a public source repository. Flagged gap against original section 11. It is turned on when the repo goes public.
- **Owner steps:**
  - claim the `@khubaibqaiser` npm scope with 2FA
  - set up trusted publishing or the token
  - push `main`
  - set `main` as the default branch
  - push release tags
  - add test users as collaborators
- **Package metadata:**
  - `license: Apache-2.0`, with the Apache License 2.0 text in `LICENSE` (owner decision 2026-11-02; was UNLICENSED)
  - `files` limited to `dist/`, `plugin/` and `templates/`
  - `engines.node >= 22.11.0`
  - no runtime dependencies (everything is bundled)

## 10. Known limits listed in the beta README

- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- Not in this release: the PR reviewer (M2) and TDD for other languages.

## 11. Timeline (estimate, not a promise)

- **Day 1:**
  - section 7 hardening
  - detection
  - preset
  - apply with manifest and rollback
  - uninstall
  - test-config edits
  - the npm, pnpm, yarn and bun runners
  - the fixture repos
- **Day 2:**
  - doctor, status, update
  - the plugin and marketplace
  - CI and release
  - Windows CI fixes
  - live runs
  - the README

First to slip: Windows CI fixes, then the bun fixture. If either slips, I tell the owner before day 2 ends, not after.
