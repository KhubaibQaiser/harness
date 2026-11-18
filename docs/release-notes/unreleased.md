# Unreleased

<!-- Notes for the next release. When package.json gets the new version, rename this file to
docs/release-notes/<version>.md: the release workflow's check-tag step needs that file at tag time. -->

## What changed since 0.2.0-beta.2

Run `/harness:update` in each repo after upgrading: this release changes `.claude/settings.json` (the sandbox's `denyWrite` list, new deny rules, the evidence-ledger hook and the pinned marketplace's name). Three changes need you to act: the Stop gate now needs `srt` (and ripgrep) on macOS and Linux, and a timed-out Stop step now blocks (both under Breaking); and if your scripts copy the documented unattended launch command, replace it with the new one (under Unattended launch).

### Breaking

- The Stop gate's steps now run inside Anthropic's sandbox-runtime (`srt`) by default, so attended macOS and Linux Stop gates need `srt` installed. Install `@anthropic-ai/sandbox-runtime@0.0.83` globally with npm, outside the repo. Linux also needs bubblewrap 0.8 or newer, socat and ripgrep; macOS needs ripgrep. Until `srt` is installed, Stop blocks with the fix. A Stop with nothing to run (a docs-only change, a clean tree) still passes without `srt`.
- Steps get no network, no loopback and no Unix sockets, and can't write outside the repo and the temp folders. New keys: `stop.allowed_domains`, `stop.allow_write` and `stop.allow_local`. A suite that needs the network, a host service or testcontainers fails until you allow it, or set `sandbox: off` before the session starts (logged).
- Before any step, a preflight inside `srt` proves the fence holds: a write to a protected file, a read of a masked file, a Unix socket, an HTTPS connection to `example.com`, and on Linux a nested bubblewrap user namespace must all fail. The outer runner checks the canaries and socket again afterwards, and the results carry a sealed end line, so a forged result can't pass. A run that reports nothing before the timeout blocks as unavailable. Any `srt` stderr other than its `sandbox proxy:` lines blocks. A failed check blocks Stop and names itself. A machine that is offline reads as network-blocked, which is safe.
- When the attempts run out, Stop passes by its existing rule and logs `checks never ran (srt unavailable)` in `.harness/state/stop-sandbox.json`; it is never a pass.
- Attended native Windows keeps running steps unwrapped, with a note on every Stop. An unattended native Windows Stop now blocks (`checks never ran (native Windows unattended)` on give-up); run in WSL2 or the harness dev container.
- `harness doctor` has a Stop sandbox section (the `srt` version and its dependencies, the refused `stop.allow_write` entries, the last preflight result per check, and on native Windows a warning, plus the never-ran fix after an unattended give-up), and `harness status` has a `Stop sandbox:` line that adds `last stop: checks never ran` when it applies.
- A Stop step that runs past `stop.timeout_s` now blocks and counts as an attempt toward `stop.max_attempts`, instead of letting the Stop through with a note, so a hanging test can't skip the checks. Listed under Breaking because the default is stricter: a suite slower than `stop.timeout_s` (default 540) blocks until you raise it. After the last attempt the Stop passes by the existing rule and logs `checks never ran (timeout)`; the event log gets `stop-timeout` with the step name.

### Claude Code's sandbox is the first layer

- `init`, `update` and `sync` now write harness's protected paths into `sandbox.filesystem.denyWrite` in `.claude/settings.json`, in every sandbox mode, so with the sandbox on any Bash write to them fails, however it is spelled. The list comes from protect's own table, so the two can't drift.
- `init` turns the sandbox on for interactive sessions where the machine can run it (`sandbox: always`, now with `failIfUnavailable`). Because those settings are committed, a machine that can't run the sandbox runs no Bash; `harness doctor` says so on that machine, with the fix.
- `harness doctor` reports settings that turn the sandbox off or undo it, a managed settings file Claude Code can't read, and `allowManagedHooksOnly` without harness hooks in managed settings.

### Unattended launch

- An unattended `bypassPermissions` or plan-mode run whose sandbox is confirmed from settings files (including every `sandbox: always` repo run with `--dangerously-skip-permissions`) now has its shell commands denied unless your user or managed settings set `sandbox.network.strictAllowlist: true`. Without it, the sandbox lets such a run reach any host.
- The documented launch command now carries `strictAllowlist`, its own `allowedDomains` (empty) and `credentials` deny entries. A run that installs packages or pushes fails until you list the hosts it needs, and `gh`, cloud CLIs and `npm publish` can't sign in from the shell. The README says how to allow pushing.
- If your scripts copy the old command, replace it: `HARNESS_SANDBOX=1` now stands for the full one.
- The launch also sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, which strips credential-looking variables from Bash, the hooks and the Stop gate's test commands, and on Linux blocks reading other processes' env through `/proc`. Tests that need such a variable must get it another way. The scrub also strips `CLAUDE_CONFIG_DIR`: if you use it, add `HARNESS_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"` to the launch. Harness now reads the user config dir from `CLAUDE_CONFIG_DIR`, else `HARNESS_CLAUDE_CONFIG_DIR`, else `~/.claude`, and blocks a mid-session user-settings change that Claude Code reports in a file it doesn't watch.
- The scrub forces the permission mode to `default` (checked live on Claude Code 2.1.322), so `bypassPermissions` is ignored and `claude -p` refuses every tool that needs approval. The launch now passes `--allowedTools "Bash,Edit,Write"` (add what your run needs) and `HARNESS_UNATTENDED=1`, which keeps the run unattended when the scrub is off.
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` set to anything but empty, `0`, `false`, `no` or `off` now makes a run unattended in the hooks and the CLI refusals, so a scrubbed `claude -p` run is no longer judged attended in `default` mode. When it is the only cause, SessionStart shows a note that says so. If you export it in a shell profile, every interactive session turns asks into denies: unset it for interactive work. The SessionStart hook now runs at every session start (it ran only on `compact`); run `/harness:update` to pick up the new group.

### Done contract (preview, off by default)

The done contract makes an agent's "done" a verdict harness computes from evidence against criteria you approved. Everything stays off until you set `checks.done: true`. The pieces in this release:

- `harness task draft|approve|edit|close`: the agent drafts a task contract; only you approve, edit, close or replace one, and each shows the change and needs `--yes`. Contracts live in `.harness/tasks/`, which the agent can't write with any tool or through the sandbox.
- With `checks.done` on, the agent's first edit is denied until an approved contract is the active task. An unattended run names its contract with `HARNESS_TASK=<id>`, and it must be on the base branch. The guard and protect close the ways an agent could plant a contract (repointing `refs/remotes/*`, git aliases and replacements, raw writes into `.git`).
- An evidence ledger: a hook records which configured checks and criteria actually ran, at which working tree, and whether they passed. A failing, interrupted or forged result never counts as a pass. `harness done --blocked "<reason>"` records why an agent can't finish.
- At Stop, a message that claims the work is done is blocked while a required check or machine-checkable criterion has no passing evidence for the current tree.
- `harness verify` (and `/harness:verify`) collects the evidence, re-runs what is stale (inside `srt`, unless `sandbox: off` or native Windows), runs a tamper check over the task's diff (weakened tests, changed check commands and the like) and writes a verdict for this commit and tree to `.harness/verdicts/`. Only a run in your own terminal records it as trusted. Exit 0 done, 1 not done, 3 blocked, 2 usage.
- `uninstall` keeps `.harness/tasks/`, like `.harness/presets/`.
- The details are in `docs/reference.md#done-contract-preview`.
- `harness verify` and the evidence ledger work after a real `init` (ship audit M4). The tree hash used exclude pathspecs for harness's folders, and `git add` exits 1 when those name folders that init's `.gitignore` ignores, so every verify read not-done and the ledger wrote no rows. It now adds everything to its throwaway index, then drops harness's folders from that index; the real index is still never read or written. Files committed under those folders no longer count either.
- Because the tree hash changed, a verdict or evidence-ledger row written by 0.2.0-beta.2 may not match the new hash after you upgrade, so it counts as stale and those checks run once more.

### PR review (experimental, local only)

- New `/harness:review <pr>`: a code-only review of a GitHub PR that you read locally. `harness review <pr> --out <dir>` gathers the PR without running any of its code, the installed `staff-reviewer` agent reviews it, harness checks every finding against the code, and a small-model `review-judge` agent can drop a finding the evidence doesn't support (it can't add one or raise a severity). `harness review --finish` writes a local record and a preview; `--keep <pr>` keeps it. Nothing is posted to GitHub yet.
- New `review.max_findings` config key, and `harness validate pr-review` and `validate pr-judge` for the agents' replies. It needs `gh`; run it from the base branch, in a fresh session.

### PR descriptions

- `/pr-ship` writes each PR body from a 10-section template for human reviewers. A new check, `checks.prBody` (it follows `checks.prSize` when unset, so repos without the `pr-ship` item stay off), runs on every agent `gh pr create`, `gh pr new` and `gh pr edit` that sets a body: the body must come from one `--body-file` with every section filled. A PR that lists steps a person must do needs the `needs-human` label, and `gh pr merge --auto`, `--admin` and removing `needs-human` are denied.

### Guard and protect

- `gh` and `hub` are now an allow-list: their known reads run freely, and every other subcommand asks (denied unattended), including writes, `gh api` writes, extensions and aliases. A new `mcp-writes` check lets only read tools run freely on git-host MCP servers and denies auto-merge.
- Wrapped and path-qualified commands decide as their plain form (`/usr/bin/rm -rf /`, `nice tee .harness/config.yaml`), and one shared option reader closes plain-form gaps for deletes, installs and writes into protected paths (`cp`/`mv` targets, `tar -C`, `git archive -o` and more). Every change only adds an ask or a deny.
- Git commands that move the worktree to another ref (`checkout`, `switch`, `restore --source` and the like) ask when they would change a protected harness file, and deny unattended.
- Two more Claude Code deny rules catch `git push -f…` and `git push +ref` when the force flag comes right after `push`.
- `harness remember add` with text that repeats this session's tool output needs `--quoted` and your yes.
- With a preset recorded, the guard asks before a `git commit` that carries an AI trailer (when the preset sets `git.no_ai_trailer`) and before a new branch without one of the preset's prefixes.

### Secrets scanning

- New catalog item `gitleaks-ci` (kind `ci`): a GitHub workflow that scans the full git history with gitleaks 8.30.1, checksum-verified, with `--redact`. `/harness:init` recommends it for `api` and `infra` repos.
- New catalog item `gitleaks-commit`: a new check, `checks.secretScan`, scans what an agent `git commit` or `git stash` could take (staged changes, and unstaged and untracked files that are not ignored) and blocks on a finding, naming the rule, file and line, never the value. The commit must be the only, plain command on its line. Merges, rebases and similar commands ask. Editing `.gitleaks.toml` or `.gitleaksignore` asks. It needs gitleaks on PATH and git 2.40 or newer; without them every agent commit is blocked until you install them or remove the item.
- Both items scan with harness's own rules, so a repo's `.gitleaks.toml`, `gitleaks:allow` comments, `.gitattributes` and NUL bytes can't hide a finding. A `.gitleaksignore`, which gitleaks always reads, blocks agent commits and fails the CI job.
- Any executable hook (not a `.sample`), or git config that names a program git may run (by key pattern: `*.program`, `*.command`, `*.cmd`, `*.editor`, `*.helper`, fsmonitor, filters other than git-lfs's, textconv, `diff.external`; credential and diff/merge tool namespaces left out; the editor only when the commit opens it, gpg programs only when it signs, textconv and `diff.external` only for the verbose diff in the editor; `interactive.diffFilter` too), makes an agent commit or stash ask, since git runs them after the scan; unattended, that is a deny. Writing a hook or `.git/config`, or changing `core.hooksPath`, `core.fsmonitor` or a filter, asks.
- The commit check is a seatbelt against honest mistakes and casual bypasses; `gitleaks-ci` and the done-contract CI verdict are the backstops.
- This repo's own CI gitleaks job is hardened the same way, and its catalog-pin allowlist is anchored to whole pin lines.

### Safety

- Harness never writes or deletes through a symlink planted in a folder the agent can write (`.harness/logs`, `tmp`, `state`, `reports` and the rest).
- Harness removes only files it created: `harness workdir --clean` removes only a folder `workdir` made, temp files never truncate an existing file, and eval results, preset installs and task drafts never overwrite one.

### Eval

- `harness eval --kind gates` now runs: four cases check that the guard, protect and TDD gates deny in a real `claude plugin eval` session. The default is now all three kinds. It still costs money, asks you to type `yes` every run and stops at a cost ceiling.

### Install, plugins and the skills

- Plugin pins now live in a marketplace named after its content (`harness-pins-<hash>`), so two repos with different pins no longer overwrite each other's plugin sources. `update` and `sync` rename the old shared `harness-pins` entry, and `doctor` flags a leftover one.
- `git-subdir` plugins are pinned by HTTPS URL, so they install without a GitHub SSH key.
- Claude Code's "not found in marketplace" message for a not-yet-registered pins marketplace now gets harness's restart-then-sync hint.
- The skills read and write only inside the repo (new `harness guide` and `harness workdir`), so `blockReadsOutsideWorkingDirectories` no longer asks about them.
- The `!` hint now says a `!` command runs outside the sandbox.
- The minimum Claude Code version is now 2.1.295 (was 2.1.314), the oldest version the live checks passed, so Claude Code's `stable` channel passes `doctor`.
- The release now also moves npm's `latest` tag to each prerelease until the first stable version, so a plain `npx @khubaibqaiser/harness` gets this release.

### Hooks and the report

- After the first file of a turn, the multi-file gate sends a note that the next file will ask, because Claude Code's Edit dialog doesn't show a hook's reason.
- Parallel hooks no longer lose a session-state update under heavy load (such as a file the multi-file and TDD gates count). A hook now waits up to 5 s for the session lock instead of 2 s. Its lock waits together end 7 s after the hook started, well inside the hooks' 10 s timeout. Every state write, Stop's included, takes a short write lock (`<session>.wlock`, at most 1 s), re-reads the file and merges its own change into it: lists by set-union, records per key, a raised counter by the larger value, and a reset stays a reset, including one another hook made meanwhile. At most 3 decision hits are kept. If the session lock still isn't free, and multi-file or a TDD gate not paused for this session is on (or the config is invalid), an edit, a shell command (Bash, PowerShell, Monitor) or an MCP tool that isn't a read fails closed. Harness asks, or denies in an unattended run, and says the state was busy. Read-only tools and other events still run, with locked, merged writes. A write that can't get even the write lock is logged as `state-write-lost`, and a write gate then fails closed. On Windows the write-lock wait also covers another writer's retries of a file a scanner holds. A new turn's reset that can't get the write lock is kept pending (`turn-reset-pending`) and applied by the next write, so the Stop attempt count still restarts.
- An MCP tool counts as a read only when no action verb appears anywhere in its name, so `get_or_create_branch` is now a write and asks on a git host. After a leading read verb, `run`, `release`, `review`, `comment`, `label` and `request` count as nouns, so reads such as `get_workflow_run` and `get_pull_request_review_comments` still pass.
- The dispatcher writes per-call timing to `.harness/logs/timing.jsonl` (event, tool, outcome, ms; no paths or command text), and the usage report shows it.

### Changed

- Test files no longer count toward the PR size limit by default (owner ruling 2026-11-16, reversing the pr-size spec's D3): `*.test.*`, `*.spec.*`, `__tests__/`, `test/` and `tests/` folders, Python `test_*.py` and `*_test.py`, Go `*_test.go` and `conftest.py` join the default `pr_size.exclude`. They are still named in the size warning's "Not counted" list, and the PR reviewer still reads them. A `pr_size.exclude` you set replaces the whole default, so tests count again unless you list them.

### Stop gate on Ubuntu 26.04

- The message no longer tells you to install `srt` when `srt` is installed and failed a check (`srt exit`, `srt warning`, preflight checks and the like): it points at `harness doctor` and `srt`'s own error. `harness doctor` now detects Ubuntu's loaded `bwrap-userns-restrict` AppArmor profile (the cause of `srt exit (apply-seccomp: write /proc/self/setgroups)` on 25.04 and newer) and prints the fix and its cost; it never applies it. CI now also runs the real-`srt` job on `ubuntu-26.04`.

### Claude Code compatibility

- The `ConfigChange` hook now holds a mid-session settings change only when it weakens harness: a harness hook entry or deny rule removed or changed, `disableAllHooks` turned on, a sandbox key or `denyWrite` path harness wrote loosened, a looser value winning across the settings files for `sandbox.enabled`, `allowUnsandboxedCommands` or `strictAllowlist`, whichever file changed, or a hook-steering `env` key (`PATH`, `NODE_OPTIONS`, `CI`, `HARNESS_*`, `GIT_*` and the like) changed. Your own hooks, deny rules, other `env` keys (an MCP token, a model) and `/sandbox` network domains apply at once. Claude Code shows nothing for a held change, so the notice at your next prompt names the weakened parts and says the whole file change was held.
- What harness wrote is read from the manifest as it was at the session start. A manifest that becomes unreadable or loses a record mid-session holds every settings change. Until a follow-up lands, an allowed `sandbox` or `env` edit in the project or local settings still gets one change notice and one blocked Stop.
- Also held mid-session (owner answers, 2026-11-16): a hook added to any settings file (it takes effect next session; editing a hook's `timeout` or `statusMessage`, or removing your own hook, still applies), an entry added to `sandbox.excludedCommands` in any file (removals apply), and `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP` or `ComSpec` in settings `env`.
- Also held mid-session: a proxy port (`network.httpProxyPort`, `socksProxyPort`) set or moved, `network.allowAllUnixSockets` or `enableWeakerNestedSandbox` turned on, and a new `network.allowUnixSockets` path, judged on the value that wins across the settings files. Tightening them applies. Enabling a plugin still applies; its own hooks aren't covered by the new-hook block.
- Also held mid-session: `network.allowLocalBinding` turned on and a new `network.allowMachLookup` service, judged across the settings files. A guarded sandbox key whose value isn't the documented type (such as `"true"` for a Boolean) counts as loosening.
- `harness review` no longer refuses when the project's `staff-reviewer` differs from the plugin's copy (the project agent takes priority); it now stops only when the CLI version differs from the base install's recorded version.
- The PR size question clears the pause only on a documented `answers` entry; the undocumented `response` text no longer clears it alone. An unknown key in the question's call or result logs `ask-shape-unknown` once per session.
- `harness remember add` now says "harness couldn't check whether this text quotes tool output" when the transcript can't be read, or shows tool calls but no recognised tool result. It was already a deny without `--quoted`.

### CLI version and messages

- Every `npx @khubaibqaiser/harness …` command harness prints now names the running version (`npx @khubaibqaiser/harness@<version> …`). A bare `npx` runs npm's `latest` tag, which can be older and lack the command.
- `harness update --check` reports an update only when npm has a newer version (semver, prerelease tags included), reading both the `latest` and `beta` tags. It never offers a downgrade, and it names the exact version to run.
- `harness --version` (or `-v`) prints the version and exits 0.
- Message fixes: `harness eval` usage drops the stale "(gates: not yet)"; a bad `stats` or `tdd` argument prints that command's own usage line; `doctor` labels a missing `claude` as a note, not "ok"; `verify` names an invalid `.harness/config.yaml` in a plain sentence; `uninstall`, `update` and the other commands no longer give init's `--config` hint without a terminal; `sync` and `add` no longer call an install with no catalog items old; Stop no longer prints a pr-size line to stderr in a repo with no base branch yet; with no Vitest config, init prints a whole `vitest.config.ts` to create, not a fragment.
### Writes and scans

- `harness verify` and `harness report` in a repo or folder where harness isn't installed (no `.harness/manifest.json`) now say so, exit 1 and write nothing. Before, they left `.harness/state/` or `.harness/reports/` behind, and `init` then refused (ship audit S1). The CLI also records its own path in `.harness/state/` only where a manifest exists.
- `init`, `update`, `sync`, `add`, `remove`, `context apply` and `rules --apply` no longer name a file they would create as uncommitted just because it sits in an untracked folder; only files that exist there count.
- A write the OS refuses for a reason other than Claude Code's sandbox, such as a read-only folder (`EACCES`), now prints the real error ("apply failed and was rolled back: EACCES: permission denied …"), not "Claude Code's sandbox blocks harness's own files". The sandbox line needs `EPERM` or `EROFS` on one of harness's denyWrite paths, as the reference already said (ship audit S6).
- `update` and `sync` keep a `checks.done: true` you set by hand. No catalog item owns that check, so it no longer reverts to `false`, and `doctor` no longer calls it a difference from the selected items (ship audit S7).
- A file in the plugin's `skills/` folder, such as Finder's `.DS_Store`, is no longer listed or measured as a skill by `harness context`, `doctor` and the context budget (ship audit S9).
### CI

- Main is green again on macOS and Windows (ship audit M2). protect's check of a `git checkout` or `git switch` to a branch, tag or hash now looks up the ref and its hooks in one git call, not two, so the hook is faster; every decision is unchanged. The `review` gather test for matching CLI versions runs each case as its own test, so it no longer passes its 30 s timeout on Windows.

## Catalog

Catalog version 1, 92 items: 72 plugin, 6 external-skill, 5 own-hook, 3 mcp, 1 rule, 1 settings, 2 own-skill, 1 own-agent, 1 ci.

## Left out (38)

Listed in `catalog/excluded.yaml`. `init` never recommends these.

### Own items that are not selectable (20)

- Not built yet (this release ships existing own items only): `post-edit-format`, `session-context`, `researcher`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `session-structure`, `ci-tdd`, `harness-integrity`, `lefthook-baseline`, `claude-code-action`, `harness-devdep`
- In the core install since platform enforcement; not a selectable item: `config-change-guard`, `sandbox-settings`
- Part of the PR reviewer (M2): `harness-review`, `ui-verifier`
- Replaced by the pr-size check (`pr-ship` item): `pr-create-trigger`

### Left out by the owner (6)

- `sourcegraph`: needs an enterprise Sourcegraph instance; single-repo work is covered by local search
- `context7`: queries go to Upstash's hosted backend; vendor llms.txt pages and docs MCPs cover the need
- `serena`: runs its unpinned upstream branch at every launch; LSP plugins cover it
- `supabase-agent-skills`: overlaps the supabase plugin (same plugin name)
- `getsentry-skills`: its always-on commit skill imposes Sentry's commit conventions
- `deepeval`: Python-only; project facts read JS dependencies only for now

### Research exclusions (12)

- `mcp-for-blender`: PyPI-only package run with uvx; the catalog can pin only npm or remote MCP sources
- `spec-kit`: installed with the specify CLI (uv tool install specify-cli); the repo has no Claude Code plugin manifest or skills directory for the catalog to pin
- `remember`: no license; LICENSE is a custom "Community License" with no-commercial-redistribution and no-competing-use clauses, not an SPDX license
- `wshobson-agents`: the repo is a marketplace of 94 plugins, not one plugin; there is no single source to pin
- `graphify`: installed from PyPI with `uv tool install graphifyy` then `graphify install`; the repo (Graphify-Labs/graphify) has no Claude Code plugin manifest and is not in the official marketplace, so the catalog has nothing to pin
- `maestro-mcp`: the MCP server is the `maestro mcp` command of the Maestro CLI binary (mobile-dev-inc/Maestro, Apache-2.0); it is neither an npm package nor a hosted server, the repo has no plugin manifest, and the older mobile-dev-inc/maestro-mcp repo is archived
- `prisma`: no license: prisma/claude-plugin has no LICENSE file, no license field in plugin.json and no README at the marketplace pin 815dbc4a045a (the repo holds only .claude-plugin and .mcp.json; GitHub license is null). Its .mcp.json also runs `npx -y prisma mcp` unpinned
- `mergify`: no open-source license: Mergifyio/mergify-cli LICENSE (marketplace pin 6307ed10e862) is a proprietary Mergify licence that allows running the software unmodified only with the Mergify service; plugin.json says LicenseRef-Mergify-Proprietary and the GitHub license is NOASSERTION. Brief step 4 excludes non-standard licenses; owner may add it back as vendor-terms
- `claude-security`: proprietary license: plugins/claude-security/LICENSE (marketplace pin a2e251d9b97b) says the plugin is "proprietary to Anthropic", all rights reserved, with a limited, non-transferable licence to run and modify it for internal use solely with Anthropic products; it is not an open-source or SPDX licence. plugin.json says "SEE LICENSE IN LICENSE". Owner may add it back as vendor-terms
- `semgrep`: no license: semgrep/mcp-marketplace (marketplace pin b58f407c6ac0, plugin dir plugin/) has no LICENSE or NOTICE file at the pin or at HEAD, no license field in plugin.json, and no license line in README.md; GitHub license is null. It also ships precompiled hook binaries and downloads and auto-updates a Guardian binary from semgrep.dev, so it is not just a pointer to a hosted server. Owner may add it back as vendor-terms
- `sonarqube`: no open-source license: SonarSource/sonarqube-agent-plugins LICENSE (marketplace pin 5a9356d957db) is the SONAR Source-Available License v1.0 (plugin.json license SSAL-1.0), which restricts use that competes with SonarQube and is not an SPDX open-source licence; GitHub says NOASSERTION. Brief step 4 excludes a non-standard license (as for mergify). If added back, the owner's Q5 stance applies: discouraged with stance_reason "belongs in CI quality gates, not the agent session."
- `evals-skills`: archived upstream: hamelsmu/evals-skills (MIT, 1675 stars) is archived on GitHub (last commit 22418da2bfb1, 2026-08-16); audit.html's pick for fitness-app's AI feature ("Error analysis and checking LLM judges against human labels"). langfuse (judge-calibration and error-analysis references) and deepeval cover the area

## Unpinned items

Every plugin and MCP server is pinned to a commit or an exact version. These run code that is not pinned, so what runs can change without a catalog change. Each is flagged in the item's evidence. Hosted MCP servers are not listed: their code does not run on your machine.

- `playwright`: runs `npx @playwright/mcp@latest`: the newest release from npm at run time
- `deploy-on-aws`: runs `uvx awslabs.aws-iac-mcp-server@latest` and `uvx awslabs.aws-pricing-mcp-server@latest` at launch
- `aws-serverless`: runs `uvx awslabs.aws-serverless-mcp-server@latest --allow-write` at launch
- `databases-on-aws`: `uvx ...@latest` for the aurora-dsql and cloudwatch servers; the vendor file marks both `disabled`, but Claude Code doesn't document that key, so they may still start
- `jfrog`: three `npx` commands name `@jfrog/agent-guard` with no version, at session start, on Skill and Read calls, and on prompt expansion
- `tdd-guard`: `npx tdd-guard@latest` in three hook events
- `probity`: `npx @nizos/probity` on every Bash, Write, Edit and NotebookEdit call: the local copy if installed, else the newest from npm
- `security-guidance`: installs claude-agent-sdk with pip and no version pin
- `expo`: its feedback step runs `npx --yes @expo/agent-cli@latest feedback`, only when feedback is submitted
- `shadcn`: its skill runs `npx shadcn@latest info --json` when it loads

These 44 items (38 plugins and 6 external skills: `react-best-practices`, `react-native-best-practices`, `shadcn`, `vercel-react-native-skills`, `web-design-guidelines`, `webapp-testing`) are pinned by commit but come from a `git-subdir` source with no `plugin_version`, so `doctor` has no version to compare and cannot report drift: `42crunch-api-security-testing`, `agent-sdk-dev`, `auth0`, `aws-core`, `aws-serverless`, `claude-code-setup`, `claude-md-management`, `code-review`, `code-simplifier`, `databases-on-aws`, `deploy-on-aws`, `design`, `engineering`, `expo`, `feature-dev`, `frontend-design`, `hookify`, `impeccable`, `kotlin-lsp`, `mcp-server-dev`, `neon`, `playwright`, `pr-review-toolkit`, `railway`, `ralph-loop`, `react-best-practices`, `react-native-best-practices`, `revenuecat`, `security-guidance`, `session-report`, `shadcn`, `skill-creator`, `stackhawk-hawkscan`, `stripe`, `swift-lsp`, `tdd-guard`, `terraform`, `trailofbits-insecure-defaults`, `trailofbits-supply-chain-risk-auditor`, `typescript-lsp`, `vercel-react-native-skills`, `web-design-guidelines`, `webapp-testing`, `workos`.

## Known limits

The full list is in `docs/reference.md#known-limits`. This release adds:

- 32 PR-size limits: text detection only, the unmeasured note, the pause and the agent's question, the raise and the hand-run deny.
- Guard and protect: zsh-only forms and aliases are read as bash; force-push forms, heredoc bodies and message values the text rules can't read; a script the agent wrote that takes a protected path as an argument.
- Context budget: harness measures files, not the live session (`/context` is the truth); the offline estimate probably runs low; plugins enabled outside the catalog picks aren't measured; the on-demand total is the most that could load; the budget asks cover only harness's own commands; using the API sends the measured text to Anthropic; the state card doesn't restore Claude Code's summary of earlier hook messages.
- Team decisions: a decision path built at run time, a script, or `tar -x`/`unzip` with no `-C`/`-d` can still change decision files; change detection fingerprints only the generated rules.

New since 0.2.0-beta.0, unchanged in this release:

- Plugin picks are local only and are missing in cloud sessions.
- `extraKnownMarketplaces` needs folder trust.
- MCP servers need each user's approval.
- `CLAUDECODE` is also set in IDE terminals.
- There is no version-drift check for `git-subdir` plugins without `plugin_version`.
- The agent asks before item changes.
- MCP servers aren't measured before install, and only the person installing is asked about the budget. Plugins and external skills now count the number the catalog records (see Context budget above).
- Under `sandbox: always`, item commands may need the `!` prefix. Unverified, pending the live check.
