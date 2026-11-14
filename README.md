# @khubaibqaiser/harness

**Make Claude Code follow your rules, not just read them.**

A line in `CLAUDE.md` saying "write the test first" or "never read `.env`" is a suggestion, and a busy agent skips it. Harness turns those rules into hooks that run on every tool call. The agent can't edit before a failing test exists, can't read your secrets, and can't stop while lint or tests fail.

Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt.

**Safety model, in two layers.** The first is Claude Code's sandbox, at the OS level. Init turns it on for every session on macOS, and on Linux and WSL2 when the machine can run it (`sandbox: always`). Harness also lists its own protected files in the sandbox's `denyWrite`. With the sandbox on, any Bash write to them fails, however it is spelled (`echo >`, `tee`, `/bin/cp`, `sh -c`, Python). The second layer is harness's text checks, guard and protect, which read every command and edit. They cover the Edit and Write tools, which the sandbox doesn't, and every platform. On native Windows there is no sandbox, so the text checks are the only layer: a seatbelt that catches mistakes and can be bypassed. See [Sandbox](docs/reference.md#sandbox).

**A machine that can't run the sandbox.** The strict sandbox settings are committed for everyone, so on a machine that can't run the sandbox, Claude Code won't run Bash at all. That means native Windows, WSL1, Linux and WSL2 without `bwrap` and `socat`, and Ubuntu with its AppArmor user-namespace restriction on. `harness doctor` tells you so on that machine, with the fix. Fix the machine, or set `sandbox.failIfUnavailable: false` in your own `.claude/settings.local.json`; Bash then runs without the sandbox there, guarded only by harness's text checks.

**Status:** beta, version `0.2.0-beta.2`, on npm under the `beta` tag: `npm i -g @khubaibqaiser/harness@beta`. Release notes: [docs/release-notes/0.2.0-beta.2.md](docs/release-notes/0.2.0-beta.2.md).

## Who it's for

- Developers who run Claude Code on real code and want TDD, clean commits and passing checks every time.
- Teams that want one set of agent rules in the repo. The hooks are committed, so everyone gets the same rules.
- Anyone running agents unattended, in CI or overnight, where nobody is watching to say no.

## Quick start

You need Node 22.11 or newer, git, and Claude Code 2.1.295 or newer.

1. **Install the plugin:**
   ```bash
   claude plugin marketplace add KhubaibQaiser/harness
   claude plugin install harness@harness
   ```
   To build from source instead, see [docs/reference.md](docs/reference.md#development).
2. **Run `/harness:init` inside Claude Code**, in the repo you want to protect. It scans the repo and asks you one question at a time. It recommends tools from a pinned catalog, each with a reason and its context cost. Nothing is written until you say yes. A terminal `npx @khubaibqaiser/harness init` doesn't install; it tells you to use `/harness:init`.
3. **Commit the files it lists.** Branch, commit, push and PR are each a separate question.
4. **Run `harness doctor`.** It checks the install and prints the fix for each problem.

**Teammates** need nothing for the hooks. For picked plugins, each runs `/harness:sync --install-plugins` once.

## What it changes in your repo

- `.harness/`: the hook dispatcher, `config.yaml` and a manifest of every change.
- `.claude/settings.json`: hook entries and deny rules. Hooks from other tools are kept.
- `AGENTS.md`: a short block that explains the rules. `CLAUDE.md` imports it.
- `.gitignore`, and your format and lint ignore files: entries for `.harness/`.
- Your Vitest config or Jest `test` script, when TDD is on, so tests write JSON results.

`init` backs up every file it touches. `uninstall` removes what harness added and restores the rest. Files you edited are kept and listed. The full list: [docs/reference.md](docs/reference.md#what-init-changes-in-your-repo).

## What you get

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
| PR size: warns as a branch passes 200 and 400 changed lines, suggests a split, and asks at PR time | yes | yes |

`/pr-ship` writes each PR body from a template for human reviewers (changes and why, alternatives, how to review and verify, screenshots, performance, security, human steps before merge, limits). Every agent `gh pr create` must use it, through `--body-file`: the pr-body check (`checks.prBody`) denies a missing or empty section, a body it can't read, human steps without the `needs-human` label, and `gh pr merge --auto` or `--admin`. To make GitHub itself refuse a merge without a person, turn on branch protection with required reviews.

The done contract is being built: it will make an agent's "done" a verdict harness computes from evidence against criteria a person approved. It is off by default and not usable yet. New configs carry `checks.done: false` and a `done:` section, `init` lists it under the gates that are off, and `harness status` lists `done` as off; turning it on changes nothing until its gates ship. The first commands are in: the agent drafts a task contract with `harness task draft`, and only you approve, edit or close one (`! harness task approve <file> --yes`; the guard denies the agent). Contracts live in `.harness/tasks/`, which is locked: the agent can read a contract but not write one, with any tool or in the sandbox. With `checks.done` on, the task gate denies the agent's first edit outside a `harness workdir` folder until you have approved a contract and it is the active task; an unattended run names its contract with `HARNESS_TASK=<id>`, and that contract must be on the base branch. The guard asks before commands that could repoint `refs/remotes/*` (which vouch for a merged contract), and denies them in unattended runs; protect denies direct writes to git's refs and config. Keys: [docs/reference.md](docs/reference.md#configuration-keys).

Secrets scanning comes as two catalog items, recommended together: `gitleaks-ci` adds a GitHub workflow that scans the full history with a checksum-pinned gitleaks 8.30.1, and `gitleaks-commit` scans each agent `git commit` first and blocks it on a finding (`checks.secretScan`). Harness installs nothing: the commit scan needs gitleaks on PATH (and git 2.40 or newer), and without it every agent commit is blocked until you install gitleaks or remove the item. Both scans use harness's own rules, so the repo's `.gitleaks.toml`, `gitleaks:allow` comments and `.gitattributes` can't hide a finding, and a `.gitleaksignore` (which gitleaks always reads) blocks agent commits and fails the CI job. Findings name the rule, file and line, never the value. Merges, rebases and other commands that bring in commits ask instead, and so does a commit in a repo with git hooks or git config that names a program git may run, such as `gpg.program` when the commit signs, `core.editor` when it opens the editor, or a non-lfs filter (git runs them after the scan; unattended, that is a deny). The commit check is a seatbelt against honest mistakes; `gitleaks-ci` is the backstop, and so will the done-contract CI verdict be once it ships. The full list of what is and isn't scanned is in [docs/reference.md](docs/reference.md#secrets-scanning-any-repo). `/harness:init` recommends `gitleaks-ci` for API and infra repos.

The hooks call no model. They decide from the tool call, your test results, coverage and `git diff`. If the hook dispatcher can't run, Claude Code blocks the call. The Stop gate is the one exception. The exact rules for each gate are in [docs/reference.md](docs/reference.md).

## Commands

Run them as `harness <command>`. From a source build, use `node /path/to/harness/dist/cli.mjs` instead. `init`, `update`, `add` and `sync` work only inside Claude Code, as `/harness:<command>`. Every command and flag is in [docs/reference.md](docs/reference.md#commands-in-full).

| Command | What it does |
|---|---|
| `init [--dry-run]` (`/harness:init`) | Scans, interviews, recommends, then installs after you confirm. |
| `update [--check\|--dry-run]` (`/harness:update`) | Re-renders the install for this version and shows the diff first. |
| `add <id>` / `remove <id>` | Adds or removes one catalog item. `add` is Claude Code only. |
| `sync` (`/harness:sync`) | Fixes drift between `config.yaml`, the manifest and the files. |
| `status` | Shows each gate as on or off, and why. |
| `doctor` | Checks the install and prints a fix for each problem. |
| `/harness:preset` | Builds your own named preset through an interview, checks it, then installs it for this repo or globally. Global writes each get their own yes. |
| `/harness:context-optimize` | Measures what loads into context, proposes trims, and applies harness's own after a yes. Your own files change only after you approve each diff. |
| `context [--json] [--offline]` | Shows what loads into context and what it costs against the budget. Writes nothing. |
| `context apply <n>[,<n>…]` | Applies harness's own recommendations, such as a skill by name only. `uninstall` undoes it. |
| `why <id>` / `explain` | Why an item is installed, and what every item loads into context. |
| `stats [--days N]` | Counts harness events (default: the last 7 days). |
| `report [--days N] [--open] [--export]` | Writes the usage and adherence report to `.harness/reports/`. Local only. |
| `rules [--apply]` | Shows today's violation count for each proposed ESLint rule and stricter TS option first. The rules are errors from day one, so `--apply` asks you to type `yes`. |
| `eval [--kind skills\|rules\|gates] [--runs N] [--max-cost-usd X]` | Paid checks that your skills and rules change what the agent does, and that the gates fire in a real session. Costs money and asks every run. |
| `remember add\|confirm\|retire\|sync\|list\|check` | Saves a team decision to `docs/decisions/` and loads it as a rule when its paths are touched. Asks first, commits nothing. |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. |
| `vet <target>` | Scans a plugin or skill before you install it. Needs `gh`. Installs nothing. |
| `/harness:review <pr>` | A code-only review of a PR that you read locally: gathered without running the PR's code, checked by a reviewer agent, verified, and checked by a small-model judge. Posting comes next. Needs the harness plugin and `gh`; run it from the base branch, in a fresh session. The steps are also CLI commands (`review <pr> --out`, `review --finish`, `review --keep`). |
| `guide <name>` / `workdir` | Helpers the skills call: print a bundled doc, and make a git-ignored work folder in `.harness/tmp/`, so no skill touches a file outside the repo. |
| `uninstall [--dry-run]` | Removes what harness added and restores your files. `--global` does the same for a preset installed under `~/.claude`. |

- **Rule: start Claude Code inside the repo for the report to see it.** Sessions started in a parent folder are not counted.
- The report quotes your sessions, so don't share it. It sends nothing anywhere.

## Team decisions

When the team agrees on a rule for some paths, ask Claude to remember it (`/harness:remember`) or run `harness remember add` yourself. It writes `docs/decisions/<id>.md` and a rule in `.claude/rules/` that Claude Code loads when those paths are touched. Each write asks you first, and nothing is committed: open a PR so the team reviews it. A decision expires after 90 days unless someone runs `harness remember confirm`, and `doctor`, `status` and the Stop gate say when one is stale or out of sync. `uninstall` keeps `docs/decisions/`. Details and limits: [docs/reference.md](docs/reference.md#team-decisions).

## What it costs

- **Context.** Always-loaded text has a budget of 2000 tokens by default (`context.budget_tokens`). `harness explain` shows what each item loads. The budget counts your repo's own `CLAUDE.md`, rules and skills too. `init`, `update`, `add` and `sync` ask before going past it. With `--yes`, they stop unless you also pass `--over-budget`. An unattended run over the budget is refused, even with `--over-budget`. `doctor` and `status` show the total and never call the API. Counts are estimates (characters ÷ 4). `harness context` uses Anthropic's token-counting API only when `ANTHROPIC_API_KEY` is set (never stored); that sends the measured text to Anthropic under your key's account. `--offline` skips it.
- **Money, for `harness eval`.** It tests skills, rules and gates in real sessions, so it costs money. It asks you to type `yes` every run. It stops at a cost ceiling (default $2, set with `--max-cost-usd`). It defaults to a Haiku model and runs only in your own terminal.
- **The hooks call no model.** They add no token cost of their own.

## Unattended runs and CI

A run is unattended when `CI` is `true` or `1`, `HARNESS_UNATTENDED` is `1` or `true`, `CLAUDE_CODE_REMOTE` is `true`, or the permission mode is `dontAsk` or `bypassPermissions`. Every question then becomes a deny. Shell commands are denied unless Claude Code's sandbox is on. Start the run like this:

```sh
HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{
  "enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false,
  "network":{"strictAllowlist":true,"allowedDomains":[]},
  "credentials":{
    "files":[{"path":"~/.ssh","mode":"deny"},{"path":"~/.aws","mode":"deny"},{"path":"~/.config/gcloud","mode":"deny"},
      {"path":"~/.azure","mode":"deny"},{"path":"~/.kube","mode":"deny"},{"path":"~/.docker/config.json","mode":"deny"},
      {"path":"~/.npmrc","mode":"deny"},{"path":"~/.pypirc","mode":"deny"},{"path":"~/.netrc","mode":"deny"},
      {"path":"~/.git-credentials","mode":"deny"},{"path":"~/.config/gh","mode":"deny"}],
    "envVars":[{"name":"NPM_TOKEN","mode":"deny"},{"name":"AWS_ACCESS_KEY_ID","mode":"deny"},
      {"name":"AWS_SECRET_ACCESS_KEY","mode":"deny"},{"name":"AWS_SESSION_TOKEN","mode":"deny"},
      {"name":"ANTHROPIC_API_KEY","mode":"deny"},{"name":"GITHUB_TOKEN","mode":"deny"},{"name":"GH_TOKEN","mode":"deny"}]}}}'
```

- **List the hosts your run needs** in `allowedDomains`, for example `"registry.npmjs.org"`. Every other host is refused, and the repo's own list doesn't count with these settings.
- **Credentials.** The shell can't read the listed files or see the listed variables, so `gh`, `aws`, `npm publish` and HTTPS `git push` can't sign in. For a run that must push, remove the `GH_TOKEN` and `GITHUB_TOKEN` entries (and `~/.config/gh` if `gh` keeps its token there), and add `github.com` and `api.github.com` to `allowedDomains`. That also gives data a way out.

Native Windows has no sandbox and keeps the text checks. More: [docs/reference.md](docs/reference.md#unattended-runs-and-ci).

## Limits worth knowing

- The guard is a speed bump for mistakes and prompt injection, not a security sandbox. Claude Code's permission rules and its sandbox are the real boundary.
- Hooks run with your permissions. Turn on branch protection: it is the real stop for force-pushes.
- TDD and coverage gates are for JS/TS only. Other repos get every other gate.
- Windows: unit tests run in CI, but live Claude Code use is untested.
- Plugin pins live in a marketplace named after its content, so the name changes with the pins; teammates run `/harness:sync --install-plugins` after a pin change. Don't hand-edit that entry: its name would stop matching its pins. Installs from before this share the name `harness-pins`, so another repo can replace their pins: run `/harness:update` (`harness doctor` flags it).
- The skills read and write only inside the repo, so `blockReadsOutsideWorkingDirectories` doesn't stop them. `/harness:vet`'s reviewer is the exception: it reads the fetched plugin from the OS temp folder.

The full list: [docs/reference.md](docs/reference.md#known-limits).

## More

[docs/reference.md](docs/reference.md) has the details:
- [configuration keys](docs/reference.md#configuration-keys), including Stop steps for non-JS repos;
- [named presets](docs/reference.md#named-presets), [vetting](docs/reference.md#vetting-a-plugin-or-skill) and the [usage and adherence report](docs/reference.md#usage-and-adherence-report);
- [tips for daily use](docs/reference.md#using-it-well), [troubleshooting](docs/reference.md#troubleshooting), [development](docs/reference.md#development) and the [roadmap](docs/reference.md#roadmap).

## Feedback and license

Open an issue in `KhubaibQaiser/harness`. Say what you ran and what happened, and paste the output of `harness doctor` and `harness status`.

Apache License 2.0. See [LICENSE](LICENSE).
