# Harness reference

The full detail behind the [README](../README.md). Start there; come here when you need the exact rules.

## How it works, and how it differs

- **Hooks, not prompts.** The rules run as `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `ConfigChange`, `Stop`, `SessionEnd` and `SessionStart` (matcher `compact`) hooks. `AGENTS.md` gets a short block that explains the rules, but the hooks enforce them.
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
- **Person-only commands.** The guard denies the agent `harness tdd off` and asks before it runs `harness uninstall`, in the forms listed under [Uninstall](#uninstall). It also asks before `harness report` (it reads this repo's session transcripts) and denies `harness eval` (paid); both pass with `--help`.

## Multi-file gate (any repo)

Asks you once per turn before the agent edits a second source file. Your yes covers the rest of the turn. Test files, snapshots, lockfiles and files in `multi_file_gate.generated` never count. In unattended runs you choose: block, allow and log, or off. See [Unattended runs and CI](#unattended-runs-and-ci).

## PR size (any repo)

- Detected: `gh pr create` (also through wrappers, scripts and `bash -c`), and `git push` to a branch whose PR harness saw being created.
- Counted: the committed three-dot diff against the base, tests included. Not counted: `pr_size.exclude` (lockfiles, `.*ignore` files except `.npmignore` and `.harnessignore`, snapshots) and `multi_file_gate.generated` paths. A binary or deleted file is 1 file and 0 lines.
- Over `pr_size.max_lines` or `pr_size.max_files`, it asks you first; a push asks only when it grows the PR past what was recorded. Unattended, it is denied with how to split it.
- When it can't measure (no base ref, git missing, a timeout), the command runs with a note and a `pr-size-unmeasured` event.
- Each PR branch's base, lines and files are recorded in `.harness/state/pr-branches.json` after the create or push runs.
- `/pr-ship` measures the branch and splits it into stacked PRs of about `pr_size.target_lines` each.
- **Warnings while it grows.** After each edit (Edit, Write, MultiEdit, NotebookEdit) to a counted path in the repo, and once at Stop, harness measures the branch's committed and uncommitted change (untracked files included) against its base: the recorded PR base, else the default branch. It warns once when the change passes `pr_size.target_lines` and once more when it passes `pr_size.max_lines` or `pr_size.max_files`, not on every edit in between. A threshold resets when the size drops back to it or under (after a split, say), so the next crossing warns again. Attended, the agent is told to stop and ask you to split (with the `pr-ship` skill), keep going or raise the limit, with AskUserQuestion under the header `PR size`, and you see a one-line message; at Stop you get the message only. That question is the one ask: any answer to it lets your next edit run. A `PR size` question whose call already carries an answer (AskUserQuestion's `answers` or `response` field) is denied, so only your own answer counts. If the agent skipped asking, your next edit on that branch asks once in a permission dialog instead: approve to keep going, or say no and tell Claude to split or raise the limit. A no asks again at the next edit until you type a prompt; your answer to the `PR size` question, the edit running, your next prompt or a raise answers it. A raise still needs its own command and dialog. It covers edit tools only, not shell commands that write files. Unattended, the agent gets a note to keep going and split before opening a PR, and a Stop warning is only logged. Each warning logs a `pr-size-warned` event. The thresholds already announced, per branch, are kept in `.harness/state/pr-progress.json`. Harness's own `.harness/state/`, `logs/`, `backup/`, `results/`, `debug/` and `reports/` files never count here, gitignored or not. A detached HEAD, or a change it can't measure, gets no warning.
- **Split, keep going or raise.** After a warning, `/pr-ship` measures the working tree, groups the changed files into a plan, and asks you to split now, keep going, or raise the limit for this branch. A raise runs `--pr-size-raise` (below), which you approve in a dialog; unattended, a raise is denied, and on a detached HEAD it is denied too. The guarantee: a raise is recorded only on the branch the dialog named. Harness saves that branch for that exact command in `.harness/state/pr-raise-asked.json` when it asks, and after the command runs it records the raise only if HEAD is still on that branch and the command printed the raise. It also records only the lines and files the dialog showed. Otherwise it records nothing and logs a `pr-size-raise-skipped` event. A command that runs a hook dispatcher by hand without one of its entry flags (the repo's `.harness/hooks/dispatch.mjs`, the package's `dist/hooks/dispatch.mjs`, or any path ending in `hooks/dispatch.mjs`, however it is spelled), or that copies, moves or links a hook file, or pipes or redirects one, is denied, attended or not. It is a text check; see [Known limits](#known-limits). As an early refusal, some commands are denied outright: a second raise, or a branch, directory or repo change in the same command, such as `git checkout`, `git switch`, `git -C`, `cd`, `pushd`, `git worktree add`, `--git-dir` or `GIT_DIR=`. Those are examples; other branch changes (an alias, `gh pr checkout`, a script) aren't refused, but the raise isn't recorded on a branch you didn't approve. A raise is kept per branch in `.harness/state/pr-progress.json`, and logs a `pr-size-raised` event.

## TDD gates (JS/TS with Vitest or Jest)

- **Red-first.** An edit to a file in `tdd.paths` is denied until a related test has a fresh failing result from this session.
- **Test-lock.** A test seen failing is locked until it passes. Changing it in the meantime needs your approval.
- **Tamper check.** Denies edits that weaken tests to make them pass: adding `.skip`, `.only`, `.todo`, `xit` and similar, removing assertions, adding no-op assertions, lowering coverage thresholds, turning coverage off, enabling `passWithNoTests` or changing which tests run.
- **Spec gate.** A feature in a root `features.json` may only become `passes: true` when each criterion names a test that just passed.
- **Pause.** A person can pause the TDD layers for one session with `harness tdd off`.

## Stop gate (any repo)

Before the agent may stop, harness runs the steps in `stop.steps`: script names run with your package manager, or `{ name, run }` commands for any language. In a JS/TS repo with TDD on, it then checks that changed lines (against `stop.base_ref`) have at least `tdd.diff_coverage` percent coverage. A failing step blocks the stop and shows the end of its output, up to `stop.max_attempts` times.

- **Team-decision nudge.** When you state a standing rule in a prompt ("from now on…", "we decided…") or the agent says it will remember one, a passing Stop shows a note, once per session, suggesting `harness remember add`. It's a plain-text match with no model call, and it never blocks. A blocked Stop holds it until the next passing one. It doesn't show after a `harness remember add`, with `decisions.nudge: false`, `checks.decisions: false` or `checks.stop: false`, or in an unattended run, which logs a `decision-candidate` event instead.

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
| `.claude/settings.json` | Created or merged. Adds the hook entries (including the `SessionStart` `compact` hook, which re-adds a 5-line state card after compaction) and `permissions.deny` rules for `.env` reads and edits to harness files. Hooks from other tools are kept. |
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

`uninstall` removes only what `.harness/manifest.json` lists. A merged file (`AGENTS.md`, `.gitignore`, the settings, a test config) that you have not edited comes back from the backup `init` made. That backup is gitignored, so on a teammate's clone, and for any merged file you edited (also when `update` changed it later), uninstall removes only the harness blocks and keeps the rest of the file. In a JS or TS config, harness's blocks depend on each other, so if any of them is missing or edited, uninstall removes none of that file's blocks and prints the lines to remove by hand. It then also keeps the `.harness/eslint/` files that config imports, so your lint still loads. In other files, such as Markdown and ignore files, it removes each block it finds. If `init` replaced the text between existing `AGENTS.md` harness markers, that old text cannot be restored. A harness file you edited, such as `.harness/config.yaml`, is listed and kept unless you pass `--force`; a merged file is never deleted whole. A yes also deletes the rest of `.harness/`, including its logs, except `.harness/presets/`, which holds your own presets. Answering no at that prompt keeps `.harness/` and its `.gitignore` lines, so the logs and backups stay out of git. Harness is uninstalled either way: the manifest goes, so `status` and `doctor` report it as not installed and `init` can run again.

Rules generated from team decisions are removed like other created files; `docs/decisions/` is left alone.

`harness uninstall --global [--dry-run] [--yes] [--force]` removes a preset installed with `preset install <dir> --global`. It needs no git repo. It removes exactly what `~/.claude/harness/manifest.json` lists, the same way: an unedited `~/.claude/CLAUDE.md` or `~/.claude/settings.json` comes back from its backup, an edited one loses only the preset's block or keys, and an edited skill file is listed and kept unless you pass `--force`. Then it deletes the backups, the manifest and the folders the install created; folders that were already there, empty or not, stay. With no global install it says so and exits 1; when the manifest lists a path outside `~/.claude` (a tampered file), it names that entry, removes nothing and exits 1. Without `--yes` it asks once in a terminal; with no terminal it prints the no-terminal message and exits 2. The guard asks before the agent runs it, `--dry-run` included.

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

The agent has to ask before it runs `harness context apply`, which changes which skills load; unattended it is denied. `harness context` and `harness context apply <n> --dry-run` are allowed. A preview of any command the agent has to ask about passes only when written out in plain words: an argument with `$`, a backtick, a brace, a glob or a leading `~` asks (unattended it is denied).

The guard matches secrets paths without regard to case, and the way Windows resolves them: trailing dots and spaces, `::$DATA` streams, drive-relative `C:name`, and 8.3 short names. It can't map a short name (`~1`) back exactly, so it denies any short-name segment that could stand for a protected name. A short-name path through a folder that starts like one (for example `AWSADM~1`) is then denied too.

The multi-file gate never counts test files: JS/TS `*.test.*`, `*.spec.*` and `__tests__/`, and Python `test_*.py`, `*_test.py`, `conftest.py` and `.py` files under `tests/`. Writing a test and then its code is one change.

## The `/harness:init` flow

The full flow runs only inside Claude Code, where Claude does the interview and the recommendations. The CLI stays deterministic: Claude passes it files, and it checks them.

1. **Scan.** It reads your repo and shows what it found.
2. **Interview.** Claude asks one question at a time: scope first, then "Use a named preset?" ("No preset" is the default; `harness preset list` shows the others), then gaps the scan can't answer. It drafts `product.md` for you to edit. It reads only files you point to, never dotenv files or `.harnessignore` paths, and credentials are names only.
3. **Recommend.** A fresh-context reviewer audits the repo against the catalog and proposes items and a report.
4. **Select.** You tick items, four per question, with the reason, context cost and side effects of each. With a preset, its rows are ticked and say they came from it.
5. **Apply.** It shows the plan, the preset's extra lines (Impeccable's hooks and download, the opt-out variables, the attribution setting) and the always-loaded context, the repo's own files included. If that goes over the budget (2000 tokens by default), it asks once. Then you confirm separately: apply the changes, and, if you picked plugins, install them now.
6. **Git.** Each of branch, commit, push and PR is its own question. Nothing runs without a yes.

It writes the same files as `init`, plus `.harness/context/product.md` and `.harness/report.md`.

## Teammates

The hooks are in the repo, so a teammate needs nothing for them. Plugins you picked are pinned in `.claude/settings.json`, but each person installs them in their own Claude Code. After pulling, a teammate runs `claude plugin install <id> --scope project` for each, or `/harness:sync --install-plugins`. `harness doctor` lists the ones that are missing. Claude Code asks each user to approve MCP servers and, for the pinned marketplace, to trust the folder.

## Team decisions

A team decision is a rule the team agreed on, tied to repo paths. `harness remember add` writes it to `docs/decisions/<id>.md`, one file per decision, and generates `.claude/rules/harness-decision-<id>.md`, which Claude Code loads when one of its paths is touched. Only files whose frontmatter has `schema: harness-decision/1` are decisions; other files in the folder are left alone.

The file is YAML frontmatter, then free Markdown (`add` writes a **Rule:** and a **Why:** paragraph):

```markdown
---
schema: harness-decision/1
id: 2026-11-03-validate-env-with-zod
title: Validate env with zod
status: active
paths:
  - "src/env/**"
verified_at: 4f0c2a9e1b7d3c5a6e8f0a1b2c3d4e5f6a7b8c9d
verified_on: 2026-11-03
---
**Rule:** Parse every environment variable through `src/env/schema.ts`.
```

`status` is `active`, `superseded` (with `superseded_by: <id>`) or `retired`. `paths` holds 1 to 10 repo-relative globs, none of them repo-wide. Unknown keys are errors. If you edit a file by hand, run `harness remember sync`. `confirm` and `retire` rewrite the whole file in the standard layout above, so hand formatting in the frontmatter is not kept. They change only that decision's file and its rule; if other decisions are out of sync they say `Other decisions are out of sync; run harness remember sync.` and leave them alone.

The subcommands are `add`, `confirm`, `retire`, `sync`, `list` and `check` (see [Commands in full](#commands-in-full)). The write subcommands never commit or stage: open a PR so the team reviews the decision.

**Expiry.** A decision not confirmed for `decisions.expiry_days` (default 90) expires. The next sync drops its rule, and `check` says so. `harness remember confirm <id>` renews it.

**`check` in CI.** `harness remember check` prints one line per problem, then `<n> decisions: <e> errors, <s> stale, <x> expired, <o> oversized, rules <in sync|out of sync>`. It exits 1 on an invalid decision file, a rule file that harness didn't write, or rules that are out of sync with `docs/decisions/`. Stale, expired and oversized decisions are notes and exit 0, so CI doesn't go red only because 90 days passed. A decision is stale when one of its globs matches no tracked file, or when its linked files changed since it was confirmed. If git fails, it prints `couldn't check decision staleness (<reason>)` instead.

## Commands in full

The plugin adds `/harness:init`, `/harness:doctor`, `/harness:status`, `/harness:update`, `/harness:add`, `/harness:sync`, `/harness:uninstall`, `/harness:vet` and `/harness:preset`. In a plain terminal, `init` and `update` print `Run /harness:init inside Claude Code` and exit.

Run each terminal command as `harness <command>`. From source, use `node /path/to/harness/dist/cli.mjs <command>`.

**Inside Claude Code only:**

| Command | What it does |
|---|---|
| `init [--yes\|--config <file>\|--dry-run]` | Detects your repo, picks catalog items, shows the plan, then writes after you confirm. Run it as `/harness:init`. |
| `update [--yes\|--check\|--dry-run\|--plan]` | Re-renders the installed files with this version and shows the diff first. Run it as `/harness:update`. `--check` only looks for a newer version and also works in a terminal. `--plan` writes nothing and prints JSON: whether to re-recommend (the catalog or your project facts changed), what changed in the catalog, and which answers to ask again. Items that left the catalog are dropped from the selection with a line saying why, but their files are kept. With `--answers`, update takes a partial file and changes only the keys it holds (`project`, `apps`, `unattended`, `tdd`); the rest of `config.yaml` stays as it is. |
| `add <id> [--over-budget\|--dry-run\|--yes] [--take <file,...>]` | Adds one catalog item, with what it requires. Run it as `/harness:add <id>`. Refuses when the item conflicts with an installed one. Shows the diff and the context budget first, and with `--yes` stops when it would go over budget unless you pass `--over-budget`. Only items harness installed count as approved: they are in the total but never asked about again. One you selected by hand in `config.yaml` and never installed can still ask (and `add`, `update` and `sync` all agree on that). Like `sync`, it keeps a harness file you edited and lists it; name it in `--take` to replace it. Merged files (AGENTS.md, settings, `.mcp.json`) can't be taken. |
| `sync [--dry-run\|--yes] [--take <file,...>] [--install-plugins] [--over-budget]` | Fixes drift between `config.yaml`, the manifest and the files. Run it as `/harness:sync`. Restores missing files of selected items, and removes the files and records of items you unselected. A file you edited that harness wrote whole is kept and listed unless you name it in `--take`. In AGENTS.md, settings and `.mcp.json`, your content is never touched: sync changes only harness's own parts and lists the file. A selected item that was never installed counts against the context budget like `add`. The preview lists plugins that `claude plugin list` doesn't show; `--install-plugins` installs them and records the install (also on `init` and `update`), but only when `settings.json` has no edits besides the plugin entries. Otherwise it prints "not recorded" and `uninstall` keeps your content. Commit or stash `config.yaml` edits first. The agent has to ask before running it. |

**In a plain terminal:**

| Command | What it does |
|---|---|
| `status` | Shows each gate as on or off, and why. Also the catalog version, how many items are selected, how many selected plugins aren't installed, and the always-loaded context total (`Context:` line, counted offline). |
| `doctor` | Checks the install and prints a fix for each problem. It also prints one always-loaded context line (ok, note when over budget, fix when harness alone is over). Exits 1 if there is one. For installs with items it also reports the catalog version, items whose files or settings entries are missing (`/harness:sync` restores them), selected plugins that are enabled but not installed, plugin versions that differ from the catalog's pin, a plugin enabled from two marketplaces, an edited `harness-pins` marketplace or MCP server, and `checks` in `config.yaml` that differ from the selected items. It runs `claude plugin list` once; without `claude` it skips the plugin checks. |
| `context [--json] [--offline]` | Lists the always-loaded and on-demand context rows (repo, harness, preset, catalog) with their tokens, the total against `context.budget_tokens`, and what is not measured. Writes nothing. Exits 1 when the always-loaded total is over the budget, 2 on a bad argument, 0 otherwise; an unreadable manifest is a note, not its own exit code. Counts with Anthropic's token-counting API only when `ANTHROPIC_API_KEY` is set, `context.count` is `auto` and `--offline` is not passed; otherwise, or if the API call fails, it estimates (characters ÷ 4) and says so; only with no key does it add how to get exact counts. Catalog picks keep their recorded estimate and are marked `(catalog estimate)`, and the header says how many rows stayed estimates. `--json` prints the same as JSON, ending with `fallback`: why the API count failed (`timeout`, `network error`, `bad response` or the HTTP status), or `null`. It also lists numbered recommendations: `harness` ones it can apply (show a harness, preset or catalog skill by name only while the total is over 80% of the budget, never one an agent preloads through `skills:` or one whose `skillOverrides` key you set; remove a catalog plugin pick) and `yours` ones on your own files, which `/harness:context-optimize` proposes as a diff. |
| `context apply <n>[,<n>…] [--dry-run\|--yes]` | Applies recommendations from `harness context`, harness-owned ones only. All the name-only ones go into one change, with one diff and one prompt: it writes `skillOverrides.<name>: "name-only"` to `.claude/settings.json` and records it in the manifest, so `uninstall` takes it out. A key you set yourself is never recommended. Then each remove runs `harness remove <id>` with the same flags. If any number is a recommendation on your own file, the whole call is refused (exit 2). `--dry-run` prints the diff; without `--yes` it asks, and closing the input counts as no. `--dry-run` and `--yes` together are a usage error. A No to the name-only change stops the call, so no remove runs (a No on one remove skips only that remove); a remove that fails after the name-only change exits with its code, and that change stays. In Claude Code's sandbox it prints the command to run yourself with the `!` prefix. Exits 0 when applied or nothing to do, 1 when the apply failed, 2 on a bad argument or a refusal. The agent has to ask before running it. |
| `uninstall [--global] [--yes\|--force\|--dry-run]` | Removes what harness added and restores your files. Close open Claude Code sessions first. `--global` removes the global preset instead (see [Uninstall](#uninstall)). |
| `remove <id> [--dry-run\|--yes] [--take <file,...>]` | Removes one installed item and what it wrote, and restores your files. Refuses while another installed item requires it. A file you edited, of this or another item, is kept and listed unless you name it in `--take`. The agent has to ask before running it. |
| `why <id>` | For an installed item: why it is there, the findings it addresses, its cost and its context. For one that isn't installed: why it is in the catalog and its cost. |
| `explain` | One line per installed item with its files, then the always-loaded context. |
| `stats [--days N]` | Counts harness events (the default is the last 7 days). |
| `report [--days N] [--open] [--export]` | Writes `.harness/reports/<YYYY-MM-DD>.html`, one file with no JavaScript and no external requests (a second run on the same day overwrites it). `--days N` is the window, a positive integer, default 14. `--open` opens the file with the system opener. `--export` also writes `<date>-export.json`: counts and rates only, with every string checked against an allowlist before it is written. Only sessions started inside the repo or one of its worktrees are read, and the terminal output is counts only. Install and `harness update` add `.harness/reports/` to the root `.gitignore`; until then the `reports/` folder gets its own `.gitignore` containing `*`. Exit 0 when a report is written (also with no sessions), 2 on bad arguments, 1 when the folder can't be written. It reads the timing log, `.harness/logs/timing.jsonl`, for the latency tables. |
| `rules [--apply]` | Proposes ESLint rules for the stacks it detects (TypeScript, React, Next.js, React Native). Every rule is `error` from day one. It first runs your own ESLint with the proposed rules (`--format json`, 120 s timeout). This runs your ESLint config and its plugins, like `pnpm lint`, and prints each rule's violation count, highest first, the total, the line "The stop gate's lint and typecheck steps will fail until these <n> violations are fixed. CI fails too if it runs them.", and the rules with 0 violations as safe to add now. When ESLint can't run (not installed, timeout, crash) the counts show as unknown and so does the effect on the stop gate; it never shows 0. It also lists the rules left out because their plugin isn't installed (`needs <package>`; harness never installs it), rules the installed plugin doesn't have, and the anti-patterns with no lint equivalent, then the diff. Without `--apply` it writes nothing. `--apply` asks you to type `yes` (any other answer, or closed input, writes nothing) and then writes `.harness/eslint/harness.config.mjs` and adds one import and one `...harnessRules` spread, between `// harness:rules` lines, to your `eslint.config.*`. For an `eslint.config.ts` it also writes `.harness/eslint/harness.config.d.mts`, so a strict typecheck finds the import's types. The config edit goes through your Prettier when the file was Prettier-clean, as install does. All of it is recorded in the manifest, so `uninstall` removes it byte for byte. If you edit one of harness's marked lines, `uninstall` removes none of harness's lines in that file, prints the ones to remove by hand and keeps the `.harness/eslint/` files, so the import is never left without its spread or the other way round and lint still loads. With a legacy `.eslintrc*`, no ESLint config, or a flat config that doesn't export a plain array, `--apply` skips the ESLint part and prints the manual steps and the packages to install; it still sets the TS options, and writes nothing when there are none to set. It never creates an ESLint config. It refuses without a terminal (exit 2) and asks you to commit `eslint.config.*` first. It never overwrites a `.harness/eslint/harness.config.mjs` that harness did not write, or one edited since: it names the file and writes nothing. With `eslint.config.ts`, counting needs Node 22.18 or later. **TS options.** It also proposes `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch` and `noImplicitReturns` for `tsconfig.json`. It counts each one's new type errors: one `tsc --noEmit` baseline run, then one run per option against a temp tsconfig under `.harness/state/` that extends yours (120 s timeout each; a run that doesn't finish shows that option as unknown). The counts sit with the ESLint ones, as `tsconfig <option>`. An option your `tsconfig.json` already sets, to any value, is left as is and listed; one set only through `extends` counts as not set. `--apply` adds the rest under `compilerOptions` (the file is written back as JSON in its own indent, so the diff can show short arrays spread over lines; it goes through your Prettier when it was Prettier-clean), recorded in the manifest, so `uninstall` restores the file byte for byte, or, after you edit it, removes only the options that still hold `true` and notes any you changed. A `tsconfig.json` with comments or trailing commas, or one that is a symlink, is never written: the lines are printed to add by hand. In a commented file, an option whose name already appears as a key is left out of the lines and the counts (a key inside a comment counts too). It never creates a `tsconfig.json`. Exit 0 for a preview or an apply, 1 when refused or not applied, 2 on a bad argument. |
| `eval [--kind skills\|rules\|gates] [--runs N] [--max-cost-usd X] [--model <id>]` | Runs `claude plugin eval` on a plugin built in a temp folder outside the repo. **It costs money.** It prints the plan and an estimate, then asks you to type `yes` on every run; any other answer stops it. Defaults: all kinds, `--runs 3`, `--max-cost-usd 2` (the ceiling is not saved; spend can pass it by up to one agent run), model `claude-haiku-5-5`. It refuses without a terminal, inside Claude Code, or when `CI` is `true` or `1`. Results are saved under `.harness/reports/evals/<date>/`, and the next `report` shows them. `gates` is not available yet. |
| `remember add --title <text> --rule <text> [--why <text>] --path <glob> [--path <glob>…] [--supersedes <id>] [--quoted] [--dry-run] [--yes]` | Saves a team decision to `docs/decisions/<id>.md` (`<id>` is today's UTC date and the title as a slug, with `-2`, `-3`… when taken) and writes its rule, `.claude/rules/harness-decision-<id>.md`, which loads when the `--path` globs are touched. `verified_at` is `HEAD` and `verified_on` is today. Limits: `--title` 1 to 80 characters, `--rule` 1 to 300, `--why` 0 to 500, all on one line, and 1 to 10 `--path` globs that each match a tracked file. A rule over `decisions.max_lines` is refused. `--supersedes` marks that decision `superseded`; it must be `active`. It refuses in unattended runs (`CI`, `CLAUDE_CODE_REMOTE`, `HARNESS_UNATTENDED`), inside Claude Code while `checks.guard` is off, and when any field looks like a secret (the secret is never printed). In a terminal it lists the files and asks `Write these files? [y/N]` unless `--yes`; with no terminal it needs `--yes`. `--dry-run` lists the files and writes nothing. It never commits or stages; open a PR. `--quoted` is for the guard; the CLI ignores it. Exit 0, 1 on a refusal, 2 on a bad argument. |
| `remember confirm <id> [--dry-run] [--yes]` | Re-checks that each of the decision's paths matches a tracked file, then sets `verified_at` to `HEAD` and `verified_on` to today, and syncs. Prints `Confirmed <id> at <sha7> on <date>. It expires on <date> unless confirmed again.` It refuses a dead path, an unknown id, a decision that isn't `active`, and a repo with no commit yet. Same refusals and prompt as `add`. |
| `remember retire <id> [--by <id>] [--dry-run] [--yes]` | Sets an `active` decision to `retired`, or to `superseded` by another active decision with `--by`, and syncs, which removes its rule. The decision file stays as a record. Same refusals and prompt as `add`. |
| `remember sync [--dry-run] [--yes]` | Rewrites the decision rules to match `docs/decisions/`, for example after you edit a decision by hand or take either side of a `.harness/manifest.json` conflict. Prints one `Wrote …` or `Removed …` line per file, `Updated .harness/manifest.json` when only the manifest needed fixing, or `Rules in sync: <n> decisions, <m> rules (<k> expired or retired, left out).` It stops at a `harness-decision-*.md` file harness didn't write. Same refusals and prompt as `add`. |
| `remember list` | One line per decision, sorted by id: id, status, confirmed date and paths, then `stale: …` when an active decision's path matches no tracked file or its linked files changed. Or `No team decisions in docs/decisions/.` A last line counts invalid decisions; `remember sync` prints why. Writes nothing. |
| `remember check` | For CI: see [Team decisions](#team-decisions). Writes nothing and never prompts, also in unattended runs. |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. `off` works only in your own terminal. |
| `scan` | Prints the facts harness detects about your repo, as JSON. Writes nothing. |
| `catalog` | Prints the catalog of items harness can install, as JSON. |
| `catalog check [--resolve [--context [--write-context]]] [--only <id,...>]` | Checks the catalog for problems. `--resolve` also looks up each pin, which needs the network. `--context` (with `--resolve`) also downloads each plugin and external skill at its pinned commit and compares `cost.context_tokens` with the measured count: a different number is a problem, and items with no number are listed under `Not measured:`. `--write-context` (with `--context`) writes the measured number into each item file's `cost:` and changes nothing else. `--only` limits the checks to the listed ids. |
| `preset list` | Prints `<id>  <description>` for each shipped and repo preset (`.harness/presets/`), or `No presets.`. Writes nothing. |
| `preset check <dir>` | Checks every `<id>.yaml` in `<dir>` with its `<id>/` folder: schema, items, templates, skill limits, no email or git identity, and an id that isn't a shipped preset's (unless `<dir>` is the shipped folder). Prints `ok` or one error per line. `catalog check` also checks each shipped preset, as `presets/<id>: <error>`. |
| `preset install <dir> [--dry-run\|--yes]` | Runs the same checks as `preset check` (including the shipped-id rule), then copies each `<id>.yaml` and `<id>/` to `.harness/presets/` (commit it; `uninstall` keeps it). `--dry-run` lists the files and writes nothing. Without a flag it lists them and asks once in a terminal; with no terminal it prints the no-terminal message and exits 2. A folder that fails the check, or an id already in `.harness/presets/`, is refused and nothing is copied. Then choose the preset in `/harness:init` or `/harness:update`. An agent running it (other than `--dry-run`) is asked to confirm first. |
| `preset install <dir> --global [--dry-run\|--yes --take <path,...>]` | Same checks, for a folder with one preset, then installs it under `~/.claude` (see [Named presets](#named-presets) for the paths). It prints every global path with its diff and the always-loaded total (estimate). In a terminal it asks a separate yes for each path; with `--yes` it writes only the paths in `--take` (as listed, with or without `~/`), and `--yes` without `--take` exits 2. `--dry-run` writes nothing. It refuses, writing nothing, when a global preset is already installed (run `harness uninstall --global` first, or keep that preset), when `CLAUDE_CONFIG_DIR` points anywhere but `~/.claude`, when a skill or preset file is already there, or when a path goes through a symlink (such as a symlinked `~/.claude`). |
| `validate answers\|product <file> [--merge-config]` | Checks an interview answers file or a product file. With `--merge-config`, an answers file holding only some keys is laid over the answers in `.harness/config.yaml` first (what `/harness:update` uses). |
| `validate picks <file> --answers <file> [--merge-config] [--attempt 1\|2]` | Checks a picks file against the answers and the catalog. `--merge-config` works as above. |
| `validate report <file> --picks <file> [--attempt 1\|2]` | Checks a report file against the picks. |
| `validate vet-review <file> --scan <file> [--attempt 1\|2]` | Checks a vet reviewer's `vet-review.json` against the scan (`harness vet --json`) and the installed items. |
| `validate preset-answers <file>` | Checks the `/harness:preset` interview's `answers.json`: id (not a shipped preset's), title, description, `target` (`repo` or `global`), rules, preselects (catalog ids, not discouraged), git (branch prefixes match `^[a-z0-9-]+/$`) and `stacks` (`react`, `next`, `react-native`, each with only the twelve known topics). Free text may hold no control characters, email addresses or `user.name`/`user.email`. Prints `ok` (exit 0) or one error per line (exit 2). No command turns answers into a folder: the skill writes the files and `preset check` is the guard. |
| `vet <target> [--json]` | Pins a GitHub plugin or skill to a commit, scans it without running it, and writes `.harness/vet/<id>-<sha>.md`. Installs nothing. |
| `vet <target> --json [--keep]` | Prints the scan as JSON and writes no report. `--keep` adds `dir` and `map` and keeps the unpacked folder (under the OS temp dir) for a reviewer. `map` lists only the in-scope files unpacked under another name (such as `CLAUDE.md.vetted`), keyed by the file name the findings use. |
| `vet --finish <scan.json> --review <file>` | Checks the reviewer's file like `validate vet-review`, writes the report with the review, then deletes the kept folder. |
| `node .harness/hooks/dispatch.mjs --pr-size [--base <name>] [--head <name>] [--worktree]` | Measures the current branch's PR size (with `--worktree`, it also counts staged, unstaged and untracked changes, and `head` is `working tree`) and prints it as JSON (`base`, `head`, `lines`, `files`, `target_lines`, `max_lines`, `max_files`, `over`, `top`, `excluded`). When the measured branch has an approved raise, `max_lines` and `max_files` are the raise and `raised` is `true`. Exits 0 within the limit, 1 over it, 2 when it can't measure (the JSON then holds `error`). Works in every clone, including cloud sessions, since it needs no `harness` install. |
| `node .harness/hooks/dispatch.mjs --pr-size-raise --lines <n> [--files <n>]` | Raises this branch's PR size limit, for the warnings and at PR time. The agent runs it and you approve it in a dialog; unattended, it is denied. `--lines` is an integer from `pr_size.max_lines` + 1 to 100000; `--files` defaults to `pr_size.max_files` and goes up to 10000. Prints `branch`, `lines` and `files` as JSON and exits 0, or exits 2 with `error` for a bad value or a detached HEAD. The command itself writes nothing; harness records the raise after it runs, only on the branch the dialog named. Run it on its own. |
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

- **What counts.** Always-loaded text only. For an agent, that's its name and description. For a skill, that's its name and description, plus `when_to_use` (together cut at 1,536 characters); a skill with `disable-model-invocation: true` costs nothing. For the `AGENTS.md` block, the whole block. Hooks, settings and CI files count as 0. The repo's own CLAUDE.md, AGENTS.md, rules, skills and agents count too, because every teammate loads them.
- **Owners.** Each row has an owner: `harness`, `preset:<id>`, `catalog:<id>` or `repo`. The harness plugin's own skills are always counted.
- **Not measured.** Plugins and external skills count the number the catalog records, measured at the pinned commit; with none recorded, they're listed as not measured. MCP servers can't be measured before install and are always listed as not measured. The install asks you once about anything not measured.
- **The count.** The default is an estimate: characters divided by 4. `harness context` uses Anthropic's token-counting API only when `ANTHROPIC_API_KEY` is set, `context.count` is `auto` and `--offline` isn't passed. The key is read from the environment only and never stored. The API receives the measured text, under the key's account. If the call fails, `context` falls back to a full estimate and shows the reason (and `fallback` in `--json`). Catalog picks stay `(catalog estimate)`.
- **The limit.** `context.budget_tokens`, default 2000. `init`, `update`, `add` and `sync` count your repo's own files and ask before going past it. They count `AGENTS.md` and `CLAUDE.md` as the install will leave them, so when harness adds the `@AGENTS.md` line, your `AGENTS.md` text counts from that ask on. If any repo file the plan reads (`AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.prettierignore`, the ESLint and test configs, `package.json`, `.claude/settings.json`, `.mcp.json` and the rest) is a symlink or sits under one, they stop with `refusing symlink: <file>` and exit 1 before reading it, dry runs included. `apply` already refused to write through a link, so this blocks no install that worked. With `--yes`, they stop unless you pass `--over-budget`. An unattended run over the budget is refused, even with `--over-budget`; a dry run is not.
- **doctor and status.** `status` shows a `Context:` line and `doctor` one context check line. Both count offline and never call the API. Doctor notes when the total is over the budget, and reports a problem when harness's own text alone is.
- **harness context.** Shows the always-loaded and on-demand rows, the total and numbered recommendations. Writes nothing. It never reads a file whose name starts with `.env`, or a link that points to one (an import of one is listed as ignored), or `.harnessignore` paths. A folder under `.claude/rules` that a symlink reaches again is searched once and listed as `already searched (symlink)`. If `config.yaml` doesn't parse, it never calls the API and prints the config warning first. If `.harness/manifest.json` can't be read, it still reports, with a note, and counts harness's files as the repo's; the exit code still follows the budget. Any `git` it runs gets the environment without `ANTHROPIC_API_KEY`. `harness context apply <n>[,<n>…]` applies only harness-owned name-only and remove recommendations; a No stops the whole list, and an unattended run is denied by the guard.
- **Trimming.** `/harness:context-optimize` measures, proposes trims, and applies harness's own after a yes. Your own files change only after you approve each diff.
- **Ask once, then exempt.** Items you approved earlier count in every total, so the ask shows the same number as `status` plus the change. You're never asked about them again: an install asks only when new text takes the total past the budget, or when it adds an item that can't be measured. The ask lists them as `Approved earlier: <ids>.`
- **After compaction.** The `SessionStart` `compact` hook re-adds the state card.

## Team decisions

`harness doctor` and `harness status` report on the decisions in `docs/decisions/` and the rules generated from them. Both work offline, and `checks.decisions: false` doesn't turn them off.

- `doctor` exits 1 for an invalid decision file, for rules out of sync with the decisions, and for a `harness-decision-*.md` rule file that isn't harness's. Each line says the fix.
- `doctor` only notes a decision that is stale (a `paths` glob matches no tracked file, or linked files changed since it was confirmed), expired, or oversized (its rule is cut to `decisions.max_lines`), and a `verified_at` that is not in this clone. These never fail `doctor`.
- If git can't answer in time, `doctor` prints `couldn't check decision staleness (<reason>)` and carries on.
- `status` adds `Decisions: <n> active (<s> stale, <x> expired), rules <in sync|out of sync>` after the `Context:` line, or `Decisions: none`.

## Plugins and MCP servers

Catalog items can be Claude Code plugins or MCP servers.

- **Plugins.** Harness pins each plugin to an exact source in an inline marketplace named `harness-pins`, written to `.claude/settings.json` along with `enabledPlugins`. It's committed, so every contributor gets the same pins. Each contributor still installs the plugins in their own Claude Code. `--install-plugins` runs `claude plugin install … --scope project` for you. If one fails, harness prints the command to run yourself.
- **MCP servers.** Harness writes them to `.mcp.json`. Claude Code asks each user to approve a project server before it runs. Harness can't approve it for them. A server with the same name that you wrote is kept and reported.
- **Removal.** `uninstall` removes the pins and servers it added and leaves yours.

## Using it well

- **Run `harness doctor` after any change.** It checks the install and prints the fix for each problem.
- **Turn on branch protection.** Hooks run with your permissions, so branch protection is the real stop for force-pushes.
- **When the Stop gate blocks, let it work.** Its output shows what failed. The agent fixes it and tries again, up to `stop.max_attempts` (default 3).
- **Let TDD work for you.** When the agent says "run a test first", that's the gate asking for a failing test. For a spike, run `harness tdd off` in your own terminal, then `harness tdd on` when you're done.
- **Vet anything new first.** Run `harness vet` before you install a plugin or skill you found online.
- **Watch the budget.** `harness explain` lists what each item loads into every session. Remove what you don't use with `harness remove <id>`.

## Named presets

`/harness:init` asks "Use a named preset?" after the scope question. The default is no preset: the neutral catalog. `khubaib-frontend` is the shipped one. It adds working rules and git conventions to `AGENTS.md`, up to four frontend skills that match your stack, and preselected third-party picks. Its always-loaded text costs about 241 to 415 tokens (estimate, by stack), counted in the budget line before you confirm.

- It turns off the picks' usage reporting through `DO_NOT_TRACK=1` (Impeccable) and Superpowers' own opt-out variable in `.claude/settings.json`. Those variables apply to every command in the session, not only to that tool, and only after you trust the folder.
- It sets `"attribution": false`, so commits and PRs get no AI trailer.
- `harness git pr` warns when a PR is large, even if `checks.prSize` is off.
- To turn it off, answer "No preset" in `/harness:update`. The plugins it preselected stay until `harness remove` takes them out.

A preset you built can also go in for every repo, at user scope, with `harness preset install <dir> --global`. It shows each global path and its diff first, and each write needs its own yes, so you can take the core rules and leave a skill out. It offers every skill of the preset (user scope has no stack to match) and only the attribution setting, never the `env` opt-outs. Git checks (the guard asks and the `harness git` checks) stay per repo, because they need the hooks `/harness:init` installs. One global preset at a time.

| Target | Preset folder | Core block | Skills | Settings | Manifest |
|---|---|---|---|---|---|
| Repo | `.harness/presets/<id>/` (committed) | `AGENTS.md`, preset markers | `.claude/skills/<name>/` | `.claude/settings.json` | `.harness/manifest.json` |
| Global | `~/.claude/harness/presets/<id>/` | `~/.claude/CLAUDE.md`, preset markers | `~/.claude/skills/<name>/` | `~/.claude/settings.json` (attribution only) | `~/.claude/harness/manifest.json` |

A file the global install changes is backed up under `~/.claude/harness/backup/`.

To build your own, run `/harness:preset` in Claude Code. It interviews you (id, install target, working rules, picks, git, then each stack's topics), drafts the preset in a temp folder from your answers only, shows each file for edits, and runs `harness preset check`. For a repo target it runs `harness preset install`; then choose the preset in `/harness:init` or `/harness:update`. For a global target it shows the dry run and asks a separate yes for each path. It never asks for or stores a git name, email or secret.

## Usage and adherence report

`harness report` writes a usage and adherence report for this repo: which skills were invoked when they were relevant, which rules were enforced, token use, and where a gate probably blocked something it should not have. It reads your Claude Code session transcripts on your machine and sends nothing anywhere. Its "X of Y rules enforced" line counts how many of the rules harness knows about are held by a gate and not only written in a file, with a matrix of which are enforced and how each can be bypassed.

- The always-loaded table is the same offline count as `harness context`: one row per source, summing to its total. The HTML page names each row; `--export` sums rows by owner class (`harness`, `preset`, `repo`, a known catalog id or `catalog`), never by file name.
- Start Claude Code inside the repo for the report to see it. Sessions started in a parent folder are not counted.
- The page is `.harness/reports/<date>.html`, gitignored. It quotes your sessions, so don't share it. `--export` also writes counts only (no paths, quotes or names) as `<date>-export.json`, for you to send if you choose.
- `harness eval` tests whether skills, rules and gates work in real sessions. It costs money, so it asks you to type `yes` every run, stops at a cost ceiling (default $2, set with `--max-cost-usd`), defaults to a Haiku model, and runs only in your own terminal.

## Vetting a plugin or skill

`harness vet <github-url>` pins a plugin or skill to a commit and scans it without running it: hooks (also those declared in skill and agent frontmatter), secrets, network calls, prompt-injection text, licence and context cost. The report lists each finding by `file:line`, and names any file it could not read (binary, or over 1 MB). It needs the GitHub CLI (`gh`).


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

Settings live in `.harness/config.yaml`. `init` writes values that fit your repo. A Stop step can be a script name or any command, so non-JS repos work too:

```yaml
stop:
  package_manager: none
  steps:
    - { name: lint, run: [ruff, check, .] }
    - { name: test, run: [pytest] }
```

Run `harness doctor` after editing. The table below is generated from `src/core/config.ts` by `node scripts/gen-config-docs.mjs --write`.

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
| `checks.prSize` | `true` | PR size: asks before `gh pr create`, or a push to a PR branch harness recorded, goes over `pr_size.max_lines` or `pr_size.max_files`. It also turns the size warnings, the pause ask, the raise and the hand-run dispatcher deny on or off. |
| `checks.decisions` | `true` | Turns on team decisions and the `decisions.*` keys. It belongs to the `agents-md` item: with a catalog, `update` sets it from the selected items, so unticking `agents-md` turns it off. `doctor` and `status` report on decisions whatever this is set to. |
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
| `context.budget_tokens` | `2000` | Estimated tokens of all always-loaded context, your repo's own files (`CLAUDE.md`, rules, skills) included. `init`, `update`, `add` and `sync` ask before an install takes the total past it. Items you approved earlier count but are never asked about again. Value must be an integer from 0 to 200000. |
| `context.count` | `"auto"` | auto: use Anthropic's token-counting API in `harness context` when ANTHROPIC_API_KEY is set; offline: never. Value must be one of auto, offline. |
| `context.count_model` | `"claude-opus-5-5"` | The model `harness context` asks the token-counting API to count for. Value must match ^claude-[a-z0-9-]{1,60}$. |
| `tdd.paths` | `[]` | Globs for the files TDD covers. |
| `tdd.exempt` | `[]` | Globs inside `tdd.paths` that TDD skips. |
| `tdd.diff_coverage` | `80` | Minimum coverage, in percent, for changed lines. Value must be a number from 0 to 100. |
| `tdd.coverage_skip` | `[]` | Globs inside `tdd.paths` that changed-line coverage skips. `init` lists a Vitest package here when no coverage provider is installed for it, and a Jest package whose `coverageReporters` leaves out `json` or whose `coverageDirectory` (or preset) moves the output. |
| `tdd.test_lock` | `true` | Changing a test that was written failing needs your approval until it passes. |
| `tdd.results_dir` | `".harness/results"` | Where the test reporters write JSON results. Keep it inside `.harness/results`, which protect covers. Value must not be inside .harness/state (the sandbox denies it there). |
| `multi_file_gate.generated` | `[]` | Globs for generated files that the multi-file gate does not count. |
| `pr_size.target_lines` | `200` | Changed lines the pr-ship skill aims for in each PR, and the size of the first in-progress warning. Guidance only; no gate blocks on it. Value must be an integer from 1 to 100000. |
| `pr_size.max_lines` | `400` | Changed lines above which opening or growing a PR asks you first (denied when unattended). Value must be an integer from 1 to 100000. |
| `pr_size.max_files` | `20` | Changed files above which opening or growing a PR asks you first (denied when unattended). Value must be an integer from 1 to 10000. |
| `pr_size.exclude` | `["**/pnpm-lock.yaml","**/package-lock.json","**/npm-shrinkwrap.json","**/yarn.lock","**/bun.lock","**/bun.lockb","**/Cargo.lock","**/poetry.lock","**/uv.lock","**/Pipfile.lock","**/Gemfile.lock","**/composer.lock","**/go.sum","**/.!(npm\|harness)ignore","**/__snapshots__/**","**/*.snap"]` | Globs not counted toward a PR's size: lockfiles, `.*ignore` files except `.npmignore` and `.harnessignore`, and snapshots. A list you set replaces the whole default, so keep the defaults you want. |
| `decisions.max_lines` | `20` | Content lines of one generated rule. Value must be an integer from 5 to 200. |
| `decisions.expiry_days` | `90` | A decision not confirmed for this long stops loading at the next sync. Value must be an integer from 7 to 365. |
| `decisions.nudge` | `true` | Stop suggests saving a decision when the session shows signals. |
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

- `init`, `update`, `uninstall` and `context-optimize` start only from their slash commands, not from plain words.
- The guard recognises the commands `harness` and `cli.mjs` by name. A renamed copy or symlink of the CLI (`node h.mjs add x --yes`) isn't recognised, so it doesn't ask first.
- The person-only check reads the command text, so a harness command built at run time inside `eval` (for example from pieces of a variable, or from a glob) is not caught. Claude Code's own permission prompt still applies.
- Two hooks writing at once can lose or double a `timing.jsonl` rotation (rename after a size check). Lines are append-only and never torn.
- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- The guard and protect read shell commands as bash syntax. zsh-only forms are not modeled the zsh way (a subscript such as `$a[1]` is read as a plain word), and neither are aliases, which can expand to a keyword or a substitution. On macOS, Claude Code may run commands in zsh.
- The `PowerShell(...)` deny rules, and the `Read` and `Edit` rules on PowerShell commands, are unverified until a live check on Windows passes.
- The Stop gate fails open if its process can't run (`onFailure` has no effect on Stop).
- Native Windows has no sandbox: shell commands are checked by text only, and the guard doesn't parse PowerShell.
- Interactive sessions under the default `unattended` mode keep the text-check gaps (a `cd` before a write, shell reads of secrets, writes protect doesn't parse, and scripts that turn TDD off) unless the person turns the sandbox on before the session starts or uses `always`.
- A blocked settings change still sits on disk; the next session loads it. Change detection reports it at the next prompt and Stop.
- Force-push and push-to-main rules are text rules; branch protection is the real stop.
- The guard reads `$IFS` and every `${IFS…}` form as a space, and `$'…'` and `$"…"` quoting, a one-word quote (`git "push"`) and an escaped letter (`g\it`) as plain words. Other words built at run time (a variable in command position, `${!x}`, `${x//a/b}` and the other operators, zsh `${(s:_:)x}`, `IFS=`, `eval` with an expansion) ask only when the command names `harness` or `cli.mjs` as a word (a directory in a path, as in `cd /x/harness && …`, does not count), `.harness` or `.claude/settings`. A built force push or secrets read with none of those words (`S=' '; git${S}push${S}-f`, `F=-f; git push $F`, `git pu${Z}sh -f`) is not caught, and neither is a name built from pieces (`x=har; y=ness; $x$y init`, `$(printf '.har%sness/x')`); a glob counts as naming a protected path when it can match `.harness`, `.claude` or a protected file (`cd .har*ss`).
- Protect asks for any command that names `.harness`, `.claude` or `.claude/settings` and also has an expansion or substitution, a redirect to a file, an array or function definition, or a `cd` into a protected dir, `source`, `.`, `read`, `printf -v`, `declare`/`typeset`/`export`, or `bash FILE`. Outside a plain read (`cat`, `ls`, `grep`, `jq`, `git log`/`diff`/`show`, `harness doctor`/`status` with no redirect), a glob that can match a protected name or a quote or backslash inside a protected path (`tee .harness/"config.yaml"`) asks on its own. Heredoc bodies, `echo`/`printf` text whose output nobody reads, and `git commit -m`/`gh pr create --body` values are data. `xargs` or `find -exec` feeding a writer asks, and so does any `xargs` when the command names a protected path. This includes harmless forms such as `cat .harness/config.yaml > /tmp/c`, `rg ".harness" src > /tmp/hits` and `for f in .harness/logs/*; do wc -l "$f"; done`. `node_modules` keeps its own rules and is not part of this check.
- A script or program the agent wrote that takes the protected path as an argument (`node w.js .harness/config.yaml`, `python3 w.py …`), or writes a path it builds itself, is not caught: protect can't read what it does. Change detection still reports the edit at the next prompt and at Stop.
- Other force-push forms the text rule misses: bundled flags (`git push -uf`), a `+ref` (`git push origin +main`), brace expansion (`git {push,-f}`, `{git,push} -f`), a forwarding function (`f() { git "$@"; }; f push -f`), a redirect glued to the flag or ref (`git push -f>/dev/null`, `git push origin main>x`, `git checkout .>x`), an attached `-C` value (`git -C. push -f`), and a glob in a git argument that a file in cwd turns into a flag or subcommand (`git push --forc?` next to a file named `--force`, `git p* -f` next to one named `push`). Caught: a separator or closer right after the flag (`git push -f;`, `(git push --force)`), git's global options before the subcommand, quoted values included (`git -C "my dir" push -f`), a quoted separator (`git push origin x "&&" main`), and a substitution spliced into a word (`git pu$(true)sh -f`, which asks). A glob or a plain zsh alternation in the command name (`g?t`, `g[!x]t`, `G?T`, `g(i|x)t`, `node dist/cl?.mjs`, also inside `sh -c` and here-strings) is read as each ruled name it can match, never against the disk. When there are more than 64 ways to read them together, it reads each command on its own and asks at least. Not read: a zsh group with one alternative, a nested group or a quote before it (`g(i)t`, `g((i|j)|x)t`, `"g"(i|x)t`), a group after a wrapper (`env (g|x)it`), and zsh's `extendedglob` or bash's `extglob` forms (`^x`, `x~y`, `g(#i)IT`, `@(gi|x)t`), even when the command turns them on itself (`setopt extendedglob; …`). An earlier ask (an `rm -rf` or a harness command) can also hide a later deny in the same command line when attended.
- The guard's text rules read a heredoc body as commands unless it goes to a known data sink. The writer rule is strict on purpose, trading a few false blocks for no misses: `cat`, `dd` or `printf` count only when every redirect besides the heredoc is a plain `>`, `>>` or `>|` to a plain path, with no fd number, no `&`, no `<` or `<&` and no dup anywhere in the command (`cat > f <<EOF`, `cat <<EOF > f`, `dd of=f`); `tee` only when every argument is such a plain path and its stdout also goes to one (`tee f >/dev/null <<EOF`), because tee copies its input to stdout. A plain path needs no quotes and has no `$`, backtick or `..`; once normalized it has no `dev` or `proc` segment, so `//dev/stdout`, `/./dev/stderr`, `//proc/self/fd/1` and `dev/stdout` are code, and `/dev/null` counts only spelled exactly so (a folder named `dev`, as in `docs/dev/x.md`, is code too). A writer inside `( … )`, `{ … }`, `$(…)`, backticks, a function body or a compound command (`if … fi`, `for`/`while`/`until … done`, `case … esac`, whose pattern `)` closes nothing, `select`) is code, and so is `cat > f 2>/dev/null <<EOF` or `cat <<EOF >f 2>&1`. So is every writer in a command line with `exec` and a redirect, or with a function definition, `alias`, `hash` or `enable`, which can make `cat` run something else. The other sinks are `git commit -F -`, `git tag -F -` and `gh … --body-file -`, `--notes-file -` or `-F -`, under the same conditions as a plain message string below (the safe list for every command on the line; git prints `[branch sha] subject`, which a later pipeline stage could run). Reading heredoc bodies and plain messages as data is allowed only for a command written in a plain, canonical form: no backslash at the end of any line, no whitespace other than spaces, tabs and newlines (no CR, so no CRLF line ends, and no vertical tab, form feed, non-breaking space or Unicode line separator), no `$'…'` string, and, when the command has a heredoc, every line outside a heredoc body made only of what a small allowlist knows: plain words, spaces and tabs, `'…'` and `"…"` closed on the same line (`\"` and other escapes allowed inside `"…"`), backslash escapes, `$NAME` and `$1`, `;`, `&`, `|`, `&&`, `||`, the redirections `>`, `>>`, `<`, `&>`, `&>>`, `>&` (a leading fd number is a word, as in `2>&1`) and `<<<`, and heredocs written as `<<WORD`, `<<'WORD'` or `<<"WORD"` (with an optional `-` and blanks, WORD made of letters, digits and `_`, not starting with a digit), nested at most two deep (a body that holds a `<<` is checked the same way). A body under an unquoted delimiter (`<<WORD`) counts only when none of its lines holds a backtick, `$(`, `$((`, `${` or `$[`, which the shell expands as it feeds the body (`$NAME` is fine); a body under a quoted delimiter is never expanded. Anything else outside a body makes the command non-canonical: `$(`, `${`, `$[`, `$((`, `((`, backticks, `<(`, `>(`, `=(`, `[[`, `{`, `}`, `(`, `)`, `$'…'`, `$"…"`, any `#`, the words `if`, `case`, `for`, `select`, `while`, `until`, `function`, `coproc`, `repeat` and `foreach`, a quote or backslash left open at the line end, and CR. So does `<<\EOF`, `<<E"O"F`, a line continuation, or a script saved with CRLF line ends. Such a command gets the strict check: the guard decides it the way it did before this exemption existed and also with every rule above, with every line continuation joined, and the stricter verdict wins. So an odd heredoc spelling can make the guard block or ask about a command it would otherwise allow, but never allow one it would block. A backslash-newline joins lines only after an odd number of backslashes: `echo \\` followed by a newline is an escaped backslash and a line end, so the next line is a command. Shells fed a heredoc (`bash <<'EOF'`) nested more than four deep are denied outright, because each level is read again inside the one around it and the check must answer well within the hook timeout. Each guard or protect run also has a fixed work budget (4 million characters of command text read, over every reading at every nesting level); a command that would need more, such as four nested shell heredocs of 90 KB, is denied with a reason that says so, well before the hook timeout. A shell command over 256 KB is denied before any check reads it.
- Message values. A `$(…)` or backtick inside a message flag's value is read as commands, wherever it sits and whatever runs it, so the common commit idiom `git commit -m "$(cat <<'EOF' … EOF )"` and `gh … --body "$(cat <<'EOF' … )"` are blocked or asked when the body holds rule text (for example a message that explains why `git push -f` is bad). Reword the message, or write it to a file with a plain sink (`cat > /tmp/msg.txt <<'EOF'`) and run `git commit -F /tmp/msg.txt` in a later command. A plain quoted value with a space in it after `-m`, `--message`, `--body`, `--title` or `--notes` (no `$(…)` or backtick inside), and a `git commit -F -`, `git tag -F -` or `gh … --body-file -`/`--notes-file -`/`-F -` stdin heredoc, is data only when every simple command on the whole line is on this safe list: `git` (subcommands `add`, `commit`, `push`, `fetch`, `status`, `diff`, `log`, `show`, `branch`, `tag`, `notes`, `remote` with options only (`remote -v`), `rev-parse`, `cat-file`, `ls-files`, `blame`, `describe`, `shortlog`, `grep`, `rev-list`, `ls-remote` — not `init`, nor the subcommands that change working-tree files (`apply`, `am`, `checkout`, `switch`, `restore`, `stash`, `reset`, `pull`, `merge`, `rebase`, `cherry-pick`, `revert`, `worktree`, `rm`, `mv`, `clean`, `clone`, `format-patch`, `gc`, `reflog`, `update-ref`, `symbolic-ref`), since with hooks or `.husky` present a later commit would run what they wrote, and the last four write refs, objects or config, and after only a plain `-C dir` or `-c user.name=`/`user.email=`; `--git-dir`, `--work-tree`, `--namespace` and a non-plain `-C` make it code), `gh` (`pr`, `issue`, `release`, `repo`, `run`, `workflow`, `api`, `status`, `label`, `search`, `browse`, after `-R`/`--repo`), `echo` and `cat` (not piped), `true`, `false`, `pwd`, `ls`, and `head`, `tail` or `wc` with plain options only as a later pipeline stage; reached directly, after `if`/`then`/`else`/`elif`/`while`/`until`/`do`/`fi`/`done`/`{`/`}`/`!`, or through `command`, `time`, `nice` or `nohup`. The line must make no file write at all. Every redirect on the line (any `>`, `>>`, `>|`, `>!`, `>&`, `&>` or `<>` form, with any leading fd number, `&` or named `{fd}`, glued to a word or after a group) is found by a quote-aware scan that skips quoted spans and treats `$$` as the PID (not the start of `$'…'`); the only targets that are not a write are exactly `/dev/null` and a bare fd number (a dup such as `2>&1` or `>&2`). The guard does not model comments: any unquoted `#` on a message line (the shell may start a comment there, or read a mid-word `#` differently), and any unquoted whitespace that is not a space, tab or newline (NBSP, CR, FF, VT, U+2028, the BOM — a word break the guard would read wrong), makes the message code. A `#` inside `'…'`, `"…"` or `$'…'` is text, so `git commit -m "fix #12"` stays data. No `tee`, no writer heredoc — and a redirect after a group (`{ …; } > f`, `( … ) > f`, `… done > f`, `fi > f`) counts as a write by every command in it; the line must not change directory (`cd`, `pushd`, `popd` are off the list, since a later relative write lands in `.git/`; use `git -C dir …` instead). `mkdir` and `touch` are off the list too. Each safe command may take only options the guard knows to run nothing; an unknown git option, or any option not on the per-subcommand list, makes the message code, so the value-running options (`-O`/`--open-files-in-pager`, `--upload-pack`/`-u` on fetch, ls-remote or remote, `--receive-pack`, `--exec`, `--ext-diff`, `--textconv`, `-s`/`--strategy`, and `-c`/`--config` for anything but `user.name`/`user.email`) are never data. Anything else on the line makes the message code: another program (`npm test`, `pnpm lint`, `npx …`, `docker`, any interpreter or shell), `test`, `[`, `[[` or `printf` (arithmetic, `-v` and a `-eq` subscript evaluate `$(…)`), `for`, `case` or `select`, a function definition, a git alias, `git config`, `rebase`, `bisect` or `submodule`, `-c` with any other key, `gh extension`, `gh alias`, `gh repo clone`, `gh repo fork`, `gh api --input`, a `--` pass-through on a gh line, a `${…}` or `$[…]` (either evaluates a `$(…)` its single quotes do not hide), any assignment prefix or `env VAR=…` (it can set `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `GIT_CONFIG_*`, `BASH_ENV`, `LD_*`, …), a pipe after the message's own command, a `$(…)`, backtick or process substitution anywhere, `$_` or `${_}`, an `-e`/`--edit`/`--editor` on the message's command, or an editor or pager setting (`GIT_EDITOR=`, `GH_EDITOR=`, `EDITOR=`, `VISUAL=`, `GIT_SEQUENCE_EDITOR=`, `GIT_PAGER=`, `GH_PAGER=`, `PAGER=`, `LESS=`, `LESSOPEN=`, `LESSCLOSE=`, `core.editor`, `core.pager`, `sequence.editor`, `pager.<cmd>`). Code means the text rules read the message, so `pnpm test && git commit -m "docs: why git push -f is bad"` is blocked; split it into two commands. With an editor or pager setting, git and a message built at run time, the command asks at least. A line that writes git output (`git log`, `show`, `rev-parse` or `cat-file` with `>`, `>>` or `| tee`) to a file and also runs a file (`sh`, `bash`, `source`, `.`, `./x`, `chmod +x`), or writes it into `.git/`, a `gitconfig`/`.gitconfig`, `git/config`, `.husky/`, `.githooks/` or a `hooks/` dir, or sends it through a redirect whose target is a glob or `$'…'` or uses `>&`/`<>`, grouped (`{ git log …; } > f`, `( … ) | tee f`) or glued, is always blocked, since an earlier commit message could become the script, git config or a hook. The always-block reads the command three ways — heredoc bodies stripped, the raw line, and the line with quotes and backslashes removed — and blocks if any shows the write, so a `# <<EOF` comment or a lone quote in a comment cannot hide it. One form is still not caught, the same on base: git output redirected from inside a `$(…)` that carries nested quotes (`echo "$(git log … > .git/config)"`), because the scan does not follow quote context across a substitution. A plain message or `-F -` body is likewise code when any command on its line writes (`>`, `>>`, `tee` or a heredoc writer) into one of those paths. Still not caught: a plain message that a later Bash call re-runs, because shell state does not carry between calls.
- Other heredoc bodies (piped on, given to another command such as `su`, `ssh`, `at`, a `while read` loop, an interpreter, `printf` or `parallel`, printed to stdout, or written to a file the same command names again, as in `cat > x.sh <<EOF && sh x.sh`) are read as commands. A body with an unquoted delimiter that holds `$(…)`, backticks, `${…}` or `$[…]` makes the command non-canonical, so its lines are read as commands. A shell's `-c` payload is read as a command line of its own wherever it sits among the options, quoted or escaped options included (`sh -c -x "…"`, `bash "-c" -m "…"`, `bash -o pipefail -c "…"`, `zsh -fc "…"`), and inside an `env -S` or `--split-string` string, quoted or not, with env's `\_` and other escapes; GNU env's shorter prefixes (`--spl`) are not read as payloads, but they make a message on the line code. Quotes and substitutions nested deeper than 256 spans ask. Still open: the "named again" check compares plain words, so a name spelled another way (`sh x''.sh`, `sh x\.sh`, `sh x.s?`, `sh *.sh`, `f=x; sh $f.sh`), a symlink or FIFO made earlier, or a file run under another name or by another program (`.git/hooks/pre-commit`, `.git/config` aliases, a `Makefile` then `make`, `~/.bashrc`) is not caught, and neither is a file run in a later command. Some data bodies are read as code: a writer after `do`, `then` or `sudo`, a target with a variable (`f$i.md`), readers such as `wc` or `grep`, and a file named again only by `git add`, `-F` or `--body-file`; these deny only when the body holds rule text.
- `HARNESS_SANDBOX=1` is the launcher's claim; harness can't see `--settings`.
- `sandbox-required` doesn't read `sandbox.excludedCommands`: commands listed there run outside the sandbox. A mid-session change to it is blocked like any sandbox change.
- Results in `.harness/results/` can be forged by a program the agent runs.
- A flow-style `tdd: { results_dir: … }` isn't migrated by `update`; edit that one line by hand.
- MDM, registry and server-managed settings aren't read by `sandbox-required`. Only `managed-settings.json` and the `managed-settings.d/` drop-ins are read.
- A script that rewrites `.harness/state` can forge the CLI record. Protect covers file tools and named shell writes, and the sandbox denies it when unattended.
- Mid-session, only the harness CLI's own change to `.claude/settings.json` is let through. A change to the user or local settings, by anyone, applies from the next session.
- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.
- The state card is added after compaction, but the summary of earlier hook messages is Claude Code's. The card doesn't restore them.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- The CLI path the guard prints is trusted by location only (the repo's `node_modules/@khubaibqaiser/harness`). The agent can still put a copy there with commands protect doesn't parse, such as `git clone … node_modules/…`, `curl -o`/`wget -O`, `patch`, `git apply --directory`, or a `file:` dependency in `package.json` followed by an install. Read the printed command before you run it in your own terminal.
- The protected-path and `node_modules` rules read the paths a shell command names, and inline code only when it is literal in the command. Not seen by them: a program that writes files itself (a script file, a build script, an install hook), code that assembles a path at run time, a command hidden in a variable or built at run time, and quoting rules other than POSIX. Change detection reports a change to harness's own files from any of these at the next prompt and Stop, after the fact, unless the same script also rewrote the fingerprints in `.harness/state/`; it doesn't cover `node_modules` or other files.
- The guard also asks for any Bash command whose text names `harness` or `cli.mjs` and one of `init`, `update`, `add`, `remove`, `sync`, `uninstall`, `push` or `pr`, unless it can read the whole command as a plain preview. This is a safety net for shell tricks it cannot parse (globs, comments, redirections, odd spaces). The accepted cost: a command that only mentions them, such as `git commit -m "fix harness init docs"`, asks too, and so does one that only mentions `harness tdd off` (echo, grep, a heredoc written to a file, a function that forwards its arguments). A `harness tdd off` the guard can actually see being run, even inside `{ …; }` or through a glob in the CLI path, is denied.
- The guard does not see a command that never names `harness` or `cli.mjs`: a renamed or copied CLI file (`x.mjs`), `npx github:…` forms that omit the name, and npm `pre`/`post` scripts whose body lives in a `package.json` the agent edited. The agent can write such a file, so this is the same limit as running a script file.
- Harness's guard is a speed bump for mistakes and prompt injection, not a security sandbox. A determined shell trick can still get past it. Claude Code's own permission rules and its sandbox are the real boundary.
- Plugin install messages are matched by guessed wording until a live check on the real Claude Code output. If a plugin install fails oddly, run the printed command yourself.
- LSP plugin config in the `harness-pins` marketplace is unverified live. Claude Code may ignore it.
- Harness measures files, not the live session. Claude Code's system prompt and tools, the output style, MCP tools, the skill listing's own budget cuts and your personal context aren't in harness's numbers. `/context` is the truth for a session.
- Plugins enabled in `.claude/settings.json` that aren't M3 picks aren't measured: harness doesn't read the plugin cache.
- The offline estimate (characters ÷ 4) is a guess and probably runs low on current models. API counts are estimates too, by Anthropic's own docs.
- The **Project instructions** setting (`claude-md-and-agents-md` and others) lives in user or managed settings. Harness assumes the default.
- The on-demand total is the most that could load, not what a session loads.
- The budget asks cover only harness's own commands. A person editing CLAUDE.md, or another tool adding skills, is caught only when `doctor`, `status` or `harness context` runs.
- Committed picks load for every teammate, but only the person installing them is asked.
- Using the API sends the measured files' text to Anthropic under the key's account.
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
- PR size: the pause ask after a warning assumes Claude Code runs edit tool calls one at a time (unverified). If a second edit passed PreToolUse before the first edit's PostToolUse set the pause, its own PostToolUse would clear the pause before you were asked.
- PR size: a create is recorded only when its output shows the new PR's URL, so a `gh pr create` run in the background isn't recorded and its later pushes aren't checked. A create whose `--base` is set inside a script (a `package.json` script, say) is recorded against the default base, so its pushes can ask too often.
- PR size: deletes and tag-only pushes are not checked.
- PR size: two sessions writing `pr-branches.json` at once can lose one entry.
- PR size: a base whose last segment is a guard backstop word (`feat/sync`) makes the skill's measuring command ask.
- PR size warnings: changes made by shell commands are measured only at Stop, so a large codegen step in mid-turn is announced at the end of the turn.
- PR size warnings: a stacked branch with no PR yet is measured against the default branch, so it counts the branches below it. Once its PR is created and recorded, its own base is used.
- PR size warnings: a size that crosses a threshold and drops back between two measurements isn't announced.
- PR size warnings: two sessions on the same branch can race on `pr-progress.json` and lose one update. At worst a warning repeats or is skipped once.
- PR size raise: a raise is kept by branch name and never cleared. A renamed branch starts again from the repo limits, and a branch deleted and created again under the same name keeps the old raise.
- PR size raise: the early refusal of a raise beside a branch, directory or repo change matches the command text, so it lists examples, not every form, and a false match also denies. What holds for every form is that the raise is recorded only on the branch the dialog named.
- PR size raise: if harness can't read the current branch in time, the raise still asks (naming "the current branch") or is denied unattended, and nothing is recorded; run it again.
- PR size raise: an approval older than an hour records nothing; run the raise again.
- PR size raise: the dialog is Claude Code's permission prompt for a hook `ask`. Claude Code's docs say a hook `ask` prompts the person, also in auto mode (the classifier doesn't answer it), and an allow rule doesn't skip it. Other things can answer it without you: an installed mod's `tool.check` approval when the machine has no managed settings and the session isn't a Team or Enterprise login; an Agent SDK `canUseTool` callback or `--permission-prompt-tool`; and, likely, a `PermissionRequest` hook from any settings file, plugin or skill (the docs say it runs when Claude Code is about to ask and its `allow` grants the permission, but not in so many words that it sees a hook's `ask`). Harness can't tell those apart from you.
- PR size raise: a raise is a guardrail, not a security boundary. Harness denies commands whose text runs a hook dispatcher without `--pr-size`, `--pr-size-raise` or `--self-test` (so it would read hook events from stdin), or copies, moves, links, pipes or redirects a hook file. It judges command text only, so these still get past it: a path built at run time (`$(printf …)`), a copy made with a tool it doesn't list (`tar`, `zip`, `sed w`), a renamed copy or a script the agent wrote itself, and a `.harness` symlink whose path doesn't end in `hooks/dispatch.mjs`. Any of them can feed the dispatcher forged hook events or write harness state.
- PR size raise: the hook-file check over-matches. A hook file in a pipe or redirect is denied even when it is only read (`grep x .harness/hooks/dispatch.mjs | head`), and a project's own `hooks/dispatch.mjs` run without those flags is denied too. Reading a hook file with no pipe or redirect (`cat`, `grep`, `git diff`) is allowed. The check is part of the pr-size check, so `checks.prSize: false` turns it off. The real boundary is Claude Code's sandbox: with it on, the `Edit(./.harness/…)` deny rules harness installs also limit shell commands' writes, per Claude Code's sandbox docs (not tested here). See [Start unattended runs in the sandbox](#start-unattended-runs-in-the-sandbox).
- PR size warnings: a subagent's edit gives the warning to that subagent, not to the main agent (unverified). Your message still shows.
- PR size warnings: where AskUserQuestion isn't available (some subagents, `claude -p`), the agent can only ask in text, and the pause dialog asks again at the next edit.
- PR size warnings: the agent's question counts as the ask only when its header is exactly `PR size` and the person's answer reaches harness as `tool_input.answers` at PostToolUse. That shape was read from the Claude Code 2.1.285 binary, not from the hooks docs, so it is unverified, pending the live check. A reply you type instead of picking counts, whether Claude Code passes it as the first question's answer or as freeform `response` text; as the first question's answer it counts only when the `PR size` question was first. A question left open for more than a day clears nothing, nor does one closed by the auto-continue timeout or one where you asked for more questions (`followUp`). Another installed hook that answers the question (a PreToolUse `updatedInput` or a `PermissionRequest` hook) is taken as your answer.
- PR size warnings: unattended, a crossing caused by a shell command is caught only at Stop, where it is logged, so the agent is never told about it. The PR-time deny still holds.
- PR size warnings: each counted edit runs 7 or 8 git calls. That measured 91 ms median overhead on macOS in a 20-file repo. In a large repo the cost is mostly the two `git diff` calls over the working tree, which can take up to the 6 s budget; a timeout gives no warning, only a stderr line.
- PR size warnings: a Stop that harness blocks before its checks run (an invalid config, changed harness files) drops that Stop's warning; the next Stop announces it.
- Not in this release: the PR reviewer (M2) and TDD for other languages.

## Development

Build from source (pnpm comes with `corepack enable`) and load it with `--plugin-dir`:

```bash
git clone https://github.com/KhubaibQaiser/harness.git
cd harness && pnpm install && pnpm build
claude --plugin-dir /path/to/harness
```

From a source build there's no `harness` binary, so run `node /path/to/harness/dist/cli.mjs` wherever the docs say `harness`.

```bash
pnpm install
pnpm build && pnpm test && pnpm test:perf
pnpm typecheck
node scripts/gen-config-docs.mjs --write   # after changing a config key
```

CI runs the tests on macOS and Windows with Node 22, plus Linux jobs for gitleaks, a pack check, real Vitest and Jest installs, and `claude plugin validate`. A `v*` tag publishes to npm after an approval step, then mirrors the package to GitHub Packages and creates a GitHub release. See [release.md](release.md).

## Roadmap

Shipped in 0.2.0-beta.1: per-project recommendations from a pinned catalog. Coming next:
- an opt-in personal preset of working rules and stack skills;
- memory, the PR reviewer, and TDD for other languages.
