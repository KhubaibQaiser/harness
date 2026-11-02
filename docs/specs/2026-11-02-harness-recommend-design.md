# Harness: per-project recommend (M3 installer) design

Status: owner-approved design, 2026-11-02. Amends `docs/specs/2026-11-01-harness-beta-design.md` (which listed the interview, catalog, recommend, `sync`/`add`/`remove`/`why` and committing during init as out of the beta) and builds on `docs/specs/2026-10-30-harness-design.md` §§7, 8, 9a. Where this spec and the 2026-10-30 spec differ, this one wins.

**Amendment, 2026-11-02 (owner answers to the planning questions in `docs/plans/2026-11-02-recommend.md`):**
- Plugins are pinned to a commit through one inline `settings` marketplace, `harness-pins` (plan Q2). `init` and `sync` run `claude plugin install <id> --scope project` for the person running them, and `doctor` prints that command for teammates (plan Q1).
- §5 "full seed list": this release ships only the own items that exist today. The 22 unbuilt own items, and the 6 `discouraged` items that have no reason yet, are left out and listed in the release notes until the owner writes their reasons (plan Q3, Q5).
- Hosted MCP servers may use `license: vendor-terms` with an `unpinned` reason (plan Q4). `CLAUDECODE` set in IDE terminals is a known limit (plan Q6).
- Plan decisions recorded here so they don't read as drift: the compact catalog in §4.3 also carries `kind`, `stance_reason`, `conflicts_with` and `requires`, and `.harness/facts.json` is written at apply rather than at scan, so a cancelled `init` leaves no file (§4.1).

## 1. Goal

Make `/harness:init` set up a workflow that fits each project, not only gates. It interviews the user, writes a product summary, recommends items from a closed catalog with reasons, lets the user pick, installs the picks into the repo so teammates get them, writes an audit report with a roadmap, and offers to commit, push and open a PR.

## 2. Owner decisions (2026-11-02)

| # | Question | Decision | Options not taken |
|---|---|---|---|
| Q1 | Catalog size | **Full seed catalog** from 2026-10-30 §7.3 (~120 items), each verified, pinned and license-checked | Curated core of 25–35; own items only |
| Q2 | Where picks are recorded | **Committed to the repo**: `.claude/settings.json` (`enabledPlugins`, `extraKnownMarketplaces`) and `.mcp.json`, so every clone on every machine gets the same list | User-scope `claude plugin install`; copying skills into `.claude/skills/` |
| Q3 | Interview depth | **Full interview** from 2026-10-30 §8.2 | Scope plus gaps only; no interview |
| Q4 | Install method | **Plugin references for everything** (see §6, recorded for revisiting) | Copy where possible; copy everything |
| Q5 | Command scope | **Everything from M3**: init with report, `update` re-recommend, `add`, `remove`, `why`, `explain`, `sync`, and the git step | Picks plus report; picks only |
| Q6 | Where the AI steps run | **Only inside Claude Code.** No plain-terminal path for AI steps | AI parts only via skill but terminal init kept; terminal init calls `claude -p`; both |
| Q7 | Which commands refuse outside Claude Code | **Only the AI ones**: `init`, `update`, `add`, `sync` | Everything except tdd/uninstall/doctor; everything |

Platform: Claude Code only for now. Cursor and OpenCode support are on the roadmap (§12).

## 3. Scope

In: catalog and its CI checks; scan extension; interview; `product.md`; recommend; `report.md`; select; apply for plugin, MCP and own items; git step; `update`, `add`, `remove`, `why`, `explain`, `sync`; the Claude-Code-only refusal; tests and live runs below.

Out: the PR reviewer (M2, still deferred); copying plugin contents into the repo (Q4); TDD for languages other than JS/TS; Cursor/OpenCode adapters.

Prerequisite: the beta fix wave on `feature/beta` (Jest results folder, Vitest coverage provider, missing stop tools, test files not counted, reason lookup, CRLF hashes, unsafe test config) is complete, reviewed and green in CI before this work starts.

## 4. Flow of `/harness:init`

Runs inside Claude Code only (§8). The CLI never calls a model; the `harness-init` skill does the AI steps and hands results to the CLI for validation.

1. **scan** (CLI, deterministic). Extends the beta's `detect` to the facts in 2026-10-30 §8.1: package manager, workspaces and apps (web, mobile, api), frameworks, router types, test runners, CI files, Docker, IaC markers, DB clients, auth SDKs, Expo markers, deploy markers, existing `AGENTS.md`/`CLAUDE.md`/`.claude/`, lefthook or husky. Writes `.harness/facts.json`. Reads file names and an allowlist of config files only; never `.env*`, never `.harnessignore` paths.
2. **interview** (skill, native question prompts, one question at a time with options). As 2026-10-30 §8.2:
   - First question: project scope. The user points to files (README, PRD, spec) or writes a short scope. The skill reads only the pointed files, writes `.harness/context/product.md` (at most 40 lines: purpose, users, core features, constraints, non-goals, source paths), and shows it for the user to edit and approve. Files outside the repo are summarised, not linked; copying them into `docs/` is offered only with consent.
   - Then gaps only: product type and domain, compliance and data handling, team size, open-source plans, CODEOWNERS owners, deploy target, run budget; per app: run recipe (install, start, ready URL, port), public-facing, login needed and where test credentials live (names only), login URL and post-login URL or selector; unattended settings; TDD paths and diff-coverage threshold.
   - The CLI validates answers and saves them to `config.yaml`.
3. **recommend** (skill runs the `staff-reviewer` subagent with `review-rubric`). Input: facts, answers, `product.md`, compact catalog (`id`, `applies_when`, `why`, `cost`, `stance`). Output: `picks.json` (per item `include: recommended | optional`, `reason`, `addresses: [finding ids]`) and `.harness/report.md` (findings by severity, 30/60/90-day roadmap, deliberate exclusions, the reviewer's stated limits, and the statement that only CI and branch protection enforce rules for everyone). The CLI validates: unknown ids, conflicting picks, missing reasons, and discouraged items without the user naming them all fail. One retry, then stop with raw output in `.harness/debug/`.
4. **select** (native checklist). Recommended items pre-ticked, optional unticked; each shows reason, cost, side effects and a "local only" label for plugins (§6). `requires` auto-selects with a notice; `conflicts_with` blocks both. Saved to `config.yaml`.
5. **apply** (CLI). Diff shown, user confirms, then the beta's transaction (backup, temp-and-rename, rollback, manifest written last in the same transaction). Plugin picks go to `.claude/settings.json`; MCP picks to `.mcp.json`; own items to `.claude/` as today. Every write is recorded as a reversible block.
6. **git** (CLI, each step confirmed). Clean tree required. Branch `chore/ai-workflow-<catalog-version>`, commit as the user's git identity with a conventional message and no AI trailer unless the repo's config asks. Then separately: push? open a PR with `report.md` as the body? Never pushes to the default branch.

## 5. Catalog

- Lives in `catalog/` in this repo, one YAML file per item, in the 2026-10-30 §7.1 format (`id`, `kind`, `title`, `source` with a 40-char `sha`, `license`, `min_claude_code`, `applies_when`, `conflicts_with`, `requires`, `cost`, `stance`, `stance_reason`, `side_effects`, `why`, `evidence`).
- Contents: the full seed list in 2026-10-30 §7.3, own and referenced items, with the stances and conflicts given there.
- Changes only through a new release; `catalog_version` is recorded in `config.yaml`.
- CI checks on every change and weekly: schema valid; `requires`/`conflicts_with` targets exist; own items have templates; outside items have a `sha` (or `unpinned` with a reason) and a `license`; no duplicate ids; `min_claude_code` present; every pinned `sha` still resolves.
- An item that cannot be verified (source gone, no license, cannot be pinned) is left out of the release and listed in the release notes, not shipped unverified.

## 6. Decision record: install method (Q4)

**Chosen:** plugin references for every outside plugin item. The harness writes the plugin id to `enabledPlugins` and its marketplace to `extraKnownMarketplaces` in the committed `.claude/settings.json`. MCP items go to `.mcp.json`. Own items are files in `.claude/`.

**Why:** simplest to build; plugin authors own their updates; one mechanism for all plugin items.

**Facts behind the choice (Claude Code docs, checked 2026-11-02):**
- Committed `.claude/settings.json` reaches everyone who clones the repo. `extraKnownMarketplaces` applies only after each person trusts the folder; until then they don't get plugins from it.
- Cloud sessions (claude.ai/code, cloud environments) do **not** install plugins declared in the repo's `enabledPlugins`/`extraKnownMarketplaces`. They do load the repo's `CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, hooks in `.claude/settings.json`, and `.mcp.json` (single-repository sessions). So the harness gates and own items work in the cloud; plugin picks don't.
- Local unattended runs (`claude -p`, CI on your own runner) load plugins normally.
- Whether a repo can pin a plugin to an exact version or commit is not confirmed. Verify during planning; if it can't, teammates may run different versions.

**Accepted costs:** plugin picks are missing in cloud sessions; versions can drift between teammates. Mitigations: the select checklist labels plugin items "local only"; `doctor` reports when an installed plugin's version differs from the catalog pin.

**Options not taken:**
- *Copy where possible:* copy items that are only skills, agents, commands, MCP servers or hooks into the repo (pinned to the catalog sha) so they work everywhere including cloud, and keep plugin references only for items that need real plugin features. Costs: the catalog records each item's parts; copying needs a license that allows it; `update` refreshes copies.
- *Copy everything:* copy all items, drop the ones that can't be copied. Works everywhere; loses some items.
- *Cloud setup script* running `claude plugin install`: undocumented; untested.

**Revisit when:** test users run cloud sessions and miss plugin items, or report version drift between teammates.

## 7. Commands

| Command | Change from the beta |
|---|---|
| `init` | Full flow in §4. Refuses outside Claude Code |
| `update` | Re-scans and re-recommends when the catalog version or facts change; shows new / changed / retired / now-conflicting items; applies approved changes. Re-asks interview questions only when facts contradict stored answers. Refuses outside Claude Code |
| `add <item>` / `remove <item>` | Change one item: checks `requires` and `conflicts_with`, shows the diff, updates the manifest, offers a commit. `add` refuses outside Claude Code; `remove` does not |
| `why <item>` | Prints the stored reason, the findings it addresses, and its cost |
| `explain` | Prints what is installed and why, from `config.yaml` and the manifest |
| `sync` | Finds and fixes drift between `config.yaml`, the manifest and the files. Refuses outside Claude Code |
| `doctor`, `status`, `tdd`, `stats`, `uninstall` | As in the beta, plus catalog version, item drift and plugin version drift |

## 8. Claude Code only

- The CLI treats `CLAUDECODE=1` in its environment as "inside Claude Code". The `/harness:*` skills call the CLI through Claude Code's Bash tool, which sets it.
- `init`, `update`, `add` and `sync` without it exit 2 with: "Run /harness:init inside Claude Code. The harness supports Claude Code only for now." (each command names its own slash command).
- `tdd`, `doctor`, `status`, `stats`, `uninstall`, `remove`, `why` and `explain` keep working in a plain terminal. `harness tdd off` must stay terminal-only for humans: the guard blocks the agent from running it.
- The beta's non-AI install path stays for tests only, behind an undocumented environment variable that the e2e tests and CI set. It is not in the README.
- The AI steps sit behind one adapter (interview, recommend) so Cursor and OpenCode can be added without changing the CLI.

## 9. Safety

- The interview never reads `.env*`, `.harnessignore` paths, or files the user didn't point to. Credentials are stored as names only.
- All AI output is data, validated by the CLI; catalog text and repo files the subagent reads are data, not instructions.
- Outside items need a pin and a license. `discouraged` items are proposed only when asked by name or when no alternative fits, always with the reason. Side effects (e.g. installs-hook, downloads-binary, telemetry-on-by-default) show in the checklist.
- git: every outward step confirmed separately; never the default branch; commits as the user.

## 10. Testing

- Unit: catalog schema and CI checks; answer and picks validators; select (`requires`, `conflicts_with`, discouraged); apply and reversal for plugin, MCP and own items; `add`/`remove`/`sync`/`why`/`explain`; the Claude-Code-only refusal and its allowed commands.
- End-to-end with a fake AI step: fixed answers and `picks.json` through select, apply, `update`, `remove`, `uninstall`; the repo ends byte-identical.
- Catalog CI: every pin resolves, weekly.
- Live, on local dummy repos only, nothing pushed, owner approval before each batch: real `/harness:init` in Claude Code on a JS repo, a Python repo and a copy of fitness-app. The owner judges whether the report and picks are right.

## 11. Order of work

1. The beta fix wave finishes and the beta passes CI and its live re-run.
2. Plan from this spec, then build: catalog and its CI, scan extension, interview and `product.md`, recommend and `report.md`, select, apply for each kind, git step, then the commands.
3. Live runs, final review, release.

## 12. Roadmap after this

- Cursor and OpenCode support through the AI-step adapter (§8).
- The PR reviewer (M2).
- Revisit the install method (§6).
- TDD for Python and other languages.
