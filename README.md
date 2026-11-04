# @khubaibqaiser/harness

Claude Code hooks that check what an agent does in your repo. Harness:
- blocks secret reads and risky shell commands, and protects its own files;
- asks before an agent spreads one change across many files;
- enforces red-first TDD for JS/TS;
- runs your format, lint, typecheck and test commands before the agent may stop.

The hooks are committed into the repo, so every teammate gets the same rules.

Enforced by Claude Code's sandbox in unattended runs on macOS, Linux and WSL2, and in every session with `sandbox: always`. Elsewhere, and on native Windows always, the guard and protect checks are a seatbelt.

**Status:** beta, version `0.2.0-beta.0`, on npm under the `beta` tag: `npm i -g @khubaibqaiser/harness@beta`. Release notes: [docs/release-notes/0.2.0-beta.0.md](docs/release-notes/0.2.0-beta.0.md).

## Why

Rules in `CLAUDE.md` or `AGENTS.md` are advice, and a busy agent can skip them. Harness turns them into hooks that Claude Code runs on every tool call. A hook can deny the call, ask you, or keep the agent from stopping, and its message names the next step.

- **Deterministic.** The hooks call no model. They decide from the tool call, your own test results, coverage and `git diff`.
- **Fails closed.** If the hook can't run, Claude Code blocks the call. If the config is invalid, edits are denied until a person fixes it.
- **Local and reversible.** It sends nothing anywhere. `init` backs up every file it changes, and `uninstall` restores them.
- **You confirm every write.** `init` and `update` show the plan and diff first. They never commit or push.
- **AI steps run only inside Claude Code.** `init` and `update` need Claude Code to read your repo and choose items. The hooks still call no model.

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

- **Guard.**
  - Denies reads of secrets such as `.env`, keys and credentials.
  - Denies force-push, pushing to `main`, `curl | sh` and package installs.
  - Asks before destructive commands.
  - Asks before the agent runs `harness init`, `update`, `add`, `remove`, `sync` or `uninstall`, and before it pushes or opens a pull request for harness changes. Previews such as `--dry-run` pass.
- **Protected paths.** The agent can't edit `.harness/`, `.claude/settings*.json` or `node_modules/`. Changes to harness's own files are reported at your next prompt.
- **Multi-file gate.** Asks once per turn before the agent edits a second source file.
- **TDD gates.**
  - An edit needs a related test that failed first in this session.
  - A failing test is locked until it passes.
  - Edits that weaken tests are denied.
- **Stop gate.**
  - Runs `stop.steps` before the agent may stop. With TDD on, it also checks coverage of the changed lines.
  - A failure blocks the stop and shows its output.
- **Review agent (experimental).** A `staff-reviewer` agent reviews a diff in a fresh context. It can't edit files.

Exact rules for each gate: [docs/reference.md](docs/reference.md).

## Requirements

- Node 22.11 or newer
- git, and a git repo to install into
- Claude Code 2.1.314 or newer. `doctor` fails below 2.1.314.

## Quick start

`init` and `update` run only inside Claude Code. In a plain terminal they print `Run /harness:init inside Claude Code` and exit.

Build from source. You need pnpm (`corepack enable` provides it).

```bash
git clone https://github.com/KhubaibQaiser/harness.git
cd harness && pnpm install && pnpm build
```

After the first release, use the plugin. Install it:

```bash
claude plugin marketplace add KhubaibQaiser/harness
claude plugin install harness@harness
```

Then run `/harness:init` inside Claude Code. The plugin also adds `/harness:doctor`, `/harness:status`, `/harness:update`, `/harness:add`, `/harness:sync` and `/harness:uninstall`. `npx @khubaibqaiser/harness init` in a terminal does not install; it tells you to use `/harness:init`.

Commit the files `init` lists, then keep working in Claude Code.

### Teammates

The hooks are in the repo, so a teammate needs nothing for them. Plugins you picked are pinned in `.claude/settings.json`, but each person installs them in their own Claude Code. After pulling, a teammate runs `claude plugin install <id> --scope project` for each, or `/harness:sync --install-plugins`. `harness doctor` lists the ones that are missing. Claude Code asks each user to approve MCP servers and, for the pinned marketplace, to trust the folder.

### `/harness:init` in Claude Code

The full flow runs only inside Claude Code, where Claude does the interview and the recommendations. The CLI stays deterministic: Claude passes it files, and it checks them.

1. **Scan.** It reads your repo and shows what it found.
2. **Interview.** Claude asks one question at a time: scope first, then gaps the scan can't answer. It drafts `product.md` for you to edit. It reads only files you point to, never dotenv files or `.harnessignore` paths, and credentials are names only.
3. **Recommend.** A fresh-context reviewer audits the repo against the catalog and proposes items and a report.
4. **Select.** You tick items, four per question, with the reason, context cost and side effects of each.
5. **Apply.** It shows the plan and the always-loaded context from harness. If that goes over the budget (2000 tokens by default), it asks once. Then you confirm separately: apply the changes, and, if you picked plugins, install them now.
6. **Git.** Each of branch, commit, push and PR is its own question. Nothing runs without a yes.

It writes the same files as `init`, plus `.harness/context/product.md` and `.harness/report.md`.

## Commands

Run each terminal command as `harness <command>`. From source, use `node /path/to/harness/dist/cli.mjs <command>`.

**Inside Claude Code only:**

| Command | What it does |
|---|---|
| `init [--yes\|--config <file>\|--dry-run]` | Detects your repo, picks catalog items, shows the plan, then writes after you confirm. Run it as `/harness:init`. |
| `update [--yes\|--check\|--dry-run\|--plan]` | Re-renders the installed files with this version and shows the diff first. Run it as `/harness:update`. `--check` only looks for a newer version and also works in a terminal. `--plan` writes nothing and prints JSON: whether to re-recommend (the catalog or your project facts changed), what changed in the catalog, and which answers to ask again. Items that left the catalog are removed, with a line saying why. With `--answers`, update takes a partial file and changes only the keys it holds (`project`, `apps`, `unattended`, `tdd`); the rest of `config.yaml` stays as it is. |
| `add <id> [--over-budget\|--dry-run\|--yes]` | Adds one catalog item, with what it requires. Run it as `/harness:add <id>`. Refuses when the item conflicts with an installed one. Shows the diff and the context budget first, and with `--yes` stops when it would go over budget unless you pass `--over-budget`. Ids you already approved don't count against the budget. |
| `sync [--dry-run\|--yes] [--take <file,...>] [--install-plugins] [--over-budget]` | Fixes drift between `config.yaml`, the manifest and the files. Run it as `/harness:sync`. Restores missing files of selected items, and removes the files and records of items you unselected. A file you edited that harness wrote whole is kept and listed unless you name it in `--take`. In AGENTS.md, settings and `.mcp.json`, your content is never touched: sync changes only harness's own parts and lists the file. A selected item that was never installed counts against the context budget like `add`. The preview lists plugins that `claude plugin list` doesn't show; `--install-plugins` installs them and records the install (also on `init` and `update`), but only when `settings.json` has no edits besides the plugin entries. Otherwise it prints "not recorded" and `uninstall` keeps your content. Commit or stash `config.yaml` edits first. The agent has to ask before running it. |

**In a plain terminal:**

| Command | What it does |
|---|---|
| `status` | Shows each gate as on or off, and why. Also the catalog version, how many items are selected, how many selected plugins aren't installed, and the always-loaded context estimate. |
| `doctor` | Checks the install and prints a fix for each problem. Exits 1 if there is one. For installs with items it also reports the catalog version, items whose files or settings entries are missing (`/harness:sync` restores them), selected plugins that are enabled but not installed, plugin versions that differ from the catalog's pin, a plugin enabled from two marketplaces, an edited `harness-pins` marketplace or MCP server, and `checks` in `config.yaml` that differ from the selected items. It runs `claude plugin list` once; without `claude` it skips the plugin checks. |
| `uninstall [--yes\|--force\|--dry-run]` | Removes what harness added and restores your files. Close open Claude Code sessions first. |
| `remove <id> [--dry-run\|--yes]` | Removes one installed item and what it wrote, and restores your files. Refuses while another installed item requires it. The agent has to ask before running it. |
| `why <id>` | For an installed item: why it is there, the findings it addresses, its cost and its context. For one that isn't installed: why it is in the catalog and its cost. |
| `explain` | One line per installed item with its files, then the always-loaded context. |
| `stats [--days N]` | Counts harness events (the default is the last 7 days). |
| `tdd off\|on\|status` | Pauses or resumes TDD for your next session. `off` works only in your own terminal. |
| `scan` | Prints the facts harness detects about your repo, as JSON. Writes nothing. |
| `catalog` | Prints the catalog of items harness can install, as JSON. |
| `catalog check [--resolve] [--only <id,...>]` | Checks the catalog for problems. `--resolve` also looks up each pin, which needs the network. `--only` limits that to the listed ids. |
| `validate answers\|product <file>` | Checks an interview answers file or a product file. |
| `validate picks <file> --answers <file> [--attempt 1\|2]` | Checks a picks file against the answers and the catalog. |
| `validate report <file> --picks <file> [--attempt 1\|2]` | Checks a report file against the picks. |
| `select --picks <file> [--choose <id,...>]` | Without `--choose`, prints the checklist of picked items. With it, prints the chosen ids, notices and the `items` entries. |
| `git branch\|commit\|push\|pr [--title <t>]` | Commits and pushes the harness changes one step at a time. `branch` creates `chore/ai-workflow-<catalog version>`; `commit` stages only the files harness wrote, with your own git name and email; `push` and `pr` never touch the default branch. `pr` needs `gh` signed in, else it prints the command. The agent asks you before `push` and `pr`. |

`scan`, `catalog`, `validate` and `select` write nothing. They are the steps `/harness:init` calls; you can run them to see what it sees.

Without a terminal, pass `--yes` or `--dry-run`.

`init` writes `.harness/` (the dispatcher, config and manifest) and merges hook entries and deny rules into `.claude/settings.json`. It also adds a short block to `AGENTS.md` (imported from `CLAUDE.md`), `.gitignore` lines, and the review agent. When TDD is on, it edits your test config so tests write JSON results. It then writes the items you chose, the plugin pins in `.claude/settings.json` and the servers in `.mcp.json`, described below. The full list is in [docs/reference.md](docs/reference.md#what-init-changes-in-your-repo).

### AI flags

Inside Claude Code, `/harness:init` and `/harness:update` take the files the interview produced. All five are required together:

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

## Unattended runs and CI

A run counts as unattended when any of these is true:
- `CI` or `HARNESS_UNATTENDED` is set;
- `CLAUDE_CODE_REMOTE` is `true`;
- the permission mode is `dontAsk` or `bypassPermissions`.

In an unattended run every question becomes a deny. Shell commands are also denied unless Claude Code's sandbox is on. Start the run like this:

```sh
HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'
```

To run without the sandbox, set `sandbox: off`. Native Windows has no sandbox and keeps the text checks.

Hooks run with your permissions, so turn on branch protection: it's the real stop for force-pushes. Sandbox, Windows, managed settings and allowing installs are covered in [docs/reference.md](docs/reference.md#unattended-runs-and-ci).

## Configuration

Settings live in `.harness/config.yaml`. `init` writes recommended values for your repo. After you edit the file, run `harness doctor`. An invalid file blocks agent edits until it's fixed.

A Stop step is a script name, or a `{ name, run }` command for any language:

```yaml
stop:
  package_manager: none
  steps:
    - { name: lint, run: [ruff, check, .] }
    - { name: test, run: [pytest] }
```

The table below is generated by `node scripts/gen-config-docs.mjs --write`.

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

Start with `harness doctor`, which prints a fix for each problem.

- **Every edit is denied.** `.harness/config.yaml` is invalid. `doctor` names the line.
- **"Run a test first", but the test exists.** Red-first needs a fresh failing run from this session. Run the test, see it fail, then edit.
- **A Stop step is skipped with a warning.** Its tool isn't on Claude Code's PATH, which can differ from your terminal's. Install the tool or edit `stop.steps`.
- **`doctor` says an item is missing a file.** Run `/harness:sync`; it restores the file or the settings entry.
- **`doctor` says a plugin is enabled but not installed.** Run the `claude plugin install <id> --scope project` line it prints, or `/harness:sync --install-plugins`.
- **Format or lint fails on `.harness/` files.** Add `.harness/` to that tool's ignore file.

More detail, including TDD setup: [docs/reference.md](docs/reference.md#tdd-setup-details).

## Known limits

- Windows: unit tests run in CI, but live Claude Code use is untested. The guard doesn't parse PowerShell syntax.
- The `PowerShell(...)` deny rules, and the `Read` and `Edit` rules on PowerShell commands, are unverified until a live check on Windows passes.
- The Stop gate fails open if its process can't run (`onFailure` has no effect on Stop).
- Native Windows has no sandbox: shell commands are checked by text only, and the guard doesn't parse PowerShell.
- Interactive sessions under the default `unattended` mode keep the text-check gaps (a `cd` before a write, shell reads of secrets, writes protect doesn't parse, and scripts that turn TDD off) unless the person turns the sandbox on before the session starts or uses `always`.
- A blocked settings change still sits on disk; the next session loads it. Change detection reports it at the next prompt and Stop.
- Force-push and push-to-main rules are text rules; branch protection is the real stop.
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
- Plugin install messages are matched by guessed wording until a live check on the real Claude Code output. If a plugin install fails oddly, run the printed command yourself.
- LSP plugin config in the `harness-pins` marketplace is unverified live. Claude Code may ignore it.
- The context count is an estimate (characters divided by 4). Plugins, external skills and MCP servers aren't measured before install, and committed picks load for every teammate but only the person installing is asked about the budget.
- Plugin picks are "local only" in Claude Code and are missing in cloud sessions.
- `extraKnownMarketplaces` (where the `harness-pins` marketplace lives) needs folder trust.
- MCP servers need each user's approval.
- `CLAUDECODE` is also set in IDE terminals, so `init` and `update` run there too, not only inside a Claude Code session. They don't print `Run /harness:init inside Claude Code`.
- There is no version-drift check for `git-subdir` plugins that have no `plugin_version`. The commit is pinned, but `doctor` has nothing to compare. The release notes list them.
- When the agent runs an item change (`init`, `update`, `add`, `remove`, `sync`, `uninstall`), harness asks you first.
- Under `sandbox: always`, item commands may need Claude Code's `!` prefix. Unverified, pending the live check.
- `.harnessignore` has no `!` negation.
- `remove tdd-gate` (or deselecting it) leaves the test-config edits `init` made in place; undo them by hand.
- `update` doesn't rename a package config and make another edit to it in one run. Run it twice.
- `harness git` treats `origin/HEAD`, `init.defaultBranch`, `main` and `master` as the default branch. If your default is another name and `origin/HEAD` isn't set, run `git remote set-head origin -a` first.
- Not in this release: the PR reviewer (M2) and TDD for other languages.

## Roadmap

Per-project recommendations from a pinned catalog shipped in 0.2.0-beta.0. These aren't shipped yet:
- a PR size check;
- memory;
- the PR reviewer;
- TDD for other languages.

## Development

```bash
pnpm install
pnpm build && pnpm test && pnpm test:perf
pnpm typecheck
node scripts/gen-config-docs.mjs --write   # after changing a config key
```

CI runs on macOS and Windows with Node 22, plus gitleaks, a pack check, real Vitest and Jest installs, and `claude plugin validate`.

## Feedback and license

Open an issue in `KhubaibQaiser/harness`. Say what you ran and what happened, and paste the output of `harness doctor` and `harness status`.

Apache License 2.0. See [LICENSE](LICENSE).
