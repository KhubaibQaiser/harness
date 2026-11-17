# @khubaibqaiser/harness

**Make Claude Code follow your rules, not just read them.**

A line in `CLAUDE.md` saying "write the test first" or "never read `.env`" is a suggestion, and a busy agent skips it. Harness turns those rules into hooks that run on every tool call. The agent can't edit before a failing test exists, can't read your secrets, and can't stop while lint or tests fail.

Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt.

**Status:** beta, version `0.2.0-beta.2`, on npm under the `beta` tag: `npm i -g @khubaibqaiser/harness@beta`. Release notes: [docs/release-notes/0.2.0-beta.2.md](docs/release-notes/0.2.0-beta.2.md).

## Who it's for

- Developers who run Claude Code on real code and want TDD, clean commits and passing checks every time.
- Teams that want one set of agent rules in the repo. The hooks are committed, so everyone gets the same rules.
- Anyone running agents unattended, in CI or overnight, where nobody is watching to say no.

## Quick start

You need Node 22.11 or newer, git, and Claude Code 2.1.295 or newer. The Stop gate runs your checks inside Anthropic's sandbox-runtime (`srt`), so on macOS and Linux also install ripgrep, and `srt` globally with npm, outside the repo: `npm i -g @anthropic-ai/sandbox-runtime@0.0.83`. Linux also needs bubblewrap 0.8 or newer and socat.

1. **Install the plugin:**
   ```bash
   claude plugin marketplace add KhubaibQaiser/harness
   claude plugin install harness@harness
   ```
   To build from source instead, see [docs/reference.md](docs/reference.md#development).
2. **Run `/harness:init` inside Claude Code**, in the repo you want to protect. It scans the repo, asks one question at a time, and recommends tools from a pinned catalog, each with a reason and its context cost. Nothing is written until you say yes. A terminal `npx @khubaibqaiser/harness init` doesn't install; it tells you to use `/harness:init`.
3. **Commit the files it lists.** Branch, commit, push and PR are each a separate question.
4. **Run `/harness:doctor`.** It checks the install and prints the fix for each problem.

**Teammates** need Node 22.11 or newer and Claude Code for the hooks, which are committed, and `srt` and ripgrep for the Stop gate. For picked plugins, each runs `/harness:sync --install-plugins` once.

## How it keeps you safe

- **Claude Code's sandbox is the first layer.** Init turns it on for every session on macOS, and on Linux and WSL2 when the machine can run it (`sandbox: always`). Harness lists its own files in the sandbox's `denyWrite`, so any Bash write to them fails, however it is spelled.
- **Harness's text checks are the second.** Guard and protect read every command and edit, including the Edit and Write tools the sandbox doesn't cover. On native Windows there is no sandbox, so they are the only layer: a seatbelt that catches mistakes and can be bypassed. See [Sandbox](docs/reference.md#sandbox).
- **A machine that can't run the sandbox runs no Bash**, because the strict settings are committed for everyone. That means native Windows, WSL1, Linux and WSL2 without `bwrap` and `socat`, and Ubuntu with its AppArmor user-namespace restriction on. `harness doctor` prints the fix. Or set `sandbox.failIfUnavailable: false` in your own `.claude/settings.local.json`, so Bash there runs guarded only by the text checks.
- **Stop steps run inside `srt`**, with no network, and writes are limited to the repo and temp folders. Until `srt` is installed, Stop blocks and says what to do. `sandbox: off` in `.harness/config.yaml` runs the steps unsandboxed instead (logged). On native Windows the steps run unwrapped, and an unattended Stop there blocks. See [Stop gate](docs/reference.md#stop-gate-any-repo).
- **The hooks call no model.** They decide from the tool call, your test results, coverage and `git diff`. If the hook dispatcher can't run, Claude Code blocks the call; the Stop gate is the one exception.

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

- **PR descriptions.** `/pr-ship` writes each PR body from a template for human reviewers. Every agent `gh pr create` must use it (`checks.prBody`). Steps a person must do need the `needs-human` label, and `gh pr merge --auto` and `--admin` are denied. Branch protection with required reviews is what makes GitHub refuse a merge without a person.
- **Secrets scanning.** Two catalog items, recommended for API and infra repos: `gitleaks-ci` scans the full history in CI, and `gitleaks-commit` blocks an agent `git commit` on a finding. The commit check needs gitleaks on PATH, and without it every agent commit is blocked. Details: [secrets scanning](docs/reference.md#secrets-scanning-any-repo).
- **Done contract (preview, off by default).** It turns an agent's "done" into a verdict harness computes from evidence, against criteria you approved. How it works and how to turn it on: [done contract](docs/reference.md#done-contract-preview).

## Commands

Inside Claude Code, the `/harness:<command>` skills run them for you; `init`, `update`, `add` and `sync` work only there. In a terminal, install the CLI with `npm i -g @khubaibqaiser/harness@beta` and run `harness <command>`. Every command and flag is in [docs/reference.md](docs/reference.md#commands-in-full).

| Command | What it does |
|---|---|
| `init [--dry-run]` (`/harness:init`) | Scans, interviews, recommends, then installs after you confirm. |
| `update [--check\|--dry-run]` (`/harness:update`) | Re-renders the install for this version and shows the diff first. |
| `add <id>` / `remove <id>` | Adds or removes one catalog item. `add` is Claude Code only. |
| `sync` (`/harness:sync`) | Fixes drift between `config.yaml`, the manifest and the files. |
| `status` | Shows each gate as on or off, and why. |
| `doctor` | Checks the install and prints a fix for each problem. |
| `context [--json] [--offline]` | What loads into context and its cost against the budget. `context apply <n>` applies harness's own trims; `/harness:context-optimize` proposes and applies them. |
| `why <id>` / `explain` | Why an item is installed, and what every item loads into context. |
| `stats [--days N]` | Counts harness events (default: the last 7 days). |
| `report [--days N] [--open] [--export]` | Writes the usage and adherence report to `.harness/reports/`. Local only. |
| `rules [--apply]` | Proposes ESLint rules and stricter TS options, with today's violation count for each. `--apply` asks you to type `yes`. |
| `eval [--kind skills\|rules\|gates] [--runs N] [--max-cost-usd X]` | Paid checks that your skills, rules and gates change what the agent does in a real session. Costs money and asks every run. |
| `remember add\|confirm\|retire\|sync\|list\|check` | Saves a team rule for some paths to `docs/decisions/` and loads it when those paths are touched. Asks first, commits nothing; expires after 90 days unless confirmed. Also `/harness:remember`. [Details](docs/reference.md#team-decisions). |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. |
| `vet <target>` | Scans a plugin or skill before you install it. Needs `gh`. Installs nothing. |
| `/harness:review <pr>` | A code-only PR review you read locally. Needs `gh`; run it from the base branch, in a fresh session. |
| `/harness:preset` | Builds your own named preset through an interview, then installs it for this repo or globally. |
| `uninstall [--dry-run]` | Removes what harness added and restores your files. `--global` does the same for a global preset. |

**Rule: start Claude Code inside the repo for the report to see it.** Sessions started in a parent folder are not counted. The report quotes your sessions, so don't share it; it sends nothing anywhere.

## What it costs

- **Context.** Always-loaded text, your repo's own `CLAUDE.md`, rules and skills included, has a budget of 2000 tokens by default (`context.budget_tokens`). `init`, `update`, `add` and `sync` ask before going past it; with `--yes` they stop unless you also pass `--over-budget`, and an unattended run over it is refused. Counts are estimates (characters ÷ 4). Only `harness context`, and only when `ANTHROPIC_API_KEY` is set, sends the measured text to Anthropic's token-counting API; `--offline` skips it.
- **Money, for `harness eval` only.** It runs real sessions, so it costs money. It asks you to type `yes` every run, stops at a cost ceiling (default $2, `--max-cost-usd`), defaults to a Haiku model and runs only in your own terminal. The hooks call no model.

## Unattended runs and CI

A run is unattended when `CI` is `true` or `1`, `HARNESS_UNATTENDED` is `1` or `true`, `CLAUDE_CODE_REMOTE` is `true`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set to anything but empty, `0`, `false`, `no` or `off` (SessionStart says so when it is the only cause), or the permission mode is `dontAsk` or `bypassPermissions`. Every question then becomes a deny. Shell commands are denied unless Claude Code's sandbox is on. Start the run like this:

```sh
HARNESS_SANDBOX=1 HARNESS_UNATTENDED=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 claude -p "…" --allowedTools "Bash,Edit,Write" --settings '{"sandbox":{
  "enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false,
  "network":{"strictAllowlist":true,"allowedDomains":[]},
  "credentials":{
    "files":[{"path":"~/.ssh","mode":"deny"},{"path":"~/.aws","mode":"deny"},{"path":"~/.config/gcloud","mode":"deny"},
      {"path":"~/.azure","mode":"deny"},{"path":"~/.kube","mode":"deny"},{"path":"~/.docker/config.json","mode":"deny"},
      {"path":"~/.npmrc","mode":"deny"},{"path":"~/.pypirc","mode":"deny"},{"path":"~/.netrc","mode":"deny"},
      {"path":"~/.git-credentials","mode":"deny"},{"path":"~/.config/git/credentials","mode":"deny"},{"path":"~/.config/gh","mode":"deny"},
      {"path":"~/.claude/.credentials.json","mode":"deny"}],
    "envVars":[{"name":"NPM_TOKEN","mode":"deny"},{"name":"AWS_ACCESS_KEY_ID","mode":"deny"},
      {"name":"AWS_SECRET_ACCESS_KEY","mode":"deny"},{"name":"AWS_SESSION_TOKEN","mode":"deny"},
      {"name":"ANTHROPIC_API_KEY","mode":"deny"},{"name":"ANTHROPIC_AUTH_TOKEN","mode":"deny"},{"name":"CLAUDE_CODE_OAUTH_TOKEN","mode":"deny"},
      {"name":"GITHUB_TOKEN","mode":"deny"},{"name":"GH_TOKEN","mode":"deny"},{"name":"GH_ENTERPRISE_TOKEN","mode":"deny"},
      {"name":"GITHUB_ENTERPRISE_TOKEN","mode":"deny"}]}}}'
```

- **Allowed tools.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the permission mode to `default`, so `bypassPermissions` is ignored, and `-p` refuses any tool that needs approval. `--allowedTools` lets the run use Bash, Edit and Write (reads need no approval); add the tools your run needs, such as `WebFetch` or an MCP tool. `HARNESS_UNATTENDED=1` keeps harness treating the run as unattended outside CI.
- **Hosts and credentials.** List the hosts your run needs in `allowedDomains`, for example `"registry.npmjs.org"`; the repo's list doesn't count with these settings. The shell can't read the listed files or see the listed variables, so `gh`, `aws`, `npm publish` and HTTPS `git push` can't sign in. For a run that must push, remove the `GH_TOKEN` and `GITHUB_TOKEN` entries (and `~/.config/gh`), and add `github.com` and `api.github.com` to `allowedDomains`. That also gives data a way out.
- **`CLAUDE_CONFIG_DIR`.** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credential-looking variables from Bash, the hooks and the Stop gate's test commands, and `CLAUDE_CONFIG_DIR` too. If you use it, add `HARNESS_CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR"` to the same launch.

Native Windows has no sandbox and keeps the text checks. More: [docs/reference.md](docs/reference.md#unattended-runs-and-ci).

## Limits worth knowing

- The guard is a speed bump for mistakes and prompt injection, not a security sandbox. Claude Code's permission rules and its sandbox are the real boundary.
- Hooks run with your permissions. Turn on branch protection: it is the real stop for force-pushes.
- TDD and coverage gates are for JS/TS only. On Windows, unit tests run in CI, but live Claude Code use is untested.
- Mid-session, a settings change that weakens harness is held for the session, and harness tells you at your next prompt. Other settings changes apply at once.
- After a plugin pin change, teammates run `/harness:sync --install-plugins`.

The full list: [docs/reference.md](docs/reference.md#known-limits).

## More

[docs/reference.md](docs/reference.md) has the details: [configuration keys](docs/reference.md#configuration-keys) (including Stop steps for non-JS repos), [named presets](docs/reference.md#named-presets), [vetting](docs/reference.md#vetting-a-plugin-or-skill), the [usage and adherence report](docs/reference.md#usage-and-adherence-report), [tips for daily use](docs/reference.md#using-it-well), [troubleshooting](docs/reference.md#troubleshooting), [development](docs/reference.md#development) and the [roadmap](docs/reference.md#roadmap).

## Feedback and license

Open an issue in `KhubaibQaiser/harness`. Say what you ran and what happened, and paste the output of `harness doctor` and `harness status`.

Apache License 2.0. See [LICENSE](LICENSE).