# @khubaibqaiser/harness

Harness is a set of Claude Code hooks that check what an agent does in your repo. It blocks secret reads and risky shell commands, protects its own files, asks before an agent spreads one change across many files, enforces red-first TDD for JS/TS, and runs your format, lint, typecheck and test commands before the agent may stop. It installs into any git repo, as a Claude Code plugin or with a CLI, and commits its hooks into the repo so every teammate gets the same rules.

Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt.

Status: private beta, version `0.1.0-beta.0`. See [Project status](#project-status).

## Why it exists

Rules written in `CLAUDE.md` or `AGENTS.md` are advice. An agent can skip "write a failing test first" or "don't touch `.env`" when it is busy. Harness turns those rules into hooks that Claude Code runs on every tool call. A hook can deny the call, ask you, or block the agent from stopping, and its message names the next step.

## How it works, and how it differs

- **Hooks, not prompts.** The rules run as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `ConfigChange`, `Stop` and `SessionEnd` hooks. `AGENTS.md` gets a short block that explains the rules, but the hooks enforce them.
- **Deterministic.** The hooks call no model. They read the tool call, your test results, coverage files and `git diff`, and decide from those.
- **Tests decide, not the agent.** The TDD gate reads JSON results that your own Vitest or Jest run writes. A source edit needs a fresh failing test from this session.
- **Fails closed where it matters.** If the dispatcher can't start, times out or crashes, Claude Code blocks the tool call, the prompt or the settings change (`onFailure: "block"`). The Stop gate fails open if its process can't run. If `.harness/config.yaml` is invalid, agent edits are denied and Stop blocks until a person fixes it. The guard and protected-path checks deny the call if they crash.
- **Repo-level.** `init` writes plain files into the repo (`.harness/`, `.claude/settings.json`, `AGENTS.md`). Commit them, and the hooks run for anyone who opens the repo in Claude Code, with or without the plugin.
- **Local-first.** Events go to `.harness/logs/events.jsonl` in the repo. Nothing is sent anywhere, except an npm registry lookup for a package name when you allow an install, and `update --check`.
- **Reversible.** `init` backs up every file it changes and records every edit in `.harness/manifest.json`. `uninstall` removes exactly what the manifest lists and restores your files.
- **You confirm every write.** `init` and `update` show the full plan and diff first. Neither commits, pushes or opens a PR.

## Features

### Guard and protection (any repo)

- **Secret files.** Denies reads of `.env` and `.env.*` (but not `.example`, `.sample`, `.template` or `.dist`), SSH and GnuPG keys, AWS credentials, `id_rsa`-style keys, `.pem`, `.p12`, `.pfx`, `.keystore`, `.netrc`, `.pgpass` and Terraform state and vars, through `Read`, `Grep` and shell commands.
- **Dangerous commands.** Denies force-push (use `--force-with-lease`), pushing to `main` or `master`, `curl | sh`, `chmod 777`, writing to a block device and a recursive delete of root, home, `.` or `..`. Asks before `git reset --hard`, `git clean -f`, `sudo`, `npm publish`, recursive deletes outside build and cache folders, and destructive cloud, Kubernetes, Docker, GitHub and SQL commands.
- **Installs denied by default.** Package installs (JS or Python) are denied. See [Allowing installs](#allowing-installs).
- **Protected paths.** The agent may not edit `.harness/` or `.claude/settings*.json`, with an edit tool or a shell command that names the path. Inline interpreter code (`node -e`/`-p` and clusters such as `-pe`, `tsx -e`, `ts-node -e`, `bun -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `deno eval`, wherever it sits in the command, so behind any wrapper: `npx`, `cross-env`, `dotenv --`, `env -S`, `node@22` and the like; also a program fed to a shell or interpreter on stdin with `echo … |`, `printf … |`, `<<<` or a here-document) is denied too when the code itself, or an argument the same command passes to it, names one of those paths as a path segment, even for a read: a text match can't tell a read from a write. Other parts of a compound command (`cd node_modules/x && node -e …`, `cat .harness/config.yaml; node -p …`) don't count. A path assembled at run time is not caught.
- **Change detection.** The path checks above catch the obvious cases; they are a seatbelt. Behind them, harness keeps fingerprints of its own files: `.harness/config.yaml`, `.harness/manifest.json` and everything under `.harness/hooks/` (line endings ignored), and in `.claude/settings.json` and `settings.local.json` only what harness relies on (its hook entries, its own `permissions.deny` rules, `disableAllHooks`, `sandbox` and `env`; an "Always allow" click, which adds to `permissions.allow`, doesn't count). A session starts from the fingerprints the last session or harness CLI run left (on a fresh clone, from the files at its first hook). If they differ, from a change during the session or between sessions, your next prompt shows a notice once and the next Stop blocks once (also when a change shown at the prompt is undone before that Stop: the Stop says it is no longer there), naming the files and the commit to diff against (`git diff <start commit> -- .harness .claude/settings.json`, plus plain `git diff` for uncommitted changes), and saying when HEAD moved, for example after a branch switch. The block counts within `stop.max_attempts`, unattended runs block the same way, and the event shows in `status` and `doctor`. Changes made by `init`, `update` and `uninstall` don't trigger it; that record covers only the change the CLI made, so a later write that puts the files back to how the CLI left them is reported like any other. Your own edit to these files triggers it once. The fingerprints live in `.harness/state/`, so a script that also rewrites them can hide its change.
- **node_modules.** `node_modules` belongs to the package manager. The agent may not change anything under a `node_modules/` folder in the repo with an edit tool, or with a shell command that names the path: a redirect, `tee`, `sed -i`, `truncate`, `touch`, `ln`, `install`, `dd of=`, `cp` or `rsync` into it, `mv` into or out of it, `rm` (`rm -rf node_modules` included), `find … -delete` or `-exec rm`, `tar` extracting into it (`-C`) or creating an archive in it, `unzip -d` into it, and `git checkout`/`restore` of it. The message says to change `package.json` and run an install instead; installs still go through the install gate. Reading `node_modules` with a shell command (`cat`, `ls`, `grep`, `find` without `-delete`) and running files from it (`node node_modules/.bin/jest -c …`) are allowed. Inline interpreter code (`node -e`, `python -c` and the like) whose code or arguments name a `node_modules` path is denied even when it only reads, because a text match can't tell a read from a write.
- **Person-only commands.** The guard denies the agent `harness tdd off` and asks before it runs `harness uninstall`, in the forms listed under [Uninstall](#uninstall).

### Multi-file gate (any repo)

Asks you once per turn before the agent edits a second source file. Your yes covers the rest of the turn. Test files, snapshots, lockfiles and files in `multi_file_gate.generated` never count. In unattended runs you choose: block, allow and log, or off. See [Unattended runs and CI](#unattended-runs-and-ci).

### TDD gates (JS/TS with Vitest or Jest)

- **Red-first.** An edit to a file in `tdd.paths` is denied until a related test has a fresh failing result from this session.
- **Test-lock.** A test seen failing is locked until it passes. Changing it in the meantime needs your approval.
- **Tamper check.** Denies edits that weaken tests to make them pass: adding `.skip`, `.only`, `.todo`, `xit` and similar, removing assertions, adding no-op assertions, lowering coverage thresholds, turning coverage off, enabling `passWithNoTests` or changing which tests run.
- **Spec gate.** A feature in a root `features.json` may only become `passes: true` when each criterion names a test that just passed.
- **Pause.** A person can pause the TDD layers for one session with `harness tdd off`.

### Stop gate (any repo)

Before the agent may stop, harness runs the steps in `stop.steps`: script names run with your package manager, or `{ name, run }` commands for any language. In a JS/TS repo with TDD on, it then checks that changed lines (against `stop.base_ref`) have at least `tdd.diff_coverage` percent coverage. A failing step blocks the stop and shows the end of its output, up to `stop.max_attempts` times.

### Review agent (experimental)

Experimental: it has not had live review runs yet. `init` also adds a `staff-reviewer` agent (`.claude/agents/staff-reviewer.md`) and its `review-rubric` skill (`.claude/skills/review-rubric/SKILL.md`). The agent reviews a diff you give it in a fresh context and reports findings. It cannot edit files.

### What each repo gets

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

Where a gate is off for the repo's stack, `init` and `status` say so in plain words.

## Requirements

- Node 22.11 or newer
- git, and a git repo to install into
- Claude Code 2.1.314 or newer. Older versions are untested with these hooks.
- On Windows, CI runs the tests, but live Claude Code use is untested (see [Known limits](#known-limits)).

## Quick start

The npm package is not published yet. Until the first release, install from source.

### From source (works today)

You need collaborator access to the private repo `KhubaibQaiser/harness`, and pnpm (the repo pins its version in `package.json`; `corepack enable` provides it).

```bash
git clone https://github.com/KhubaibQaiser/harness.git
cd harness
pnpm install
pnpm build
```

Then, in the repo you want to protect:

```bash
cd /path/to/your-repo
node /path/to/harness/dist/cli.mjs init --dry-run
node /path/to/harness/dist/cli.mjs init
```

`--dry-run` prints the recommended settings and the plan and writes nothing. Without it, `init` shows the same and asks before it writes. Commit the files it lists, then start Claude Code in the repo.

### With the plugin (after the first release)

The marketplace entry pins the npm package, so this works only after `0.1.0-beta.0` is published.

```bash
claude plugin marketplace add KhubaibQaiser/harness
claude plugin install harness@harness
```

Then, inside your repo in Claude Code:

```
/harness:init
```

The skill runs `init --dry-run`, asks you which settings to change, shows the plan and writes only after your yes. The plugin also gives you `/harness:doctor`, `/harness:status`, `/harness:update` and `/harness:uninstall`. They run the CLI bundled with the plugin, so plugin and CLI are always the same version.

### With npx (after the first release)

```bash
npx @khubaibqaiser/harness init
```

This does the same thing in a terminal.

### What `init` checks first

Run `init` anywhere in a git repo: it installs at the repo root and prints that path. It refuses if the directory is not a git repo, if Node is older than 22.11, or if `.harness/manifest.json` already exists (use `update` then). It also stops if files it would change have uncommitted changes.

## Commands

Run these as `npx @khubaibqaiser/harness <command>` once released, as `node /path/to/harness/dist/cli.mjs <command>` from source, or as `harness <command>` if it is on your PATH. In Claude Code, the plugin skills cover `init`, `doctor`, `status`, `update` and `uninstall`. The examples below use `harness`; from source, replace it with `node /path/to/harness/dist/cli.mjs`.

| Command | What it does |
|---|---|
| `init [--yes\|--config <file>\|--dry-run]` | Detects your repo, shows recommended settings and the plan, then writes the files after you confirm. `--yes` accepts the recommended settings. `--config <file>` reads settings from a YAML file; it must be valid, and keys it leaves out keep the recommended value. `--dry-run` prints the settings and plan and writes nothing. |
| `status` | Shows each gate as on or off, with the reason when off, whether TDD is paused, the installed version and the last day of events. Exits 1 if the harness is not installed. |
| `doctor` | Checks Node, Claude Code, the hook wiring in `.claude/settings.json`, the dispatcher hash (and the Jest reporter's), `.harness/config.yaml`, the test reporter setup and that each Stop step can run. Prints a fix for each problem, and a `note` for a gate `init` turned off on purpose (a package left out of TDD, coverage off for lack of a provider) with what turns it on. Exit 0 means no problems (notes allowed), 1 means at least one problem. |
| `update [--yes\|--check\|--dry-run]` | Re-renders the installed files from your config with the harness version you run, and shows the diff before it writes. Like `init`, it stops if files it would change have uncommitted changes. `--check` only asks npm whether a newer version exists. |
| `uninstall [--yes\|--force\|--dry-run]` | Removes only what `.harness/manifest.json` lists, and restores the files `init` changed. See [Uninstall](#uninstall). |
| `stats [--days N]` | Counts harness events by check and decision, overrides, Stop failures and timeouts. The default is the last 7 days. |
| `tdd off\|on\|status` | `off` pauses the TDD layers for your next Claude Code session; the Stop gate and CI still apply. `on` resumes. `status` shows the state. |

`init`, `update` and `uninstall` need a terminal to answer prompts. Without one, pass `--yes` (add `--config <file>` for `init`), or `--dry-run` to preview.

## What `init` changes in your repo

| File | What happens |
|---|---|
| `.harness/hooks/dispatch.mjs` | Created. The hook dispatcher every hook runs. Commit it. |
| `.harness/config.yaml` | Created. Your settings (see [Configuration](#configuration)). |
| `.harness/manifest.json` | Created. Every file and block `init` wrote, with hashes, so `uninstall` can undo it. |
| `.claude/settings.json` | Created or merged. Adds the hook entries and `permissions.deny` rules for `.env` reads and edits to harness files. Hooks from other tools are kept. |
| `AGENTS.md` | Created or merged. Adds a block between `<!-- harness:start -->` and `<!-- harness:end -->` that explains the rules. |
| `CLAUDE.md` | Created as `@AGENTS.md`, or that line is appended, unless it already imports `AGENTS.md`. |
| `.gitignore` | Adds `.harness/state/`, `.harness/logs/`, `.harness/backup/` and `.harness/results/`. |
| `.claude/agents/staff-reviewer.md`, `.claude/skills/review-rubric/SKILL.md` | Created. The review agent and its rubric. |
| `.prettierignore`, `.eslintignore`, ESLint flat config | Adds `.harness/` so your format and lint steps skip the harness files. |
| `.harness/hooks/jest-results.cjs` | Created in a repo with Jest. A small reporter that writes JSON results. |
| Vitest config or Jest `test` script | Edited when TDD is on, to write JSON results and coverage. Shown in the plan first. |

Before any write, `init` backs up every file it will change into `.harness/backup/`. If a step fails, it restores the backups, deletes what it created and exits non-zero. Edits keep each file's line endings, trailing newline and JSON indentation.

## Uninstall

Close open Claude Code sessions in the repo first. An open session keeps hooks that point at the removed dispatcher, and with `onFailure: "block"` every call blocks until it restarts.

```bash
harness uninstall --dry-run
harness uninstall
```

`uninstall` removes only what `.harness/manifest.json` lists. A merged file (`AGENTS.md`, `.gitignore`, the settings, a test config) that you have not edited comes back from the backup `init` made. That backup is gitignored, so on a teammate's clone, and for any merged file you edited (also when `update` changed it later), uninstall removes only the harness blocks and keeps the rest of the file. If `init` replaced the text between existing `AGENTS.md` harness markers, that old text cannot be restored. A harness file you edited, such as `.harness/config.yaml`, is listed and kept unless you pass `--force`; a merged file is never deleted whole. A yes also deletes the rest of `.harness/`, including its logs. Answering no at that prompt keeps `.harness/` and its `.gitignore` lines, so the logs and backups stay out of git. Harness is uninstalled either way: the manifest goes, so `status` and `doctor` report it as not installed and `init` can run again.

`doctor`, `update` and `uninstall` compare files with `.harness/manifest.json` ignoring CRLF vs LF, so a teammate's checkout with `core.autocrlf=true` is not treated as edited, and the harness blocks are still found and removed.

The guard asks you before the agent runs `harness uninstall`, and denies it in an unattended run; `uninstall --dry-run` needs no approval. It looks where a command runs: at the start of a command, after `&&`, `;` or `|`, and after the wrappers it knows, with their flags and flag values: `npx`, `npm exec`/`npm x`, `pnpm dlx`/`pnpm exec`, `pnpx`, `yarn dlx`, `bunx`/`bun x`, `node …/cli.mjs`, `env`, `sudo`, `command`, `nohup`, `time`, `nice`, `timeout`, `stdbuf`, `xargs`, `script`, `sh -c`/`bash -c`, `find -exec`, and a package script that runs harness. Windows forms count too: backslash paths with or without a drive letter, quoted or not (a quoted or `\ `-escaped path with a space is one word, also inside an `sh -c`, `bash -c` or `script -c` payload), and the `harness.cmd`/`npx.cmd` shims, in any case. It is a seatbelt, not a sandbox: a wrapper it does not know, or a command built at run time, can still get past it. Harness words in other places, such as a commit message, an `echo`, a `grep` or `rg` pattern, or a path argument, are not treated as a command. When the guard tells you to run a command yourself, it names the harness CLI by its absolute path only when that CLI is the repo's own install: its real path (symlinks resolved) is inside the repo's root `node_modules`, under `@khubaibqaiser/harness`. pnpm's links into `node_modules/.pnpm` count, a link out of the repo does not. This is a location check, not a content check: see [Known limits](#known-limits). Read the printed command before you run it. The path is the one you typed, or the one the last such CLI run recorded in the gitignored `.harness/state/`, checked again before it is printed. A plugin install, a global install, a workspace package's `node_modules` or any other copy is not trusted. In those cases, and on a fresh clone or from a source checkout, it prints plain `harness tdd off` with a hint that also shows the `npx @khubaibqaiser/harness` and `node /path/to/harness/dist/cli.mjs` forms.

## Unattended runs and CI

Harness treats a run as unattended when any of these is true:

- `CI` is `true` or `1`
- `HARNESS_UNATTENDED` is `1` or `true`
- `CLAUDE_CODE_REMOTE` is `true`
- Claude Code runs with permission mode `dontAsk` or `bypassPermissions`

In an unattended run, every hook question becomes a deny, because nobody can answer it. The multi-file gate follows `unattended.multi_file_gate`: `block` (the default) denies a second source file, `allow-log` allows it and logs it, and `off` skips the gate. Background subagents are not detected as unattended.

With `unattended.require_reason`, an extra file without a reason line is denied once, and the retry is allowed and logged as "no reason given". Claude Code writes a message to the transcript only after the hook for its tool call has run, so a reason written in the same message as the edit isn't visible yet. At Stop and at the next prompt, harness reads the transcript once more and logs `reason-found-late` with the line it finds, or `reason-not-found`.

Hooks run with the user's permissions, so they are a seatbelt, not a sandbox. Use CI and branch protection to enforce rules for everyone.

### Start unattended runs in the sandbox

With the default `sandbox: unattended`, an unattended shell command is denied unless Claude Code's sandbox is on. Start the run like this:

```sh
HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'
```

`--settings` sits above the project and local settings, and `failIfUnavailable` makes the run exit instead of running unsandboxed. A hook can't see `--settings`, so `HARNESS_SANDBOX=1` is your claim that the run was started this way. Only the person who launches the run can set it: the hooks inherit Claude Code's environment, not the agent's shell. A `HARNESS_SANDBOX` that a settings file sets in `env` is ignored, and a mid-session change to any settings `env` is blocked. Set it only together with the `--settings` above.

Without the variable, harness also accepts the sandbox when the settings files (managed, local, project, user) turn on `sandbox.enabled` with `allowUnsandboxedCommands: false`, and on Linux `bwrap` and `socat` are on the hooks' PATH. It reads the local, project and user files as they were when the session started, so a change made mid-session counts from the next session. Native Windows has no sandbox, so its unattended runs keep the text checks. To run unattended without the sandbox, set `sandbox: off` in `.harness/config.yaml`.

In an interactive session under `unattended`, the sandbox is off unless you turn it on. Turn it on before you start the session: set `sandbox.enabled: true` and `allowUnsandboxedCommands: false` in your settings, or launch with the `--settings` above. A sandbox change made mid-session, including with `/sandbox`, is blocked by the `ConfigChange` hook and takes effect in the next session. With `sandbox: always`, `update` writes the sandbox block into `.claude/settings.json` for everyone. Its network allowlist starts empty, so the first `npm install` or HTTPS `git push` prompts, and on macOS `git push` over SSH fails inside the sandbox. To allow a host, add it to `sandbox.network.allowedDomains` in `.claude/settings.json` yourself, outside a session.

## Windows

Native Windows has no sandbox. It gets the hooks, the permission rules and the text checks. The guard does not parse PowerShell: it runs its word rules on PowerShell text, and a PowerShell command that names `.harness`, `.claude` or `.env` asks, or is denied in an unattended run. The `PowerShell(...)` deny rules, and the `Read` and `Edit` rules on PowerShell commands, are unverified in live Claude Code. WSL2 gets the full sandbox.

## Force push

Turn on GitHub branch protection for your default branch. Harness's force-push and push-to-main rules are text rules, so a command they don't recognise gets past them.

## Managed settings (optional)

An admin can turn the sandbox on for every repo on a machine with managed settings. `init` never writes this file.

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false
  }
}
```

The file goes at:

- macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
- Linux and WSL2: `/etc/claude-code/managed-settings.json`
- Windows: `C:\Program Files\ClaudeCode\managed-settings.json`

Drop-in files in a `managed-settings.d/` folder next to it count too. Leave harness's hooks out of managed settings: a managed hook runs in every repo, and with `onFailure: "block"` it would block every repo without harness.

## Allowing installs

Installs of any kind (JS or Python) are denied by default. To allow them, run the command yourself, or start Claude Code with `AGENT_GUARD_ALLOW_INSTALL=1`. Then you approve each install.

```bash
AGENT_GUARD_ALLOW_INSTALL=1 claude
```

JS package names are checked on the npm registry first (unless `checks.depVerify` is `false`). A name that is not on the registry, is not a valid npm name, or was first published less than 14 days ago is denied. A name close to a dependency you already have gets a typo warning. Python installs get a plain ask.

## Configuration

The file is `.harness/config.yaml`. `init` writes it. If the file is not valid YAML, or has an unknown, mistyped or out-of-range key, harness fails closed: every agent edit, including a shell command that writes, moves or deletes a file in the repo, is denied, and Stop blocks (up to `stop.max_attempts` times), with a message naming the key or line, until a person fixes the file. Reads and other shell commands still run, so `harness doctor` can show every problem; it exits 1 until the file is valid.

Defaults are what harness uses when a key is missing. `init` writes recommended values from your repo instead. It sets `checks.tdd`, `checks.multiFile` (for example `checks.multiFile: true`), `tdd.paths`, `tdd.exempt`, `stop.steps`, `stop.base_ref` and, when it finds one, `stop.package_manager`.

A Stop step is a script name, run with `stop.package_manager`, or a command object run without a shell. For example, in a Python repo:

```yaml
stop:
  package_manager: none
  steps:
    - { name: lint, run: [ruff, check, .] }
    - { name: test, run: [pytest] }
```

After you edit the config, run `harness doctor` to check it.

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
| `sandbox` | `"unattended"` | `unattended`: required when nobody watches; `always`: on in every session; `off`: text checks only. Value must be one of unattended, always, off. |
| `tdd.paths` | `[]` | Globs for the files TDD covers. |
| `tdd.exempt` | `[]` | Globs inside `tdd.paths` that TDD skips. |
| `tdd.diff_coverage` | `80` | Minimum coverage, in percent, for changed lines. Value must be a number from 0 to 100. |
| `tdd.coverage_skip` | `[]` | Globs inside `tdd.paths` that changed-line coverage skips. `init` lists a Vitest package here when no coverage provider is installed for it, and a Jest package whose `coverageReporters` leaves out `json` or whose `coverageDirectory` (or preset) moves the output. |
| `tdd.test_lock` | `true` | Changing a test that was written failing needs your approval until it passes. |
| `tdd.results_dir` | `".harness/results"` | Where the test reporters write JSON results. Keep it inside `.harness/results`, which protect covers. Value must not be inside .harness/state (the sandbox denies it there). |
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

## Troubleshooting

Start with `doctor`. It prints a fix for each problem it finds.

```bash
harness doctor
harness status
```

- **A Stop step is skipped with a warning.** `init` adds a Stop step only when its tool is on PATH (for a script step, the package manager that runs it), and lists the steps it left out. At Stop, a step whose tool is not found is skipped instead of blocking: you get a warning once per session to install it or edit `stop.steps`, and a `stop-tool-missing` event is logged. The hooks see Claude Code's PATH, which can differ from your terminal's (for example when Claude Code starts from the GUI and `pnpm` comes from nvm or corepack). If the package manager is missing there, every script step is skipped and the warning says so. `doctor` checks your terminal's PATH and notes this. Any other step failure still blocks.
- **The agent is told to run a test first, but the test exists.** Red-first needs a fresh failing result from this session, not just a test file. Run the test, see it fail, then edit.
- **You need to pause TDD.** Run `harness tdd off` in your own terminal, not inside Claude Code. The guard denies it from the agent, and the CLI refuses it inside Claude Code, printing "Run harness tdd off from a plain terminal, not inside Claude Code" and the full command. It applies to your next Claude Code session.
- **Every edit is denied.** `.harness/config.yaml` is probably invalid. `doctor` names the key or line.
- **Format or lint fails on `.harness/` files.** `doctor` names a format or lint Stop step that would still check them. See [Format and lint ignores](#format-and-lint-ignores).

### TDD setup details

TDD needs a JSON test reporter and coverage output. `init` shows the edit to your Vitest config or Jest `test` script in its plan, and writes nothing until you confirm or pass `--yes`. For Jest, `init` also installs a small reporter, `.harness/hooks/jest-results.cjs` (commit it like the dispatcher), and adds it to the `test` script with `--outputFile` and `--coverage`. The reporter creates the results folder, which a fresh clone doesn't have. The same edit tells Jest to ignore `.harness/`. The script is not edited when it passes `--config`, `-c`, `--projects` or `--rootDir`, or when your Jest config sets `rootDir`, `reporters` or `modulePathIgnorePatterns` (a script flag would replace your value), or inherits settings harness can't read (a spread base config, `preset`, a function or a re-export). The lines to add by hand then include the merged values, or put the reporter in your config for an inherited one. An earlier beta's `--json --outputFile=...` script that can't be migrated gets a line telling you to remove it. `update` turns a script from an earlier beta (`--json --outputFile=...`) into the reporter form.

For Vitest, `init` turns coverage on only when `@vitest/coverage-v8` or `@vitest/coverage-istanbul` is in the package's or the workspace root's dependencies, or in `node_modules`. Without one, it still adds the JSON reporter (TDD works), lists the package in `tdd.coverage_skip` so changed-line coverage skips it, and `init`, `status` and `doctor` say "install @vitest/coverage-v8 to turn on the coverage gate". After you install it, `doctor` tells you to run `harness update` and remove the package from `tdd.coverage_skip`. A Jest package goes in `tdd.coverage_skip` the same way when its config sets `coverageReporters` without `json`, a custom `coverageDirectory`, or a preset or inherited config that could, since the gate reads `coverage/coverage-final.json`; `init`, `status` and `doctor` name the setting.

If a package's test config can't be edited safely, or a Vitest package has no config file, `init` prints the lines to add under "Do these by hand:" and leaves that package's `src/**` out of `tdd.paths`, so TDD is off for it. If no package is left, `checks.tdd` is `false`. `status` names each such package and why. `harness doctor` repeats the lines until they are in the config, then tells you to add `<package>/src/**` to `tdd.paths`. Harness never rewrites that config later.

Edits to a test config use the file's own quote style and, in an object laid out one property per line, the same layout, so a Prettier-clean config stays clean. When Prettier is installed in the repo (`node_modules` of the package or the repo root), `init` and `update` also run that Prettier, with your config and no shell, on the JS/TS configs they edit, if the file was Prettier-clean before. The manifest records the formatted change, so `uninstall` can undo it, then runs Prettier on the file again; with no other edits you get the original back, also on a teammate's clone. If Prettier fails, the edit stays unformatted, and `init` and `doctor` say so.

### Format and lint ignores

Your format and lint checks must skip the committed `.harness/` files. When Prettier is a dependency of the root or a workspace package, `init` adds `.harness/` to `.prettierignore`, creating the file if needed (`uninstall` removes the file, or only that line if you added others); an existing `.eslintignore` gets the line too. In an ESLint flat config, `init` adds `.harness/` to a global-ignores entry (an object whose only key is `ignores`), or appends `{ ignores: ['.harness/'] }` to the exported array. An ESLint `globalIgnores([...])` entry counts as global ignores. When the config is not a plain array, the "Do these by hand:" list holds the line instead.

### Guard details

The guard matches secrets paths without regard to case, and the way Windows resolves them: trailing dots and spaces, `::$DATA` streams, drive-relative `C:name`, and 8.3 short names. It can't map a short name (`~1`) back exactly, so it denies any short-name segment that could stand for a protected name. A short-name path through a folder that starts like one (for example `AWSADM~1`) is then denied too.

The multi-file gate never counts test files: JS/TS `*.test.*`, `*.spec.*` and `__tests__/`, and Python `test_*.py`, `*_test.py`, `conftest.py` and `.py` files under `tests/`. Writing a test and then its code is one change.

## Known limits

- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- The `PowerShell(...)` deny rules, and the `Read` and `Edit` rules on PowerShell commands, are unverified until a live check on Windows passes.
- The Stop gate fails open if its process can't run (`onFailure` has no effect on Stop, R§2).
- Native Windows has no sandbox: shell commands are checked by text only, and the guard doesn't parse PowerShell.
- Interactive sessions under the default `unattended` mode keep the text-check gaps (SEC-3, SEC-6, SEC-9, SEC-11) unless the person uses `/sandbox` or `always`.
- A blocked settings change still sits on disk; the next session loads it. Change detection reports it at the next prompt and Stop.
- Force-push and push-to-main rules are text rules; branch protection is the real stop.
- `HARNESS_SANDBOX=1` is the launcher's claim; harness can't see `--settings`.
- Results in `.harness/results/` can be forged by a program the agent runs.
- A flow-style `tdd: { results_dir: … }` isn't migrated by `update`; edit that one line by hand.
- MDM, registry and server-managed settings aren't read by `sandbox-required`. Only `managed-settings.json` and the `managed-settings.d/` drop-ins are read.
- A script that rewrites `.harness/state` can forge the CLI record. Protect covers file tools and named shell writes, and the sandbox denies it when unattended.
- Settings changes made mid-session through the harness CLI apply only to `.claude/settings.json`.
- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- No npm provenance while the repo is private.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- The CLI path the guard prints is trusted by location only (the repo's `node_modules/@khubaibqaiser/harness`). The agent can still put a copy there with commands protect doesn't parse, such as `git clone … node_modules/…`, `curl -o`/`wget -O`, `patch`, `git apply --directory`, or a `file:` dependency in `package.json` followed by an install. Read the printed command before you run it in your own terminal.
- The protected-path and `node_modules` rules read the paths a shell command names, and inline code only when it is literal in the command. Not seen by them: a program that writes files itself (a script file, a build script, an install hook), code that assembles a path at run time, a command hidden in a variable or built at run time, and quoting rules other than POSIX. Change detection reports a change to harness's own files from any of these at the next prompt and Stop, after the fact, unless the same script also rewrote the fingerprints in `.harness/state/`; it doesn't cover `node_modules` or other files.
- Out of the beta: the PR reviewer, the interview and catalog, committing during `init`, and TDD for other languages.

## Project status

This is a private beta. The repo is private, and test users get collaborator access.

Not yet verified:

- The plugin has not been run in live Claude Code sessions.
- Installing the plugin from the private marketplace through its npm source is not verified yet.
- The package is not published yet. `npx @khubaibqaiser/harness` and the marketplace pin to `0.1.0-beta.0` only work after the first release.

## Roadmap (not yet shipped)

None of this is in the beta. Plans can change.

- **Per-project recommend (M3).** `/harness:init` interviews you, recommends items from a closed catalog with reasons, installs your picks into the repo, writes an audit report, and offers to commit, push and open a PR. Adds `add`, `remove`, `why`, `explain` and `sync`. Design: [`docs/specs/2026-11-02-harness-recommend-design.md`](docs/specs/2026-11-02-harness-recommend-design.md).
- **PR size check.** A skill that plans how to split a large change, and a guard ask when the agent opens a PR over a size limit. Research: [`docs/research/2026-11-02-pr-size.md`](docs/research/2026-11-02-pr-size.md).
- **Memory.** A memory feature with its own spec after M3.
- **Later:** the PR reviewer, TDD for Python and other languages, and support for other coding agents.

## Development

```bash
pnpm install
pnpm build        # bundles dist/cli.mjs and dist/hooks/dispatch.mjs
pnpm test         # build, then the unit and e2e suites
pnpm test:perf    # build, then the hook latency suite (run it alone)
pnpm typecheck
pnpm lint
```

The config table in this README comes from the key rules in `src/core/config.ts`. After you change a key, regenerate it:

```bash
node scripts/gen-config-docs.mjs --write
```

CI runs typecheck, tests and the latency suite on Ubuntu, macOS and Windows with Node 22 and 24, plus a gitleaks scan, `npm pack --dry-run`, real Vitest and Jest installs and `claude plugin validate`. A release runs from a `v<version>` tag that matches `package.json`, and publishes only from a manual run on a tag that is on `main`.

## Reporting feedback

Open a GitHub issue in the private repo `KhubaibQaiser/harness`. Say what you ran, what you expected and what happened. Paste the output of `harness doctor` and `harness status`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
