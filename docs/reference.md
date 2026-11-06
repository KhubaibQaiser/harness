# Harness reference

The full detail behind the [README](../README.md). Start there; come here when you need the exact rules.

## How it works, and how it differs

- **Hooks, not prompts.** The rules run as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `ConfigChange`, `Stop` and `SessionEnd` hooks. `AGENTS.md` gets a short block that explains the rules, but the hooks enforce them.
- **Deterministic.** The hooks call no model. They read the tool call, your test results, coverage files and `git diff`, and decide from those.
- **Tests decide, not the agent.** The TDD gate reads JSON results that your own Vitest or Jest run writes. A source edit needs a fresh failing test from this session.
- **Fails closed where it matters.** If the dispatcher can't start or crashes, Claude Code blocks the tool call, the prompt or the settings change (`onFailure: "block"`). The Stop gate fails open if its process can't run. If `.harness/config.yaml` is invalid, agent edits are denied and Stop blocks until a person fixes it. The guard and protected-path checks deny the call if they crash.
- **Repo-level.** `init` writes plain files into the repo (`.harness/`, `.claude/settings.json`, `AGENTS.md`). Commit them, and the hooks run for anyone who opens the repo in Claude Code, with or without the plugin.
- **Local-first.** Events go to `.harness/logs/events.jsonl` in the repo. Nothing is sent anywhere, except an npm registry lookup for a package name when you allow an install, and `update --check`.
- **Timing log.** `.harness/logs/timing.jsonl` holds one line per Stop step (event, step, outcome, ms; hook calls are added in a later release), with no paths or command text. At 5 MB it is renamed to `timing.1.jsonl`, replacing the old one.
- **Reversible.** `init` backs up every file it changes and records every edit in `.harness/manifest.json`. `uninstall` removes exactly what the manifest lists and restores your files.
- **You confirm every write.** `init` and `update` show the full plan and diff first. Neither commits, pushes or opens a PR.

## Guard and protection (any repo)

- **Harness commands.** Asks before the agent runs `harness init`, `update`, `add`, `remove`, `sync` or `uninstall`, or pushes or opens a PR for harness changes. Previews such as `--dry-run`, and `scan`, `catalog` and `vet`, pass without asking.
- **Secret files.** Denies reads of `.env` and `.env.*` (but not `.example`, `.sample`, `.template` or `.dist`), SSH and GnuPG keys, AWS credentials, `id_rsa`-style keys, `.pem`, `.p12`, `.pfx`, `.keystore`, `.netrc`, `.pgpass` and Terraform state and vars, through `Read`, `Grep` and shell commands.
- **Dangerous commands.** Denies force-push (use `--force-with-lease`), pushing to `main` or `master`, `curl | sh`, `chmod 777`, writing to a block device and a recursive delete of root, home, `.` or `..`. Asks before `git reset --hard`, `git clean -f`, `sudo`, `npm publish`, recursive deletes outside build and cache folders, and destructive cloud, Kubernetes, Docker, GitHub and SQL commands.
- **Installs denied by default.** Package installs (JS or Python) are denied. See [Allowing installs](#allowing-installs).
- **Protected paths.** The agent may not edit `.harness/` or `.claude/settings*.json`, with an edit tool or a shell command that names the path. Inline interpreter code (`node -e`/`-p` and clusters such as `-pe`, `tsx -e`, `ts-node -e`, `bun -e`, `python -c`, `perl -e`, `ruby -e`, `php -r`, `deno eval`, wherever it sits in the command, so behind any wrapper: `npx`, `cross-env`, `dotenv --`, `env -S`, `node@22` and the like; also a program fed to a shell or interpreter on stdin with `echo … |`, `printf … |`, `<<<` or a here-document) is denied too when the code itself, or an argument the same command passes to it, names one of those paths as a path segment, even for a read: a text match can't tell a read from a write. Other parts of a compound command (`cd node_modules/x && node -e …`, `cat .harness/config.yaml; node -p …`) don't count. A path assembled at run time is not caught.
- **Change detection.** The path checks above catch the obvious cases; they are a seatbelt. Behind them, harness keeps fingerprints of its own files: `.harness/config.yaml`, `.harness/manifest.json` and everything under `.harness/hooks/` (line endings ignored), and in `.claude/settings.json` and `settings.local.json` only what harness relies on (its hook entries, its own `permissions.deny` rules, `disableAllHooks`, `sandbox` and `env`; an "Always allow" click, which adds to `permissions.allow`, doesn't count). A session starts from the fingerprints the last session or harness CLI run left (on a fresh clone, from the files at its first hook). If they differ, from a change during the session or between sessions, your next prompt shows a notice once and the next Stop blocks once (also when a change shown at the prompt is undone before that Stop: the Stop says it is no longer there), naming the files and the commit to diff against (`git diff <start commit> -- .harness .claude/settings.json`, plus plain `git diff` for uncommitted changes), and saying when HEAD moved, for example after a branch switch. The block counts within `stop.max_attempts`, unattended runs block the same way, and the event shows in `status` and `doctor`. Changes made by `init`, `update` and `uninstall` don't trigger it; that record covers only the change the CLI made, so a later write that puts the files back to how the CLI left them is reported like any other. Your own edit to these files triggers it once. The fingerprints live in `.harness/state/`, so a script that also rewrites them can hide its change.
- **node_modules.** `node_modules` belongs to the package manager. The agent may not change anything under a `node_modules/` folder in the repo with an edit tool, or with a shell command that names the path: a redirect, `tee`, `sed -i`, `truncate`, `touch`, `ln`, `install`, `dd of=`, `cp` or `rsync` into it, `mv` into or out of it, `rm` (`rm -rf node_modules` included), `find … -delete` or `-exec rm`, `tar` extracting into it (`-C`) or creating an archive in it, `unzip -d` into it, and `git checkout`/`restore` of it. The message says to change `package.json` and run an install instead; installs still go through the install gate. Reading `node_modules` with a shell command (`cat`, `ls`, `grep`, `find` without `-delete`) and running files from it (`node node_modules/.bin/jest -c …`) are allowed. Inline interpreter code (`node -e`, `python -c` and the like) whose code or arguments name a `node_modules` path is denied even when it only reads, because a text match can't tell a read from a write.
- **Person-only commands.** The guard denies the agent `harness tdd off` and asks before it runs `harness uninstall`, in the forms listed under [Uninstall](#uninstall).

## Multi-file gate (any repo)

Asks you once per turn before the agent edits a second source file. Your yes covers the rest of the turn. Test files, snapshots, lockfiles and files in `multi_file_gate.generated` never count. In unattended runs you choose: block, allow and log, or off. See [Unattended runs and CI](#unattended-runs-and-ci).

## PR size (any repo)

- Detected: `gh pr create` (also through wrappers, scripts and `bash -c`), and `git push` to a branch whose PR harness saw being created.
- Counted: the committed three-dot diff against the base, tests included. Not counted: `pr_size.exclude` (lockfiles, `.*ignore` files except `.npmignore` and `.harnessignore`, snapshots) and `multi_file_gate.generated` paths. A binary or deleted file is 1 file and 0 lines.
- Over `pr_size.max_lines` or `pr_size.max_files`, it asks you first; a push asks only when it grows the PR past what was recorded. Unattended, it is denied with how to split it.
- When it can't measure (no base ref, git missing, a timeout), the command runs with a note and a `pr-size-unmeasured` event.
- Each PR branch's base, lines and files are recorded in `.harness/state/pr-branches.json` after the create or push runs.
- `/pr-ship` measures the branch and splits it into stacked PRs of about `pr_size.target_lines` each.
- **Warnings while it grows.** After each edit (Edit, Write, MultiEdit, NotebookEdit) to a counted path in the repo, and once at Stop, harness measures the branch's committed and uncommitted change (untracked files included) against its base: the recorded PR base, else the default branch. It warns once when the change passes `pr_size.target_lines` and once more when it passes `pr_size.max_lines` or `pr_size.max_files`, not on every edit in between. A threshold resets when the size drops back to it or under (after a split, say), so the next crossing warns again. Attended, the agent is told to stop and ask you to split (with the `pr-ship` skill), keep going or raise the limit, and you see a one-line message; at Stop you get the message only. Unattended, the agent gets a note to keep going and split before opening a PR, and a Stop warning is only logged. Each warning logs a `pr-size-warned` event. The thresholds already announced, per branch, are kept in `.harness/state/pr-progress.json`. Harness's own `.harness/state/`, `logs/`, `backup/`, `results/` and `debug/` files never count here, gitignored or not. A detached HEAD, or a change it can't measure, gets no warning.

## TDD gates (JS/TS with Vitest or Jest)

- **Red-first.** An edit to a file in `tdd.paths` is denied until a related test has a fresh failing result from this session.
- **Test-lock.** A test seen failing is locked until it passes. Changing it in the meantime needs your approval.
- **Tamper check.** Denies edits that weaken tests to make them pass: adding `.skip`, `.only`, `.todo`, `xit` and similar, removing assertions, adding no-op assertions, lowering coverage thresholds, turning coverage off, enabling `passWithNoTests` or changing which tests run.
- **Spec gate.** A feature in a root `features.json` may only become `passes: true` when each criterion names a test that just passed.
- **Pause.** A person can pause the TDD layers for one session with `harness tdd off`.

## Stop gate (any repo)

Before the agent may stop, harness runs the steps in `stop.steps`: script names run with your package manager, or `{ name, run }` commands for any language. In a JS/TS repo with TDD on, it then checks that changed lines (against `stop.base_ref`) have at least `tdd.diff_coverage` percent coverage. A failing step blocks the stop and shows the end of its output, up to `stop.max_attempts` times.

## Review agent (experimental)

Experimental: it has not had live review runs yet. `init` also adds a `staff-reviewer` agent (`.claude/agents/staff-reviewer.md`) and its `review-rubric` skill (`.claude/skills/review-rubric/SKILL.md`). The agent reviews a diff you give it in a fresh context and reports findings. It cannot edit files. With `Mode: vet` (used by `/harness:vet`) it reads only the files a scan flagged and replies with one JSON review; it can add context to a scan but never lower a finding's severity.

## What `init` checks first

Run `init` anywhere in a git repo: it installs at the repo root and prints that path. It refuses if the directory is not a git repo, if Node is older than 22.11, or if `.harness/manifest.json` already exists (use `update` then). It also stops if files it would change have uncommitted changes. `harness doctor` also fails when Claude Code is older than 2.1.314. It also notes (never fails) when the default branch is unprotected, or protected without a required check that matches a lint or test job in `.github/workflows`; it asks `gh`, and says "unknown" when `gh` is missing or signed out.

## What `init` changes in your repo

| File | What happens |
|---|---|
| `.harness/hooks/dispatch.mjs` | Created. The hook dispatcher every hook runs. Commit it. |
| `.harness/config.yaml` | Created. Your settings (see [Configuration](#configuration-details)). |
| `.harness/manifest.json` | Created. Every file and block `init` wrote, with hashes, so `uninstall` can undo it. |
| `.claude/settings.json` | Created or merged. Adds the hook entries and `permissions.deny` rules for `.env` reads and edits to harness files. Hooks from other tools are kept. |
| `AGENTS.md` | Created or merged. Adds a block between `<!-- harness:start -->` and `<!-- harness:end -->` that explains the rules. |
| `CLAUDE.md` | Created as `@AGENTS.md`, or that line is appended, unless it already imports `AGENTS.md`. |
| `.gitignore` | Adds `.harness/state/`, `.harness/logs/`, `.harness/backup/` and `.harness/results/`. |
| `.claude/agents/staff-reviewer.md`, `.claude/skills/review-rubric/SKILL.md` | Created. The review agent and its rubric. |
| `.claude/skills/pr-ship/SKILL.md` | Created. The skill that splits a large change into stacked PRs. |
| `AGENTS.md` (preset on) | A second block between `<!-- harness:preset:start -->` and `<!-- harness:preset:end -->`, after the harness block. It stays if you turn `agents-md` off. |
| `.claude/skills/<name>/SKILL.md` (preset on) | Created for the preset's skills that match your stack (`engineering-principles`, `frontend-react`, `frontend-nextjs`, `frontend-react-native`). Turning the preset off in `/harness:update` removes the ones you have not edited. |
| `.claude/settings.json` (preset on) | Adds `attribution: false` and the opt-out `env` keys of the items you chose (`DO_NOT_TRACK=1` for Impeccable, and the matching variable for Superpowers). Keys you already set are kept. |
| `update` (preset on) | Reloads the preset from its folder: a changed `core.md` replaces the preset block in place, and a skill whose stack is gone from `package.json` is removed (and dropped from `preset.items`) if you have not edited it. A skill that newly matches is only noted: run `/harness:update` and tick it. Answers with `"preset": null` turn the preset off and remove its block, skills and settings keys; the plugins it preselected stay selected. If the preset folder is gone, `update` says so and leaves its files as they are. |
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

`uninstall` removes only what `.harness/manifest.json` lists. A merged file (`AGENTS.md`, `.gitignore`, the settings, a test config) that you have not edited comes back from the backup `init` made. That backup is gitignored, so on a teammate's clone, and for any merged file you edited (also when `update` changed it later), uninstall removes only the harness blocks and keeps the rest of the file. If `init` replaced the text between existing `AGENTS.md` harness markers, that old text cannot be restored. A harness file you edited, such as `.harness/config.yaml`, is listed and kept unless you pass `--force`; a merged file is never deleted whole. A yes also deletes the rest of `.harness/`, including its logs, except `.harness/presets/`, which holds your own presets. Answering no at that prompt keeps `.harness/` and its `.gitignore` lines, so the logs and backups stay out of git. Harness is uninstalled either way: the manifest goes, so `status` and `doctor` report it as not installed and `init` can run again.

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

## Start unattended runs in the sandbox

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

## Configuration details

The file is `.harness/config.yaml`. `init` writes it. If the file is not valid YAML, or has an unknown, mistyped or out-of-range key, harness fails closed: every agent edit, including a shell command that writes, moves or deletes a file in the repo, is denied, and Stop blocks (up to `stop.max_attempts` times), with a message naming the key or line, until a person fixes the file. Reads and other shell commands still run, so `harness doctor` can show every problem; it exits 1 until the file is valid.

A list you set, such as `pr_size.exclude`, replaces the whole default list.

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

The key table is under [Configuration keys](#configuration-keys).

## TDD setup details

TDD needs a JSON test reporter and coverage output. `init` shows the edit to your Vitest config or Jest `test` script in its plan, and writes nothing until you confirm or pass `--yes`. For Jest, `init` also installs a small reporter, `.harness/hooks/jest-results.cjs` (commit it like the dispatcher), and adds it to the `test` script with `--outputFile` and `--coverage`. The reporter creates the results folder, which a fresh clone doesn't have. The same edit tells Jest to ignore `.harness/`. The script is not edited when it passes `--config`, `-c`, `--projects` or `--rootDir`, or when your Jest config sets `rootDir`, `reporters` or `modulePathIgnorePatterns` (a script flag would replace your value), or inherits settings harness can't read (a spread base config, `preset`, a function or a re-export). The lines to add by hand then include the merged values, or put the reporter in your config for an inherited one. An earlier beta's `--json --outputFile=...` script that can't be migrated gets a line telling you to remove it. `update` turns a script from an earlier beta (`--json --outputFile=...`) into the reporter form.

For Vitest, `init` turns coverage on only when `@vitest/coverage-v8` or `@vitest/coverage-istanbul` is in the package's or the workspace root's dependencies, or in `node_modules`. Without one, it still adds the JSON reporter (TDD works), lists the package in `tdd.coverage_skip` so changed-line coverage skips it, and `init`, `status` and `doctor` say "install @vitest/coverage-v8 to turn on the coverage gate". After you install it, `doctor` tells you to run `harness update` and remove the package from `tdd.coverage_skip`. A Jest package goes in `tdd.coverage_skip` the same way when its config sets `coverageReporters` without `json`, a custom `coverageDirectory`, or a preset or inherited config that could, since the gate reads `coverage/coverage-final.json`; `init`, `status` and `doctor` name the setting.

If a package's test config can't be edited safely, or a Vitest package has no config file, `init` prints the lines to add under "Do these by hand:" and leaves that package's `src/**` out of `tdd.paths`, so TDD is off for it. If no package is left, `checks.tdd` is `false`. `status` names each such package and why. `harness doctor` repeats the lines until they are in the config, then tells you to add `<package>/src/**` to `tdd.paths`. Harness never rewrites that config later.

Edits to a test config use the file's own quote style and, in an object laid out one property per line, the same layout, so a Prettier-clean config stays clean. When Prettier is installed in the repo (`node_modules` of the package or the repo root), `init` and `update` also run that Prettier, with your config and no shell, on the JS/TS configs they edit, if the file was Prettier-clean before. The manifest records the formatted change, so `uninstall` can undo it, then runs Prettier on the file again; with no other edits you get the original back, also on a teammate's clone. If Prettier fails, the edit stays unformatted, and `init` and `doctor` say so.

## Format and lint ignores

Your format and lint checks must skip the committed `.harness/` files. When Prettier is a dependency of the root or a workspace package, `init` adds `.harness/` to `.prettierignore`, creating the file if needed (`uninstall` removes the file, or only that line if you added others); an existing `.eslintignore` gets the line too. In an ESLint flat config, `init` adds `.harness/` to a global-ignores entry (an object whose only key is `ignores`), or appends `{ ignores: ['.harness/'] }` to the exported array. An ESLint `globalIgnores([...])` entry counts as global ignores. When the config is not a plain array, the "Do these by hand:" list holds the line instead.

## Guard details

The guard matches secrets paths without regard to case, and the way Windows resolves them: trailing dots and spaces, `::$DATA` streams, drive-relative `C:name`, and 8.3 short names. It can't map a short name (`~1`) back exactly, so it denies any short-name segment that could stand for a protected name. A short-name path through a folder that starts like one (for example `AWSADM~1`) is then denied too.

The multi-file gate never counts test files: JS/TS `*.test.*`, `*.spec.*` and `__tests__/`, and Python `test_*.py`, `*_test.py`, `conftest.py` and `.py` files under `tests/`. Writing a test and then its code is one change.

## The `/harness:init` flow

The full flow runs only inside Claude Code, where Claude does the interview and the recommendations. The CLI stays deterministic: Claude passes it files, and it checks them.

1. **Scan.** It reads your repo and shows what it found.
2. **Interview.** Claude asks one question at a time: scope first, then "Use a named preset?" ("No preset" is the default; `harness preset list` shows the others), then gaps the scan can't answer. It drafts `product.md` for you to edit. It reads only files you point to, never dotenv files or `.harnessignore` paths, and credentials are names only.
3. **Recommend.** A fresh-context reviewer audits the repo against the catalog and proposes items and a report.
4. **Select.** You tick items, four per question, with the reason, context cost and side effects of each. With a preset, its rows are ticked and say they came from it.
5. **Apply.** It shows the plan, the preset's extra lines (Impeccable's hooks and download, the opt-out variables, the attribution setting) and the always-loaded context from harness. If that goes over the budget (2000 tokens by default), it asks once. Then you confirm separately: apply the changes, and, if you picked plugins, install them now.
6. **Git.** Each of branch, commit, push and PR is its own question. Nothing runs without a yes.

It writes the same files as `init`, plus `.harness/context/product.md` and `.harness/report.md`.

## Teammates

The hooks are in the repo, so a teammate needs nothing for them. Plugins you picked are pinned in `.claude/settings.json`, but each person installs them in their own Claude Code. After pulling, a teammate runs `claude plugin install <id> --scope project` for each, or `/harness:sync --install-plugins`. `harness doctor` lists the ones that are missing. Claude Code asks each user to approve MCP servers and, for the pinned marketplace, to trust the folder.

## Commands in full

The plugin adds `/harness:init`, `/harness:doctor`, `/harness:status`, `/harness:update`, `/harness:add`, `/harness:sync`, `/harness:uninstall` and `/harness:vet`. In a plain terminal, `init` and `update` print `Run /harness:init inside Claude Code` and exit.

Run each terminal command as `harness <command>`. From source, use `node /path/to/harness/dist/cli.mjs <command>`.

**Inside Claude Code only:**

| Command | What it does |
|---|---|
| `init [--yes\|--config <file>\|--dry-run]` | Detects your repo, picks catalog items, shows the plan, then writes after you confirm. Run it as `/harness:init`. |
| `update [--yes\|--check\|--dry-run\|--plan]` | Re-renders the installed files with this version and shows the diff first. Run it as `/harness:update`. `--check` only looks for a newer version and also works in a terminal. `--plan` writes nothing and prints JSON: whether to re-recommend (the catalog or your project facts changed), what changed in the catalog, and which answers to ask again. Items that left the catalog are dropped from the selection with a line saying why, but their files are kept. With `--answers`, update takes a partial file and changes only the keys it holds (`project`, `apps`, `unattended`, `tdd`); the rest of `config.yaml` stays as it is. |
| `add <id> [--over-budget\|--dry-run\|--yes] [--take <file,...>]` | Adds one catalog item, with what it requires. Run it as `/harness:add <id>`. Refuses when the item conflicts with an installed one. Shows the diff and the context budget first, and with `--yes` stops when it would go over budget unless you pass `--over-budget`. Only items harness installed count as approved and are exempt from the budget; one you selected by hand in `config.yaml` and never installed is counted (and `add`, `update` and `sync` all agree on that). Like `sync`, it keeps a harness file you edited and lists it; name it in `--take` to replace it. Merged files (AGENTS.md, settings, `.mcp.json`) can't be taken. |
| `sync [--dry-run\|--yes] [--take <file,...>] [--install-plugins] [--over-budget]` | Fixes drift between `config.yaml`, the manifest and the files. Run it as `/harness:sync`. Restores missing files of selected items, and removes the files and records of items you unselected. A file you edited that harness wrote whole is kept and listed unless you name it in `--take`. In AGENTS.md, settings and `.mcp.json`, your content is never touched: sync changes only harness's own parts and lists the file. A selected item that was never installed counts against the context budget like `add`. The preview lists plugins that `claude plugin list` doesn't show; `--install-plugins` installs them and records the install (also on `init` and `update`), but only when `settings.json` has no edits besides the plugin entries. Otherwise it prints "not recorded" and `uninstall` keeps your content. Commit or stash `config.yaml` edits first. The agent has to ask before running it. |

**In a plain terminal:**

| Command | What it does |
|---|---|
| `status` | Shows each gate as on or off, and why. Also the catalog version, how many items are selected, how many selected plugins aren't installed, and the always-loaded context estimate. |
| `doctor` | Checks the install and prints a fix for each problem. Exits 1 if there is one. For installs with items it also reports the catalog version, items whose files or settings entries are missing (`/harness:sync` restores them), selected plugins that are enabled but not installed, plugin versions that differ from the catalog's pin, a plugin enabled from two marketplaces, an edited `harness-pins` marketplace or MCP server, and `checks` in `config.yaml` that differ from the selected items. It runs `claude plugin list` once; without `claude` it skips the plugin checks. |
| `uninstall [--yes\|--force\|--dry-run]` | Removes what harness added and restores your files. Close open Claude Code sessions first. |
| `remove <id> [--dry-run\|--yes] [--take <file,...>]` | Removes one installed item and what it wrote, and restores your files. Refuses while another installed item requires it. A file you edited, of this or another item, is kept and listed unless you name it in `--take`. The agent has to ask before running it. |
| `why <id>` | For an installed item: why it is there, the findings it addresses, its cost and its context. For one that isn't installed: why it is in the catalog and its cost. |
| `explain` | One line per installed item with its files, then the always-loaded context. |
| `stats [--days N]` | Counts harness events (the default is the last 7 days). |
| `report [--days N] [--open] [--export]` | Writes `.harness/reports/<YYYY-MM-DD>.html`, one file with no JavaScript and no external requests (a second run on the same day overwrites it). `--days N` is the window, a positive integer, default 14. `--open` opens the file with the system opener. `--export` also writes `<date>-export.json`: counts and rates only, with every string checked against an allowlist before it is written. Only sessions started inside the repo or one of its worktrees are read, and the terminal output is counts only. Install and `harness update` add `.harness/reports/` to the root `.gitignore`; until then the `reports/` folder gets its own `.gitignore` containing `*`. Exit 0 when a report is written (also with no sessions), 2 on bad arguments, 1 when the folder can't be written. It reads the timing log, `.harness/logs/timing.jsonl`, for the latency tables. |
| `eval [--kind skills\|rules\|gates] [--runs N] [--max-cost-usd X] [--model <id>]` | Runs `claude plugin eval` on a plugin built in a temp folder outside the repo. **It costs money.** It prints the plan and an estimate, then asks you to type `yes` on every run; any other answer stops it. Defaults: all kinds, `--runs 3`, `--max-cost-usd 2` (the ceiling is not saved; spend can pass it by up to one agent run), model `claude-haiku-5-5`. It refuses without a terminal, inside Claude Code, or when `CI` is `true` or `1`. Results are saved under `.harness/reports/evals/<date>/`, and the next `report` shows them. `gates` is not available yet. |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. `off` works only in your own terminal. |
| `scan` | Prints the facts harness detects about your repo, as JSON. Writes nothing. |
| `catalog` | Prints the catalog of items harness can install, as JSON. |
| `catalog check [--resolve] [--only <id,...>]` | Checks the catalog for problems. `--resolve` also looks up each pin, which needs the network. `--only` limits that to the listed ids. |
| `preset list` | Prints `<id>  <description>` for each shipped and repo preset (`.harness/presets/`), or `No presets.`. Writes nothing. |
| `preset check <dir>` | Checks every `<id>.yaml` in `<dir>` with its `<id>/` folder: schema, items, templates, skill limits, no email or git identity, and an id that isn't a shipped preset's (unless `<dir>` is the shipped folder). Prints `ok` or one error per line. `catalog check` also checks each shipped preset, as `presets/<id>: <error>`. |
| `validate answers\|product <file> [--merge-config]` | Checks an interview answers file or a product file. With `--merge-config`, an answers file holding only some keys is laid over the answers in `.harness/config.yaml` first (what `/harness:update` uses). |
| `validate picks <file> --answers <file> [--merge-config] [--attempt 1\|2]` | Checks a picks file against the answers and the catalog. `--merge-config` works as above. |
| `validate report <file> --picks <file> [--attempt 1\|2]` | Checks a report file against the picks. |
| `validate vet-review <file> --scan <file> [--attempt 1\|2]` | Checks a vet reviewer's `vet-review.json` against the scan (`harness vet --json`) and the installed items. |
| `vet <target> [--json]` | Pins a GitHub plugin or skill to a commit, scans it without running it, and writes `.harness/vet/<id>-<sha>.md`. Installs nothing. |
| `vet <target> --json [--keep]` | Prints the scan as JSON and writes no report. `--keep` adds `dir` and `map` and keeps the unpacked folder (under the OS temp dir) for a reviewer. `map` lists only the in-scope files unpacked under another name (such as `CLAUDE.md.vetted`), keyed by the file name the findings use. |
| `vet --finish <scan.json> --review <file>` | Checks the reviewer's file like `validate vet-review`, writes the report with the review, then deletes the kept folder. |
| `node .harness/hooks/dispatch.mjs --pr-size [--base <name>] [--head <name>] [--worktree]` | Measures the current branch's PR size (with `--worktree`, it also counts staged, unstaged and untracked changes, and `head` is `working tree`) and prints it as JSON (`base`, `head`, `lines`, `files`, `target_lines`, `max_lines`, `max_files`, `over`, `top`, `excluded`). Exits 0 within the limit, 1 over it, 2 when it can't measure (the JSON then holds `error`). Works in every clone, including cloud sessions, since it needs no `harness` install. |
| `vet --install <scan.json>` | Prints the install commands and the sha-pinned marketplace entry from that scan's report. |
| `vet --clean` | Removes every `harness-vet-*` folder of this OS user, including other projects' folders and runs still in progress. Skips and counts any it can't remove. |
| `select --picks <file> [--preset <id> --answers <file>] [--choose <id,...>]` | Without `--choose`, prints the checklist of picked items. With it, prints the chosen ids, notices and the `selected` entries. With `--preset` (which needs `--answers` for the project type), the checklist also has ticked rows for the preset's core and skills that match the stack, and for its stack-matched preselects you did not pick; ids of the preset's own items come back as `preset_items`. Each checklist row also has `unpinned` ("Runs unpinned code at launch.") and `unpinned_reason` for items whose catalog entry sets `unpinned_runtime`. |
| `git branch\|commit\|push\|pr [--title <t>]` | Commits and pushes the harness changes one step at a time. `branch` creates `chore/ai-workflow-<catalog version>`; `commit` stages only the files harness wrote, with your own git name and email; `push` and `pr` never touch the default branch. `pr` needs `gh` signed in, else it prints the command. The agent asks you before `push` and `pr`. |
| `git branch --suggest <topic>` | Prints one branch name per preset prefix (feature, fix, hotfix, chore, refactor, docs, ci) and creates nothing. With a preset that sets `no_ai_trailer`, `git commit` refuses a set `git.commit_trailer`; with `pr_size_warning`, `git pr` prints a size warning before it creates the PR. |

`scan`, `catalog`, `validate` and `select` write nothing. They are the steps `/harness:init` calls; you can run them to see what it sees.

Without a terminal, pass `--yes` or `--dry-run`.

`init` writes `.harness/` (the dispatcher, config and manifest) and merges hook entries and deny rules into `.claude/settings.json`. It also adds a short block to `AGENTS.md` (imported from `CLAUDE.md`), `.gitignore` lines, and the review agent. When TDD is on, it edits your test config so tests write JSON results. It then writes the items you chose, the plugin pins in `.claude/settings.json` and the servers in `.mcp.json`, described below. The full list is in [What `init` changes in your repo](#what-init-changes-in-your-repo).

### AI flags for init and update

Inside Claude Code, `/harness:init` and `/harness:update` take the files the interview produced. `init` requires all five. `update` requires all but `--answers`, which may hold only the re-asked keys or be left out:

- `--answers <file> --product <file> --picks <file> --report <file>`
- `--choose <id,...>`: the item ids you picked from the checklist.

Two more flags are optional:
- `--install-plugins` runs the plugin installs for the chosen items (see Plugins and MCP servers).
- `--over-budget` accepts a selection over the context budget when you also pass `--yes`.

### Ignoring paths

`harness scan` and `init` skip the paths listed in `.harnessignore` at the repo root. It uses gitignore-style lines: `#` comments, a leading `/` anchors a pattern, a trailing `/` means a directory. A pattern without `/` matches at any depth. `!` negation isn't supported. Harness only reads this file.

## Context budget

Skills, agents and the `AGENTS.md` block are loaded into every Claude Code session. Each one costs tokens before you ask anything. Harness keeps a budget for that.

- **What counts.** Always-loaded text only. For a skill or agent, that's its name and description. For the `AGENTS.md` block, the whole block. The harness plugin's own skills are always counted. Hooks, settings and CI files count as 0.
- **Not measured.** Plugins, external skills and MCP servers can't be measured before install. They're listed as not measured, and the install asks you once.
- **An estimate.** The count is characters divided by 4, labelled `estimate`. It makes no API call and needs no API key.
- **The limit.** `context.budget_tokens`, default 2000. If a selection goes over it, `init` and `update` ask before installing. With `--yes`, they stop unless you pass `--over-budget`.
- **Ask once, then exempt.** Items you approved earlier show in the report but don't count toward the budget again.

## Plugins and MCP servers

Catalog items can be Claude Code plugins or MCP servers.

- **Plugins.** Harness pins each plugin to an exact source in an inline marketplace named `harness-pins`, written to `.claude/settings.json` along with `enabledPlugins`. It's committed, so every contributor gets the same pins. Each contributor still installs the plugins in their own Claude Code. `--install-plugins` runs `claude plugin install … --scope project` for you. If one fails, harness prints the command to run yourself.
- **MCP servers.** Harness writes them to `.mcp.json`. Claude Code asks each user to approve a project server before it runs. Harness can't approve it for them. A server with the same name that you wrote is kept and reported.
- **Removal.** `uninstall` removes the pins and servers it added and leaves yours.

## Vetting a plugin or skill

`/harness:vet <target>` runs `harness vet` and puts the staff-reviewer between the scan and the summary:

1. It unpacks the target to a temporary folder and scans it without running anything.
2. The reviewer reads only the flagged files and rates relevance, overlaps with installed items and injection-like text.
3. You get the summary and choose: show the install command, skip, or open the report.
4. If any finding is high, you must say yes a second time, with each high finding named.

What the scan reads:

- **Hooks wherever they are declared.** `hooks/hooks.json`, `plugin.json`, a file that `plugin.json`'s `hooks` names by path (whatever its extension), settings files, and the `hooks:` frontmatter of skills, commands and agents. A hook that runs a shell command is high, and so are settings keys that run one (`statusLine`, `apiKeyHelper` and the like). `allowed-tools` in a skill, command or agent, and a `permissionMode` other than `default`, `manual` (an alias for `default`) or `plan`, are medium `permissions` findings. Frontmatter over 16 KB, or frontmatter that isn't valid YAML and names `hooks`, `allowed-tools`, `permissionMode` or `mcpServers`, is a medium `invalid-manifest` finding, because it was not judged.
- **MCP servers** in `.mcp.json`, in `plugin.json`, in a file that `plugin.json`'s `mcpServers` names by path, and inline in an agent's `mcpServers` frontmatter.
- **Allow rules** in settings are medium `permissions` findings, 20 per file and then one `N more` line.
- **Every text file except prose.** Prose is a README, LICENSE, CHANGELOG, CONTRIBUTING, CODE_OF_CONDUCT or SECURITY file with no extension or a `.md`, `.txt`, `.rst` or `.adoc` one, and a file with one of those extensions under `docs/`. A script with such a name, or under `docs/`, is scanned.
- **Files it can't read are findings, not silence.** An in-scope file over 1 MB or a binary file is a medium `unsafe-archive` finding (`over 1 MB, not read`, `binary, not read`), and the summary's `Findings` line counts them. Like the other medium rules, each kind lists 20 files and then one `N more` line.

A scan can't prove an item is safe. It checks for known risky patterns only; read the high findings yourself before you install.

harness doesn't install or track vetted items: it only prints the install command for you to run.

## Configuration keys

The table below is generated from `src/core/config.ts` by `node scripts/gen-config-docs.mjs --write`. A Stop step and its format are shown in the README's Configuration section.

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
| `checks.prSize` | `true` | PR size: asks before `gh pr create`, or a push to a PR branch harness recorded, goes over `pr_size.max_lines` or `pr_size.max_files`. |
| `sandbox` | `"unattended"` | `unattended`: required when nobody watches; `always`: on in every session; `off`: text checks only. Value must be one of unattended, always, off. |
| `catalog_version` | `0` | Version of the catalog the recommendations came from. `0` means no catalog. |
| `project.type` | `""` | What kind of project this is. Empty until the interview sets it. Value must be one of web, landing, mobile, api, infra, library, other. |
| `project.domain` | `""` | What the project is about, in a few words. |
| `project.compliance` | `[]` | Compliance regimes that apply (for example `gdpr`). |
| `project.data_handling` | `""` | How the project handles personal or sensitive data. |
| `project.team_size` | `0` | People working on it. `0` means unknown. Value must be an integer from 0 to 10000. |
| `project.open_source` | `false` | Whether the repo is public. |
| `project.codeowners` | `[]` | Owners to consult. Input to recommendations only; harness writes no CODEOWNERS. |
| `project.deploy_target` | `""` | Where it is deployed. |
| `project.run_budget_usd` | `0` | Spend limit, in USD, for one unattended run. `0` means none set. Value must be a number from 0 to 100000. |
| `project.named_items` | `[]` | Catalog item ids the owner asked for by name. |
| `project.scope_paths` | `[]` | Repo-relative paths the recommendations are limited to. Empty means the whole repo. |
| `apps` | `[]` | Runnable apps (`dir`, `kind`, `install`, `start`, `ready_url`, `port`, `public_facing`, `login`). `login.credentials` holds file and variable names, never values. Value must be a list of app mappings. |
| `items` | `[]` | Catalog items chosen for this project (`id`, `include`, `selected`, `reason`, `addresses`, `pin`). Value must be a list of item mappings. |
| `git.commit_trailer` | `""` | Line added to the end of commit messages. Empty adds none. |
| `context.budget_tokens` | `2000` | Estimated tokens of always-loaded context harness may add before it asks you to confirm an install. Items you approved earlier are not counted. Value must be an integer from 0 to 200000. |
| `tdd.paths` | `[]` | Globs for the files TDD covers. |
| `tdd.exempt` | `[]` | Globs inside `tdd.paths` that TDD skips. |
| `tdd.diff_coverage` | `80` | Minimum coverage, in percent, for changed lines. Value must be a number from 0 to 100. |
| `tdd.coverage_skip` | `[]` | Globs inside `tdd.paths` that changed-line coverage skips. `init` lists a Vitest package here when no coverage provider is installed for it, and a Jest package whose `coverageReporters` leaves out `json` or whose `coverageDirectory` (or preset) moves the output. |
| `tdd.test_lock` | `true` | Changing a test that was written failing needs your approval until it passes. |
| `tdd.results_dir` | `".harness/results"` | Where the test reporters write JSON results. Keep it inside `.harness/results`, which protect covers. Value must not be inside .harness/state (the sandbox denies it there). |
| `multi_file_gate.generated` | `[]` | Globs for generated files that the multi-file gate does not count. |
| `pr_size.target_lines` | `200` | Changed lines the pr-ship skill aims for in each PR. Guidance only; no gate enforces it. Value must be an integer from 1 to 100000. |
| `pr_size.max_lines` | `400` | Changed lines above which opening or growing a PR asks you first (denied when unattended). Value must be an integer from 1 to 100000. |
| `pr_size.max_files` | `20` | Changed files above which opening or growing a PR asks you first (denied when unattended). Value must be an integer from 1 to 10000. |
| `pr_size.exclude` | `["**/pnpm-lock.yaml","**/package-lock.json","**/npm-shrinkwrap.json","**/yarn.lock","**/bun.lock","**/bun.lockb","**/Cargo.lock","**/poetry.lock","**/uv.lock","**/Pipfile.lock","**/Gemfile.lock","**/composer.lock","**/go.sum","**/.!(npm\|harness)ignore","**/__snapshots__/**","**/*.snap"]` | Globs not counted toward a PR's size: lockfiles, `.*ignore` files except `.npmignore` and `.harnessignore`, and snapshots. A list you set replaces the whole default, so keep the defaults you want. |
| `unattended.multi_file_gate` | `"block"` | What the multi-file gate does when no human is watching. Value must be one of block, allow-log, off. |
| `unattended.require_reason` | `false` | With `allow-log`, extra files need a one-line reason. No effect while the gate is `block`. |
| `stop.steps` | `["format:check","lint","typecheck","test"]` | Commands that must pass before the agent may stop. Value must be a list of script names or { name, run } objects. |
| `stop.package_manager` | `"pnpm"` | Used to run script-name steps. Value must be one of npm, pnpm, yarn, bun, none. |
| `stop.max_attempts` | `3` | How many times the Stop gate blocks before it gives up and lets the agent stop. Value must be an integer from 1 to 10. |
| `stop.timeout_s` | `540` | Seconds the Stop steps may run in total. Value must be an integer from 30 to 550. |
| `stop.base_ref` | `"origin/main"` | Git ref that changed lines are compared with. |
| `stop.coverage_globs` | `["**/coverage/coverage-final.json"]` | Globs for the coverage files that diff coverage reads. |
<!-- config:end -->

`preset` is not in the table because it has no default: the key is absent until init records a chosen preset. It is a mapping of `id` (a shipped or repo preset id), `version`, `items` (the item ids it chose) and `git` (`branch_prefixes`, each matching `^[a-z0-9-]+/$`, plus `no_ai_trailer` and `pr_size_warning`). Any other key under it is an error.

## Troubleshooting

Start with `harness doctor`, which prints a fix for each problem.

- **Every edit is denied.** `.harness/config.yaml` is invalid. `doctor` names the line.
- **"Run a test first", but the test exists.** Red-first needs a fresh failing run from this session. Run the test, see it fail, then edit.
- **A Stop step is skipped with a warning.** Its tool isn't on Claude Code's PATH, which can differ from your terminal's. Install the tool or edit `stop.steps`.
- **`doctor` says an item is missing a file.** Run `/harness:sync`; it restores the file or the settings entry.
- **`doctor` says a plugin is enabled but not installed.** Run the `claude plugin install <id> --scope project` line it prints, or `/harness:sync --install-plugins`.
- **Format or lint fails on `.harness/` files.** Add `.harness/` to that tool's ignore file.

More detail: [TDD setup details](#tdd-setup-details).

## Known limits

- The guard recognises the commands `harness` and `cli.mjs` by name. A renamed copy or symlink of the CLI (`node h.mjs add x --yes`) isn't recognised, so it doesn't ask first.
- Two hooks writing at once can lose or double a `timing.jsonl` rotation (rename after a size check). Lines are append-only and never torn.
- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- The `PowerShell(...)` deny rules, and the `Read` and `Edit` rules on PowerShell commands, are unverified until a live check on Windows passes.
- The Stop gate fails open if its process can't run (`onFailure` has no effect on Stop).
- Native Windows has no sandbox: shell commands are checked by text only, and the guard doesn't parse PowerShell.
- Interactive sessions under the default `unattended` mode keep the text-check gaps (a `cd` before a write, shell reads of secrets, writes protect doesn't parse, and scripts that turn TDD off) unless the person turns the sandbox on before the session starts or uses `always`.
- A blocked settings change still sits on disk; the next session loads it. Change detection reports it at the next prompt and Stop.
- Force-push and push-to-main rules are text rules; branch protection is the real stop.
- The guard reads `$IFS` and every `${IFS…}` form as a space, and `$'…'` and `$"…"` quoting, a one-word quote (`git "push"`) and an escaped letter (`g\it`) as plain words. Other words built at run time (a variable in command position, `${!x}`, `${x//a/b}` and the other operators, zsh `${(s:_:)x}`, `IFS=`, `eval` with an expansion) ask only when the command names `harness` or `cli.mjs` as a word (a directory in a path, as in `cd /x/harness && …`, does not count), `.harness` or `.claude/settings`. A built force push or secrets read with none of those words (`S=' '; git${S}push${S}-f`, `F=-f; git push $F`, `git pu${Z}sh -f`) is not caught, and neither is a name built from pieces (`x=har; y=ness; $x$y init`, `$(printf '.har%sness/x')`); a glob counts as naming a protected path when it can match `.harness`, `.claude` or a protected file (`cd .har*ss`).
- Protect asks for any command that names `.harness`, `.claude` or `.claude/settings` and also has an expansion or substitution, a redirect to a file, an array or function definition, or a `cd` into a protected dir, `source`, `.`, `read`, `printf -v`, `declare`/`typeset`/`export`, or `bash FILE`. Outside a plain read (`cat`, `ls`, `grep`, `jq`, `git log`/`diff`/`show`, `harness doctor`/`status` with no redirect), a glob that can match a protected name or a quote or backslash inside a protected path (`tee .harness/"config.yaml"`) asks on its own. Heredoc bodies, `echo`/`printf` text whose output nobody reads, and `git commit -m`/`gh pr create --body` values are data. `xargs` or `find -exec` feeding a writer asks, and so does any `xargs` when the command names a protected path. This includes harmless forms such as `cat .harness/config.yaml > /tmp/c`, `rg ".harness" src > /tmp/hits` and `for f in .harness/logs/*; do wc -l "$f"; done`. `node_modules` keeps its own rules and is not part of this check.
- A script or program the agent wrote that takes the protected path as an argument (`node w.js .harness/config.yaml`, `python3 w.py …`), or writes a path it builds itself, is not caught: protect can't read what it does. Change detection still reports the edit at the next prompt and at Stop.
- Other force-push forms the text rule misses: git global options before `push` (`git -C . push -f`), bundled or abbreviated flags (`-uf`, `--forc`), a `+ref`, brace expansion (`git {push,-f}`), a forwarding function, and a quoted separator before `main` (`git push origin x "&&" main`). An earlier ask (an `rm -rf` or a harness command) can also hide a later deny in the same command line when attended.
- `HARNESS_SANDBOX=1` is the launcher's claim; harness can't see `--settings`.
- `sandbox-required` doesn't read `sandbox.excludedCommands`: commands listed there run outside the sandbox. A mid-session change to it is blocked like any sandbox change.
- Results in `.harness/results/` can be forged by a program the agent runs.
- A flow-style `tdd: { results_dir: … }` isn't migrated by `update`; edit that one line by hand.
- MDM, registry and server-managed settings aren't read by `sandbox-required`. Only `managed-settings.json` and the `managed-settings.d/` drop-ins are read.
- A script that rewrites `.harness/state` can forge the CLI record. Protect covers file tools and named shell writes, and the sandbox denies it when unattended.
- Mid-session, only the harness CLI's own change to `.claude/settings.json` is let through. A change to the user or local settings, by anyone, applies from the next session.
- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- The CLI path the guard prints is trusted by location only (the repo's `node_modules/@khubaibqaiser/harness`). The agent can still put a copy there with commands protect doesn't parse, such as `git clone … node_modules/…`, `curl -o`/`wget -O`, `patch`, `git apply --directory`, or a `file:` dependency in `package.json` followed by an install. Read the printed command before you run it in your own terminal.
- The protected-path and `node_modules` rules read the paths a shell command names, and inline code only when it is literal in the command. Not seen by them: a program that writes files itself (a script file, a build script, an install hook), code that assembles a path at run time, a command hidden in a variable or built at run time, and quoting rules other than POSIX. Change detection reports a change to harness's own files from any of these at the next prompt and Stop, after the fact, unless the same script also rewrote the fingerprints in `.harness/state/`; it doesn't cover `node_modules` or other files.
- The guard also asks for any Bash command whose text names `harness` or `cli.mjs` and one of `init`, `update`, `add`, `remove`, `sync`, `uninstall`, `push` or `pr`, unless it can read the whole command as a plain preview. This is a safety net for shell tricks it cannot parse (globs, comments, redirections, odd spaces). The accepted cost: a command that only mentions them, such as `git commit -m "fix harness init docs"`, asks too, and so does one that only mentions `harness tdd off` (echo, grep, a heredoc, a function that forwards its arguments). A `harness tdd off` the guard can actually see being run, even inside `{ …; }` or through a glob in the CLI path, is denied.
- The guard does not see a command that never names `harness` or `cli.mjs`: a renamed or copied CLI file (`x.mjs`), `npx github:…` forms that omit the name, and npm `pre`/`post` scripts whose body lives in a `package.json` the agent edited. The agent can write such a file, so this is the same limit as running a script file.
- Harness's guard is a speed bump for mistakes and prompt injection, not a security sandbox. A determined shell trick can still get past it. Claude Code's own permission rules and its sandbox are the real boundary.
- Plugin install messages are matched by guessed wording until a live check on the real Claude Code output. If a plugin install fails oddly, run the printed command yourself.
- LSP plugin config in the `harness-pins` marketplace is unverified live. Claude Code may ignore it.
- The context count is an estimate (characters divided by 4). Plugins, external skills and MCP servers aren't measured before install, and committed picks load for every teammate but only the person installing is asked about the budget.
- Plugin picks are "local only" in Claude Code and are missing in cloud sessions.
- `extraKnownMarketplaces` (where the `harness-pins` marketplace lives) needs folder trust.
- MCP servers need each user's approval.
- `CLAUDECODE` is also set in IDE terminals, so `init` and `update` run there too, not only inside a Claude Code session. They don't print `Run /harness:init inside Claude Code`.
- There is no version-drift check for `git-subdir` plugins that have no `plugin_version`. The commit is pinned, but `doctor` has nothing to compare. The release notes list them.
- A harness command that is killed in the middle of writing, or whose rollback fails, leaves `.harness/apply.lock`. Every command, a dry run and `doctor` and `status` included, reports it and refuses to plan until you undo the partial change with git and delete the lock (the guard stops the agent from deleting it). Two harness commands running in one repo at the same time: the second to finish stops with "Another harness command changed the install while this one ran" and writes nothing.
- Under `sandbox: always`, item commands may need Claude Code's `!` prefix. Unverified, pending the live check.
- `.harnessignore` has no `!` negation.
- `remove tdd-gate` (or deselecting it) leaves the test-config edits `init` made in place; undo them by hand.
- `update` doesn't rename a package config and make another edit to it in one run. Run it twice.
- `harness git` treats `origin/HEAD`, `init.defaultBranch`, `main` and `master` as the default branch. If your default is another name and `origin/HEAD` isn't set, run `git remote set-head origin -a` first.
- PR size: text detection only. It misses `gh` aliases, `gh api` POSTs, `hub`, shell scripts that aren't `package.json` scripts, GitHub MCP tools, the web UI and your own terminal. Only a CI size check or branch protection stops a large PR for everyone.
- PR size: the hook doesn't fetch. It measures against the last fetched remote refs, so a stale `origin/<base>` can over-count.
- PR size: it assumes the `origin` remote. Fork flows, where the base lives on `upstream` or comes from `--repo`, are measured against `origin`.
- PR size: the push check covers only branches whose PR harness saw being created. A PR opened by a person, or before this feature, isn't recorded.
- PR size: a pushed branch is assumed to have the same name on the remote, unless the refspec names it.
- PR size: `gh pr edit --base` can change a PR's size after it was opened; that isn't checked.
- PR size: size is lines and files, not complexity.
- PR size: a PR that can't be measured is allowed with only a note and a `pr-size-unmeasured` event, unattended runs included. A repo that never fetches its base is never size-checked.
- PR size: `gh`'s own choice of default base beyond the remote's default branch isn't mirrored (unverified).
- PR size: Monitor commands are checked but not recorded.
- PR size: a create is recorded only when its output shows the new PR's URL, so a `gh pr create` run in the background isn't recorded and its later pushes aren't checked. A create whose `--base` is set inside a script (a `package.json` script, say) is recorded against the default base, so its pushes can ask too often.
- PR size: deletes and tag-only pushes are not checked.
- PR size: two sessions writing `pr-branches.json` at once can lose one entry.
- PR size: a base whose last segment is a guard backstop word (`feat/sync`) makes the skill's measuring command ask.
- PR size warnings: changes made by shell commands are measured only at Stop, so a large codegen step in mid-turn is announced at the end of the turn.
- PR size warnings: a stacked branch with no PR yet is measured against the default branch, so it counts the branches below it. Once its PR is created and recorded, its own base is used.
- PR size warnings: a size that crosses a threshold and drops back between two measurements isn't announced.
- PR size warnings: two sessions on the same branch can race on `pr-progress.json` and lose one update. At worst a warning repeats or is skipped once.
- PR size warnings: a subagent's edit gives the warning to that subagent, not to the main agent (unverified). Your message still shows.
- PR size warnings: where AskUserQuestion isn't available (some subagents, `claude -p`), the agent can only ask in text.
- PR size warnings: each counted edit runs 7 or 8 git calls. That measured 91 ms median overhead on macOS in a 20-file repo. In a large repo the cost is mostly the two `git diff` calls over the working tree, which can take up to the 6 s budget; a timeout gives no warning, only a stderr line.
- PR size warnings: a Stop that harness blocks before its checks run (an invalid config, changed harness files) drops that Stop's warning; the next Stop announces it.
- Not in this release: the PR reviewer (M2) and TDD for other languages.
