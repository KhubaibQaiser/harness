# @khubaibqaiser/harness

Harness is a set of Claude Code hooks that check what an agent does in your repo: guard, protected paths, multi-file edits, red-first TDD and a Stop gate. It installs into any git repo, as a Claude Code plugin or with `npx`.

This is a private beta. Version `0.1.0-beta.0`.

## Requirements

- Node 22.11 or newer
- git
- Claude Code 2.1.285 or newer. Older versions are untested with these hooks.

## Install with the plugin

You need collaborator access to the private repo `KhubaibQaiser/harness`.

```
claude plugin marketplace add KhubaibQaiser/harness
claude plugin install harness@harness
```

Then, inside your repo in Claude Code:

```
/harness:init
```

The plugin also gives you `/harness:doctor`, `/harness:status`, `/harness:update` and `/harness:uninstall`. They run the CLI bundled with the plugin.

`init` writes files. It does not commit, push or open a PR. It lists the files for you to commit.

## Install without the plugin

```
npx @khubaibqaiser/harness init
```

This does the same thing in a terminal. Run it at the root of a git repo. It refuses if the directory is not a git repo, if Node is older than 22.11, or if `.harness/manifest.json` already exists (use `update` then). It also stops if files it would change have uncommitted changes.

## What each gate does

| Gate | Any repo | JS/TS (npm, pnpm, yarn, bun; Vitest or Jest) |
|---|---|---|
| Guard: secret reads, force-push, pushing to main, installs | yes | yes |
| Protected paths: `.harness/`, `.claude/settings*.json` | yes | yes |
| Multi-file gate, including the unattended reason requirement | yes | yes |
| Stop gate with the commands the user confirms | yes | yes |
| `harness stats` | yes | yes |
| Installs denied by default | yes | yes |
| npm registry check when the user allows an install | no | yes |
| Red-first TDD, test-lock, tamper check | no | yes |
| Changed-line coverage | no | yes |

Installs of any kind (JS or Python) are denied by default. To allow them, run the command yourself, or start Claude Code with `AGENT_GUARD_ALLOW_INSTALL=1`. Then you approve each install. JS package names are checked on the npm registry first (unless `checks.depVerify` is `false`). Python installs get a plain ask.

Where a gate is off for the repo's stack, `init` and `status` say so in plain words.

The multi-file gate never counts test files: JS/TS `*.test.*`, `*.spec.*` and `__tests__/`, and Python `test_*.py`, `*_test.py`, `conftest.py` and `.py` files under `tests/`. Writing a test and then its code is one change.

`init` adds a Stop step only when its tool is on PATH (for a script step, the package manager that runs it), and lists the steps it left out. At Stop, a step whose tool is not found is skipped instead of blocking: you get a warning once per session to install it or edit `stop.steps`, and a `stop-tool-missing` event is logged. Any other step failure still blocks.

TDD needs a JSON test reporter and coverage output. `init` shows the edit to your Vitest config or Jest `test` script in its plan, and writes nothing until you confirm or pass `--yes`. For Jest, `init` also installs a small reporter, `.harness/hooks/jest-results.cjs` (commit it like the dispatcher), and adds it to the `test` script with `--outputFile` and `--coverage`. The reporter creates the results folder, which a fresh clone doesn't have. The same edit tells Jest to ignore `.harness/`. For Vitest, `init` turns coverage on only when `@vitest/coverage-v8` or `@vitest/coverage-istanbul` is in the package's or the workspace root's dependencies, or in `node_modules`. Without one, it still adds the JSON reporter (TDD works), lists the package in `tdd.coverage_skip` so changed-line coverage skips it, and `init`, `status` and `doctor` say "install @vitest/coverage-v8 to turn on the coverage gate". After you install it, `doctor` tells you to run `harness update` and remove the package from `tdd.coverage_skip`. If a package's test config can't be edited safely, or a Vitest package has no config file, `init` prints the lines to add under "Do these by hand:" and leaves that package's `src/**` out of `tdd.paths`, so TDD is off for it. If no package is left, `checks.tdd` is `false`. `status` names each such package and why. `harness doctor` repeats the lines until they are in the config, then tells you to add `<package>/src/**` to `tdd.paths`. Harness never rewrites that config later. The "Do these by hand:" list also holds the ESLint ignore line when `init` can't add `.harness/` itself.

## Commands

Run these as `npx @khubaibqaiser/harness <command>`, or as `harness <command>` if it is installed. In Claude Code, the plugin skills cover `init`, `doctor`, `status`, `update` and `uninstall`.

| Command | What it does |
|---|---|
| `init [--yes\|--config <file>\|--dry-run]` | Detects your repo, shows recommended settings and the plan, then writes the files after you confirm. `--yes` accepts the recommended settings. `--config <file>` reads settings from a YAML file; it must be valid, and keys it leaves out keep the recommended value. `--dry-run` prints the settings and plan and writes nothing. |
| `status` | Shows each gate as on or off, with the reason when off, whether TDD is paused, the installed version and the last day of events. Exits 1 if the harness is not installed. |
| `doctor` | Checks Node, Claude Code, the hook wiring in `.claude/settings.json`, the dispatcher hash (and the Jest reporter's), `.harness/config.yaml`, the test reporter setup and that each Stop step can run. Prints a fix for each problem, and a `note` for a gate `init` turned off on purpose (a package left out of TDD, coverage off for lack of a provider) with what turns it on. Exit 0 means no problems (notes allowed), 1 means at least one problem. |
| `update [--yes\|--check\|--dry-run]` | Re-renders the installed files from your config with the harness version you run, and shows the diff before it writes. `--check` only asks npm whether a newer version exists. |
| `uninstall [--yes\|--force\|--dry-run]` | Removes only what `.harness/manifest.json` lists and restores changed files from backup. A created file you edited is listed and kept unless you pass `--force`. A yes also deletes `.harness/`, including its logs, unless it kept edited files. Then `.harness/` and the manifest stay, so `--force` can finish later. |
| `stats [--days N]` | Counts harness events by check and decision, overrides, Stop failures and timeouts. The default is the last 7 days. |
| `tdd off\|on\|status` | `off` pauses the TDD layers for your next Claude Code session; the Stop gate and CI still apply. `on` resumes. `status` shows the state. |

`doctor`, `update` and `uninstall` compare files with `.harness/manifest.json` ignoring CRLF vs LF, so a teammate's checkout with `core.autocrlf=true` is not treated as edited, and the harness blocks are still found and removed.

`tdd off` is refused inside Claude Code. It prints "Run harness tdd off from a plain terminal, not inside Claude Code." Only a person can run it, in a plain terminal.

`init`, `update` and `uninstall` need a terminal to answer prompts. Without one, pass `--yes` (add `--config <file>` for `init`), or `--dry-run` to preview.

## Config reference

The file is `.harness/config.yaml`. `init` writes it. Keys that are unknown or invalid are ignored, with a warning, and the default is used. `harness doctor` reports them.

Defaults are what harness uses when a key is missing. `init` writes recommended values from your repo instead. It sets `checks.tdd`, `checks.multiFile` (for example `checks.multiFile: true`), `tdd.paths`, `tdd.exempt`, `stop.steps`, `stop.base_ref` and, when it finds one, `stop.package_manager`.

This table is generated by `node scripts/gen-config-docs.mjs --write`. A test fails if it drifts from the code.

<!-- config:start -->
| Key | Default | What it does |
|---|---|---|
| `version` | `1` | Config schema version. Value must be 1. |
| `checks.guard` | `true` | Guard: secret reads, force-push, pushing to main, installs. |
| `checks.protect` | `true` | Protected paths: `.harness/` and `.claude/settings*.json`. |
| `checks.depVerify` | `true` | npm registry check when you allow a JS install. When off, an allowed install is still confirmed with you. |
| `checks.multiFile` | `false` | Multi-file gate. |
| `checks.tdd` | `false` | Red-first TDD, test-lock and tamper check. |
| `checks.stop` | `true` | Stop gate. |
| `tdd.paths` | `[]` | Globs for the files TDD covers. |
| `tdd.exempt` | `[]` | Globs inside `tdd.paths` that TDD skips. |
| `tdd.diff_coverage` | `80` | Minimum coverage, in percent, for changed lines. Value must be a number from 0 to 100. |
| `tdd.coverage_skip` | `[]` | Globs inside `tdd.paths` that changed-line coverage skips. `init` lists a Vitest package here when no coverage provider is installed for it. |
| `tdd.test_lock` | `true` | Changing a test that was written failing needs your approval until it passes. |
| `tdd.results_dir` | `".harness/state/test-results"` | Where the test reporters write JSON results. Keep it inside `.harness/state`. |
| `multi_file_gate.generated` | `[]` | Globs for generated files that the multi-file gate does not count. |
| `unattended.multi_file_gate` | `"block"` | What the multi-file gate does when no human is watching. Value must be one of block, allow-log, off. |
| `unattended.require_reason` | `false` | With `allow-log`, extra files need a one-line reason. No effect while the gate is `block`. |
| `stop.steps` | `["format:check","lint","typecheck","test"]` | Commands that must pass before the agent may stop. Value must be a list of script names or { name, run } objects. |
| `stop.package_manager` | `"pnpm"` | Used to run script-name steps. Value must be one of npm, pnpm, yarn, bun, none. |
| `stop.max_attempts` | `3` | How many times the Stop gate blocks before it gives up and lets the agent stop. Value must be an integer from 1 to 10. |
| `stop.timeout_s` | `540` | Seconds the Stop steps may run in total. Value must be an integer from 30 to 550. |
| `stop.base_ref` | `"origin/main"` | Git ref that changed lines are compared with. |
| `stop.coverage_globs` | `["**/coverage/coverage-final.json"]` | Globs for the coverage files that diff coverage reads. |
<!-- config:end -->

## Known limits

- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- No npm provenance while the repo is private.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- Out of the beta: the PR reviewer, the interview and catalog, committing during `init`, and TDD for other languages.

## Not yet verified

- The TDD gate has not been run against a real Vitest or Jest run in CI.
- The plugin has not been run in live Claude Code sessions.
- Installing the plugin from the private marketplace through its npm source is not verified yet.
- The package is not published yet. `npx @khubaibqaiser/harness` and the marketplace pin to `0.1.0-beta.0` only work after the first release.

## Reporting feedback

Open a GitHub issue in the private repo `KhubaibQaiser/harness`. Say what you ran, what you expected and what happened. Paste the output of `harness doctor` and `harness status`.
