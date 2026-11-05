# @khubaibqaiser/harness

**Make Claude Code follow your rules, not just read them.**

A line in `CLAUDE.md` saying "write the test first" or "never read `.env`" is a suggestion, and a busy agent skips it. Harness turns those rules into hooks that run on every tool call. The agent can't edit before a failing test exists, can't read your secrets, and can't stop while lint or tests fail.

Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt.

In plain terms: with the sandbox on, the operating system enforces the guard. Without it, the guard is a best-effort text check that catches mistakes but can be bypassed.

**Status:** beta, version `0.2.0-beta.0`. It isn't on npm yet (npm still has the older `0.1.0-beta.0`), so build from source for now (see [Quick start](#quick-start)). Release notes: [docs/release-notes/0.2.0-beta.0.md](docs/release-notes/0.2.0-beta.0.md).

## Why harness

- **Rules that hold.** Hooks can deny a call, ask you, or keep the agent working until the checks pass. Messages say what happened and what to do next, so the agent fixes the problem instead of arguing with it.
- **No model in the loop.** The hooks decide from the tool call, your own test results, coverage and `git diff`. The same input always gets the same answer, and the checks call no model.
- **Fails closed.** If the hook dispatcher can't run, Claude Code blocks the tool call, the prompt or the settings change. The Stop gate is the one exception. If the config is broken, edits stop until a person fixes it.
- **The whole team gets it.** The hooks are committed to the repo. Anyone who opens it in Claude Code gets the same rules, with nothing to install.
- **Set up for your repo, not a template.** `/harness:init` scans the repo, asks about the product, and recommends tools from a pinned, license-checked catalog of 89 plugins, skills and MCP servers. Each one comes with a reason and its context cost.
- **Lean context.** Always-loaded text has a budget of 2000 tokens by default (`context.budget_tokens`). Harness asks before going over it.
- **Safe to try.** You see every change before it's written. `init` backs up what it touches. `uninstall` removes what harness added and restores the rest; files you edited are kept and listed.

## Who it's for

- Developers who run Claude Code on real code and want TDD, clean commits and passing checks every time, not only when they remember to ask.
- Teams that want one set of agent rules in the repo, the same for everyone.
- Anyone running agents unattended, in CI or overnight, where nobody is watching to say no.

## What you get

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

In short: secrets and risky commands are blocked, harness's own files are off limits to the agent, and a change that spreads to a second file needs your OK. A source edit needs a test that failed first, and the agent can't stop until your format, lint, typecheck and test commands pass.

- **Vet before you install.** `harness vet <github-url>` pins a plugin or skill to a commit and scans it without running it: hooks (also those declared in skill and agent frontmatter), secrets, network calls, prompt-injection text, licence and context cost. The report lists each finding by `file:line`, and names any file it could not read (binary, or over 1 MB). Needs the GitHub CLI (`gh`). `/harness:vet` is the guided flow: the reviewer reads the flagged files, and any high finding needs a second yes before you see the install command.
- **Review agent (experimental).** A `staff-reviewer` agent reviews a diff in a fresh context and can't edit files.

The exact rules for each gate are in [docs/reference.md](docs/reference.md).

## Quick start

You need Node 22.11 or newer, git, and Claude Code 2.1.314 or newer.

1. **Build the plugin from source** (pnpm comes with `corepack enable`):
   ```bash
   git clone https://github.com/KhubaibQaiser/harness.git
   cd harness && pnpm install && pnpm build
   ```
   Then start Claude Code in your project with the built plugin loaded: `claude --plugin-dir /path/to/harness`.
   After the first 0.2 release, install it as a plugin instead:
   ```bash
   claude plugin marketplace add KhubaibQaiser/harness
   claude plugin install harness@harness
   ```
2. **Run `/harness:init` inside Claude Code**, in the repo you want to protect. It scans, interviews you one question at a time, recommends items, and shows the full plan. Nothing is written until you say yes. A terminal `npx @khubaibqaiser/harness init` doesn't install; it tells you to use `/harness:init`.
3. **Commit the files it lists.** Branch, commit, push and PR are each a separate question.

**Teammates** need nothing for the hooks. For the plugins you picked, each person runs `/harness:sync --install-plugins` once, and `harness doctor` lists any that are missing.

## Using it well

- **Run `harness doctor` after any change.** It checks the install and prints the fix for each problem.
- **Turn on branch protection.** Hooks run with your permissions, so branch protection is the real stop for force-pushes.
- **When the Stop gate blocks, let it work.** Its output shows what failed. The agent fixes it and tries again, up to `stop.max_attempts` (default 3).
- **Let TDD work for you.** When the agent says "run a test first", that's the gate asking for a failing test. For a spike, run `harness tdd off` in your own terminal, then `harness tdd on` when you're done.
- **Vet anything new first.** Run `harness vet` before you install a plugin or skill you found online.
- **Watch the budget.** `harness explain` lists what each item loads into every session. Remove what you don't use with `harness remove <id>`. If an install would go over the budget, `--yes` stops unless you also pass `--over-budget`.
- **Unattended? Use the sandbox.** See [Unattended runs and CI](#unattended-runs-and-ci).

## Commands

Run them as `harness <command>`. From a source build there's no `harness` binary, so read `harness` in this README as `node /path/to/harness/dist/cli.mjs`. `init`, `update`, `add` and `sync` work only inside Claude Code, as `/harness:<command>`; `doctor`, `status`, `uninstall` and `vet` also have `/harness:` skills. Every flag is in [docs/reference.md](docs/reference.md#commands-in-full).

| Command | What it does |
|---|---|
| `init [--dry-run]` (`/harness:init`) | Scans, interviews, recommends, then installs after you confirm. |
| `update [--check\|--dry-run]` (`/harness:update`) | Re-renders the install for this version and shows the diff first. `--check` only looks for a newer version. |
| `add <id>` (`/harness:add`) | Adds one catalog item, with what it requires. Claude Code only. |
| `remove <id>` | Removes one item and restores your files. |
| `sync` (`/harness:sync`) | Fixes drift between `config.yaml`, the manifest and the files. |
| `status` | Shows each gate as on or off, and why. |
| `doctor` | Checks the install and prints a fix for each problem. |
| `why <id>` / `explain` | Why an item is installed, and what every item loads into context. |
| `stats [--days N]` | Counts harness events (default: the last 7 days). |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. |
| `vet <target>` | Scans a plugin or skill before you install it. Installs nothing. |
| `uninstall [--dry-run]` | Removes what harness added and restores your files. |
| `scan` / `catalog` | Prints what harness detects about your repo, or the catalog. Both write nothing. |
| `git branch\|commit\|push\|pr` | Commits and pushes the harness changes one step at a time. |

## Unattended runs and CI

A run is unattended when `CI` is `true` or `1`, `HARNESS_UNATTENDED` is `1` or `true`, `CLAUDE_CODE_REMOTE` is `true`, or the permission mode is `dontAsk` or `bypassPermissions`. Every question then becomes a deny, and shell commands are denied unless Claude Code's sandbox is on. Start the run like this:

```sh
HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'
```

Native Windows has no sandbox and keeps the text checks. More detail: [docs/reference.md](docs/reference.md#unattended-runs-and-ci).

## Configuration

Settings live in `.harness/config.yaml`. `init` writes values that fit your repo. A Stop step can be a script name or any command, so non-JS repos work too:

```yaml
stop:
  package_manager: none
  steps:
    - { name: lint, run: [ruff, check, .] }
    - { name: test, run: [pytest] }
```

Run `harness doctor` after editing. Every key and its default: [docs/reference.md](docs/reference.md#configuration-keys).

## Limits worth knowing

- TDD and coverage gates for JS/TS only. Other repos get every other gate.
- Harness's guard is a speed bump for mistakes and prompt injection, not a security sandbox. Claude Code's own permission rules and its sandbox are the real boundary.
- Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.
- Windows: unit tests run in CI, but live Claude Code use is untested.
- Cloud Claude Code sessions don't load repo-enabled plugins. The committed hooks still run there, but `/harness:*` skills don't.

The full list: [docs/reference.md](docs/reference.md#known-limits).

## Roadmap

Shipped in 0.2.0-beta.0: per-project recommendations from a pinned catalog. Coming next:
- a PR size check;
- an opt-in personal preset of working rules and stack skills;
- local reports that show whether agents actually follow the installed rules and skills;
- memory, the PR reviewer, and TDD for other languages.

## Development

```bash
pnpm install
pnpm build && pnpm test && pnpm test:perf
pnpm typecheck
node scripts/gen-config-docs.mjs --write   # after changing a config key
```

CI runs the tests on macOS and Windows with Node 22, plus Linux jobs for gitleaks, a pack check, real Vitest and Jest installs, and `claude plugin validate`. A `v*` tag publishes to npm after an approval step, then mirrors the package to GitHub Packages and creates a GitHub release. See [docs/release.md](docs/release.md).

## Feedback and license

Open an issue in `KhubaibQaiser/harness`. Say what you ran and what happened, and paste the output of `harness doctor` and `harness status`.

Apache License 2.0. See [LICENSE](LICENSE).
