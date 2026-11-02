# Harness M3 per-project recommend implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/harness:init` interviews the user, writes `product.md`, recommends items from a closed, pinned and license-checked catalog, lets the user pick, installs the picks into the repo (plugins in `.claude/settings.json`, MCP servers in `.mcp.json`, own items in `.claude/`), writes `report.md`, and offers commit, push and PR. It adds `update` re-recommend, `add`, `remove`, `why`, `explain` and `sync`.

**Architecture:**
- The CLI stays deterministic and never calls a model. The AI steps (interview, recommend) run in the `/harness:*` skills, and they reach the CLI only through a file contract: `answers.json`, `product.md`, `picks.json` and `report.md`, each checked by a `harness validate <kind>` command. That contract is the adapter from spec §8: a Cursor or OpenCode skill writes the same files.
- The catalog is YAML in `catalog/`, shipped in the npm package and loaded at run time like `templates/`. Outside plugins are referenced through one inline `settings` marketplace, `harness-pins`, whose entries carry the catalog's 40-character `sha` (see Owner question 2).
- Every write still goes through `applyChanges` (backup, temp-and-rename, rollback, manifest last). Plugin, marketplace and MCP entries are structural manifest blocks, removed by deep equality, the way hook groups are removed today.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml` and `picomatch` (bundled dev dependencies, already present). No new dependency. `gh` and `npm` CLIs only in catalog CI and the research tasks.

**Spec:** `docs/specs/2026-11-02-harness-recommend-design.md` (wins on conflict). It builds on `docs/specs/2026-10-30-harness-design.md` §§7, 8, 9a and amends `docs/specs/2026-11-01-harness-beta-design.md`. Read all three.

## Owner questions

**Answered 2026-11-02: the owner took every recommendation.** Q1 (a), Q2 (a), Q3 (a), Q4 (a), Q6 keep the rule and list it in the README. Q5: the owner writes the six `stance_reason` lines. Until then those six items stay out like unverifiable items.

Q3 is needed before Task 3, Q4 before Tasks 4 to 8, Q5 before Tasks 5, 6 and 8, and Q1, Q2 and Q6 before Task 13. Tasks 1, 2 and 9 to 12 don't depend on any of them.

**Q1. Who installs the plugins on each machine?** The spec (§6) expects committed `enabledPlugins` and `extraKnownMarketplaces` to reach everyone who clones. The docs say they don't install plugins by themselves: "When a plugin's only `true` is in the project's `.claude/settings.json`, Claude Code doesn't fetch it onto a machine where it isn't installed", and each contributor sees `Plugin "<name>" is enabled in project settings but isn't installed here` until they run `claude plugin install <name>@<marketplace> --scope project` (https://code.claude.com/docs/en/plugins/loading.md, "Enabled in project settings but not installed"; https://code.claude.com/docs/en/plugins/org.md, "Require plugins per repository"). The spec's `sync` (§7) only fixes drift, and Q7 makes `sync` refuse outside Claude Code.
- (a) `init` and `sync` run `claude plugin install <id> --scope project --json` for each plugin pick, after one confirmation, for the person running them. `doctor` and `status` (plain terminal) list missing plugins with the exact command a teammate pastes. `report.md` and the git step's PR body say teammates run `/harness:sync` once, or paste the commands.
- (b) Same as (a), but `sync` is also allowed in a plain terminal, because installing plugins is not an AI step. This changes owner decision Q7.
- (c) Nothing runs installs. `doctor`, `status` and `report.md` print the commands.
- **Recommendation: (a).** It keeps Q7 as decided, makes `init` work at once for the person who ran it (as 2026-10-30 §5 intended), and gives teammates without the `/harness` plugin a copy-paste path. The plan below is written for (a): Tasks 15 and 20 carry the install step.

**Q2. Pin plugins to a commit through an inline marketplace?** The spec (§6) says pinning "is not confirmed; verify during planning", and it accepts version drift. The docs confirm a repo *can* pin: an `extraKnownMarketplaces` entry may use a `settings` source with an inline `plugins` array, and each plugin's `github`, `url` or `git-subdir` source accepts a "full 40-character lowercase commit SHA" (https://code.claude.com/docs/en/plugins/marketplace-reference.md, "Plugin sources" and "Marketplace sources"). Marketplace sources themselves accept only `ref` (a branch or tag), never `sha`. Pinning has costs:
- Plugin ids become `<name>@harness-pins`, not `<name>@<upstream marketplace>`. A teammate who already has the same plugin from the official marketplace gets two copies. The docs say only one copy's hooks run when two enabled plugins share a manifest name (loading.md, "Hooks when two enabled plugins share a name").
- Plugins listed by relative path in their own marketplace (most of `claude-plugins-official`) are referenced through `git-subdir` with the marketplace repo and the plugin's path.
- Upstream fixes arrive only through a new harness catalog release.
- Options: (a) pin every plugin item through `harness-pins` (the 2026-10-30 §6 design); (b) reference each upstream marketplace by `github` source with no pin, and accept drift, as the 2026-11-02 spec's fallback says.
- **Recommendation: (a).** The catalog already requires a `sha` per item, and the CI pin check (spec §5) then matches what users install. `doctor` warns when a duplicate copy from another marketplace is enabled (Task 21). The plan is written for (a).

**Q3. Own items in the seed list that don't exist yet.** Spec §5 asks for "the full seed list" of 2026-10-30 §7.3, and its CI check says "own items have templates". 22 own items there have no implementation: `post-edit-format`, `gitleaks-commit`, `config-change-guard`, `session-context`, `pr-create-trigger`, `researcher`, `ui-verifier`, `harness-review`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `pr-ship`, `session-structure`, `sandbox-settings`, `ci-tdd`, `harness-integrity`, `lefthook-baseline`, `claude-code-action`, `harness-devdep`. `harness-review`, `pr-create-trigger` and `ui-verifier` belong to the PR reviewer, which the spec puts out of scope (M2).
- (a) This release ships the own items that exist today (Task 3 table), and the other 22 are listed in the release notes as "not in this release", under the same rule as outside items that can't be verified.
- (b) Build all 22 in M3. Each needs its own design: what the hook checks, what the skill says, what the workflow runs. That is a larger spec than this one.
- **Recommendation: (a).** Building 22 unspecified items would mean inventing their behaviour. The plan is written for (a).

**Q4. License for hosted MCP servers.** Spec §5 needs a `license` on every outside item, and leaves out items without one. Hosted (remote `http`) MCP servers, which some vendor items in §7.3 may turn out to be (Tasks 4 to 8 find out which), have service terms, not an SPDX license, and nothing to pin (their URL serves whatever version the vendor runs).
- (a) Allow `license: vendor-terms` with the terms URL in `evidence`, and `unpinned: hosted service, the vendor controls the version`. The checklist shows both.
- (b) Leave out every hosted MCP server.
- **Recommendation: (a).** The spec already allows `unpinned` with a reason. (b) would drop every hosted server, and the research tasks will show how many that is. The plan is written for (a).

**Q5. Missing `stance_reason` text.** §7.3 marks six items `discouraged` without a reason: `feature-dev`, `pr-review-toolkit`, `sourcegraph`, `sonarqube`, `jfrog`, `sonatype-guide`. The schema requires a reason for `discouraged`, and the checklist shows it. **Recommendation:** the owner writes one line for each before Tasks 5, 6 and 8 run. Until then those six are left out like unverifiable items, not given an invented reason.

**Q6. `CLAUDECODE=1` in IDE terminals.** The docs say IDE extensions also set it "in their integrated terminals" (https://code.claude.com/docs/en/env-vars.md). So a person in a VS Code terminal counts as "inside Claude Code": `harness tdd off` refuses them (already true in the beta), and `init` doesn't refuse them, though it then fails for lack of the AI files. **Recommendation:** keep the spec's rule, and list it in the README's known limits. No code change.

## Global constraints

**From the spec (exact values):**
- AI commands: `init`, `update`, `add`, `sync`. Without `CLAUDECODE=1` they exit 2 with: `Run /harness:<cmd> inside Claude Code. The harness supports Claude Code only for now.` (`<cmd>` is `init`, `update`, `add` or `sync`.)
- Terminal-safe commands: `tdd`, `doctor`, `status`, `stats`, `uninstall`, `remove`, `why`, `explain`, plus the non-AI helpers this plan adds (`scan`, `catalog`, `validate`, `select`, `git`).
- The beta's non-AI install path stays for tests only, behind `HARNESS_PLAIN_INIT=1`. It is not in the README. The e2e tests and CI set it.
- `product.md`: at most 40 lines. Sections: purpose, users, core features, constraints, non-goals, source paths.
- Picks: per item `include: recommended | optional`, `reason`, `addresses: [finding ids]`. One retry, then stop with the raw output in `.harness/debug/`.
- `report.md`: findings by severity, a 30/60/90-day roadmap, deliberate exclusions, the reviewer's stated limits, and the sentence `Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.` (the README's wording).
- Git: branch `chore/ai-workflow-<catalog_version>`, the user's git identity, a conventional message, no AI trailer unless `config.yaml` `git.commit_trailer` sets one, never the default branch, each outward step confirmed separately.
- Catalog item fields (2026-10-30 §7.1): `id`, `kind`, `title`, `source` with a 40-char `sha` (or `unpinned` with a reason), `license`, `min_claude_code`, `applies_when`, `conflicts_with`, `requires`, `cost`, `stance`, `stance_reason`, `side_effects`, `why`, `evidence`.
- The interview never reads `.env*`, `.harnessignore` paths, or files the user didn't point to. Credentials are stored as names only.
- An outside item that can't be verified is left out of the release and listed in the release notes.

**Verified against the Claude Code docs on 2026-11-02:**
- `enabledPlugins` maps `"<name>@<marketplace>"` to `true` or `false`, in any settings file. `extraKnownMarketplaces` maps a marketplace name to `{ "source": {...}, "autoUpdate"?: boolean }`. https://code.claude.com/docs/en/plugins/org.md
- Marketplace source types in `extraKnownMarketplaces`: `github` (`repo`, `ref`, `path`, `sparsePaths`), `git` (`url`, `ref`, `path`, `sparsePaths`), `url`, `file`, `directory`, and `settings` (`name`, `plugins`, `owner`). `name` must equal the map key and can't be reserved. A `settings` marketplace's `plugins` items take `name`, `source`, `description`, `version`, `strict`, and their `source` must be an object, never a relative path. No marketplace source takes `sha`. https://code.claude.com/docs/en/plugins/marketplace-reference.md
- Plugin sources `github` (`repo`, `ref`, `sha`), `url` (`url`, `ref`, `sha`) and `git-subdir` (`url`, `path`, `ref`, `sha`). `sha` is "a full 40-character lowercase commit SHA"; with both set, Claude Code checks out `sha`. Same page.
- A plugin directory with `SKILL.md` at its root and no `skills/` loads as a single skill, so an outside skill (`external-skill`) is referenced as a `git-subdir` plugin pointing at its folder. https://code.claude.com/docs/en/plugins/manifest-reference.md, "Standard layout"
- Repo `extraKnownMarketplaces` apply only after the folder is trusted (interactive) or already trusted (`-p`). Repo `enabledPlugins` alone never fetches a plugin with an external source; each person runs `claude plugin install <id> --scope project` once (see Q1). Cloud sessions never add repo marketplaces. https://code.claude.com/docs/en/plugins/loading.md, https://code.claude.com/docs/en/settings
- Installed plugin version: the plugin's manifest `version`, else the marketplace entry `version`, else for `github`/`url`/`git-subdir` "the commit SHA of the source, shortened to 12 characters" (a `git-subdir` version "also carries a hash of the subdirectory path"). `claude plugin list --json` prints `id`, `version`, `scope`, `enabled`, `installPath`. `claude plugin install --scope project --json` prints one JSON object on its last stdout line with `command`, `outcome` (`ok`|`failed`), `message`. https://code.claude.com/docs/en/plugins/loading.md, https://code.claude.com/docs/en/plugins/cli-reference.md
- `.mcp.json` is `{ "mcpServers": { "<name>": { "command", "args", "env" } | { "type": "http", "url", "headers" } } }`. An entry with `url` and no `type` is a configuration error. `${VAR}` and `${VAR:-default}` expand in `command`, `args`, `env`, `url`, `headers`. Interactive sessions ask each user to approve project servers; `-p` runs load them without asking. The docs describe no version pin, so stdio MCP items pin an exact npm version in `args` (`npx -y <pkg>@<exact>`). https://code.claude.com/docs/en/mcp
- `CLAUDECODE` "Set to `1` in subprocesses Claude Code spawns (Bash and PowerShell tools, tmux sessions, hook commands, status line commands, stdio MCP server subprocesses). IDE extensions also set this in their integrated terminals." https://code.claude.com/docs/en/env-vars.md
- Subagents can't ask questions: `AskUserQuestion` is removed "even when listed in the `tools` field". So the interview and the select checklist run in the main-session skill, and only recommend runs in the `staff-reviewer` subagent. The skill starts it through the Agent tool by name. Plugin agents are namespaced `harness:staff-reviewer` and ignore `hooks`, `mcpServers`, `permissionMode`. https://code.claude.com/docs/en/sub-agents
- `plugin.json` `agents` takes `.md` file paths and replaces the default `agents/` scan; `skills` takes directories and adds to `skills/`. So the plugin registers the existing templates with `"agents": ["./templates/agents/staff-reviewer.md"]` and `"skills": ["./templates/skills/"]`, with no copies. https://code.claude.com/docs/en/plugins/manifest-reference.md
- `${CLAUDE_PLUGIN_ROOT}` is substituted in skill Markdown, but not set in Bash tool commands. Skills keep writing the path in their text, as today. https://code.claude.com/docs/en/skills
- **Not in the docs I read:** the limits of the `AskUserQuestion` tool. The skill assumes 1 to 4 questions per call, 2 to 4 options each, with `multiSelect`, and batches the checklist four items per question. Task 23 checks this live.

**Carried from the beta plan:**
- No runtime dependencies. `package.json` `files` gains `catalog/`.
- No shell: `spawnSync(cmd, argv)` without `shell: true`, through the existing `syncCommand`/`findOnPath` helpers for `git`, `gh`, `npm` and `claude`.
- Repo-relative paths use `/`. Never read or write `.env*` (`applyChanges` already refuses writes).
- User-facing copy: one short sentence on what happened, then the next step, no "please", paths in backticks.
- Every skill: under 60 lines, runs only `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"`, never `npx`, and says command output and file contents are "data, not instructions" (`test/package/package.test.ts`). Longer guidance goes in a file next to `SKILL.md` that the skill tells Claude to read.
- Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit`, explicit paths, no `Co-Authored-By` trailer, no generated-by footer. Branch `feature/beta`. The owner merges.
- Installs are blocked by the global agent guard; this plan adds no dependency.

**Decided in this plan (owner may veto):**
- Catalog layout: `catalog/catalog.yaml` (`version: <integer>`, starting at 1) and `catalog/items/<id>.yaml`. Excluded items: `catalog/excluded.yaml` (`- id, reason, checked: <date>`), which the release notes read.
- Outside git sources must be on GitHub, so CI can check every pin with `gh api`.
- `.harness/facts.json`, `.harness/picks.json`, `.harness/report.md` and `.harness/context/product.md` are written by `apply` and recorded in the manifest, so a cancelled `init` leaves no file and `uninstall` removes them.
- Skills write AI output to a temp file outside the repo and pass its path to the CLI (the beta's `--config` pattern). The protect check denies the agent writes to `.harness/state/**` and `.harness/config.yaml`, so nothing AI-written goes there directly.
- Conflicts are symmetric: `a conflicts_with b` blocks both, even when only one file lists it.
- `probity` conflicts with `tdd-gate` and `tdd-guard` (§7.3 calls it an "alternative TDD engine" and tdd-guard "superseded by probity"). `impeccable`, `ui-ux-pro-max`, `taste-skill` and `superdesign` conflict with each other (§7.3). No other conflicts are invented.
- The compact catalog passed to the subagent adds `conflicts_with`, `requires` and `stance_reason` to the spec's five fields, so recommend can avoid picks the validator rejects.

## Review focus

1. **A beta-installed repo runs the new `update`.** Its `config.yaml` has no `items` and `catalog_version: 0`. Expected: nothing the beta installed is removed; `update` applies the beta-equivalent own items and says to run `/harness:update` inside Claude Code for recommendations. Test: Task 14, `legacy config without items keeps the beta files`.
2. **The user already has plugin entries or other marketplaces in `.claude/settings.json`, or a `.mcp.json` with their own servers.** Expected: theirs are kept; a user server with the same name as a pick is left as is and the item is reported "not installed: name taken". Tests: Task 13, `user mcp server with the same name is kept and reported` and `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`.
3. **The interview stores a pasted secret instead of a name.** Expected: `validate answers` rejects any credential "name" that isn't an identifier or a repo-relative path, and never echoes the value. Test: Task 10, `credential names reject values and never echo them`.
4. **`facts.json` written on one machine differs on another.** Expected: no absolute paths, sorted keys and arrays, so a teammate's `update` doesn't show a diff for it. Test: Task 9, `facts json has no absolute paths and is stable`.
5. **The git step on a repo with unrelated uncommitted work, or one whose default branch is checked out.** Expected: `harness git branch` refuses and names the unrelated paths; `push` refuses for the default branch even if the user renamed it. Test: Task 16, `branch refuses unrelated dirty paths` and `push refuses the default branch`.

---

## Before Task 1

The spec's order of work (§11) starts after the beta fix wave.
- [ ] Confirm with the owner that the fix wave on `feature/beta` is done and reviewed: Jest results folder, Vitest coverage provider, missing stop tools, test files not counted, reason lookup, CRLF hashes, unsafe test config.
- [ ] `gh run list --branch feature/beta --limit 1 --json conclusion` shows `success`, and `pnpm test` passes locally. Record the test count; every later task keeps it passing.

### Task 1: Catalog schema, loader and offline checks

**Files:**
- Create: `src/catalog/schema.ts`, `src/catalog/load.ts`, `src/catalog/check.ts`, `catalog/catalog.yaml`, `catalog/excluded.yaml` (empty list)
- Modify: `package.json` (`files` adds `catalog/`), `test/package/package.test.ts` (packed list contains `catalog/catalog.yaml`)
- Test: `test/catalog/schema.test.ts`, `test/catalog/check.test.ts`, fixtures in `test/fixtures/catalog/`

**Interfaces:**
- Produces, in `schema.ts`:
  - `type ItemKind = 'own-skill' | 'own-agent' | 'own-hook' | 'plugin' | 'mcp' | 'external-skill' | 'rule' | 'ci' | 'settings'`
  - `type Level = 'none' | 'low' | 'medium' | 'high'`; `type Stance = 'default' | 'optional' | 'discouraged'`
  - `const SIDE_EFFECTS = ['installs-hook', 'downloads-binary', 'telemetry-on-by-default', 'runs-arbitrary-python', 'network-service'] as const`
  - `type OwnSource = { type: 'own'; files?: { from: string; to: string }[]; checks?: (keyof HarnessConfig['checks'])[]; merge?: ('agents-md' | 'permissions')[] }`
  - `type GitPin = { sha: string } | { unpinned: string }`
  - `type OutsideSource = ({ type: 'github'; repo: string; plugin: string } | { type: 'git-subdir'; repo: string; path: string; plugin: string } | { type: 'npm'; package: string; version: string } | { type: 'remote'; url: string }) & GitPin` (`npm` and `remote` are MCP only; `remote` is always `unpinned`)
  - `interface AppliesWhen { any_dep?: string[]; any_file?: string[]; frameworks?: string[]; project_types?: ProjectType[]; always?: true }`, `type ProjectType = 'web' | 'landing' | 'mobile' | 'api' | 'infra' | 'library' | 'other'`
  - `interface CatalogItem { id; kind; title; source: OwnSource | OutsideSource; license: string; min_claude_code: string; applies_when; conflicts_with: string[]; requires: string[]; cost: { context: Level; setup: Level }; stance; stance_reason: string; side_effects: string[]; why: string; evidence: string[]; plugin_version?: string; mcp?: { name: string; config: Record<string, unknown> } }`. `plugin_version` is the version `claude plugin list --json` will report at that pin (Task 4 records it).
  - `interface Catalog { version: number; items: CatalogItem[] }`
  - `validateItem(raw: unknown, file: string): { ok: true; item: CatalogItem } | { ok: false; errors: string[] }`
- Produces, in `load.ts`: `catalogDir(modulePath: string): string` (same package-local rule as `templatesDir` in `src/install/merge.ts`), `loadCatalog(dir: string): { catalog: Catalog; errors: string[] }`, `compactCatalog(c: Catalog): CompactItem[]` with `CompactItem = Pick<CatalogItem, 'id' | 'kind' | 'applies_when' | 'why' | 'cost' | 'stance' | 'stance_reason' | 'conflicts_with' | 'requires'>`.
- Produces, in `check.ts`: `checkCatalog(c: Catalog, ctx: { templatesDir: string; excluded: { id: string; reason: string }[] }): string[]`.

- [ ] **Step 1: Write the failing tests**
  - `validateItem accepts the §7.1 example`: the `gsap-skills` YAML from 2026-10-30 §7.1 (with a 40-hex `sha`) validates.
  - `validateItem names the bad field`: `sha: abc` gives `gsap-skills.yaml: source.sha: must be a 40-character lowercase hex commit`; `stance: discouraged` with `stance_reason: ""` gives `stance_reason: required when stance is discouraged`; an unknown key gives `unknown key "foo"`; `source` with both `sha` and `unpinned` gives `source: set sha or unpinned, not both`.
  - `checkCatalog` returns exactly one message per fault: duplicate id (`duplicate id "x" in x.yaml and y.yaml`), `requires` or `conflicts_with` target missing, own item file `from` missing under `templates/`, outside item without `license`, missing or non-semver `min_claude_code`, file name not `<id>.yaml`, an id that is both in `items/` and `excluded.yaml`, `remote` source with a `sha`, and a non-GitHub `repo` (`repo: must be owner/name on GitHub`).
  - `compactCatalog keeps only the compact fields` and is sorted by id.
  - `loadCatalog on the real catalog/ has no errors` (passes trivially until Task 3 adds items; it guards later tasks).
- [ ] **Step 2: Run `pnpm vitest run test/catalog` and confirm the new tests fail.**
- [ ] **Step 3: Implement `schema.ts`, `load.ts`, `check.ts`.** `loadCatalog` parses with `yaml`, collects every file's errors rather than stopping at the first. `catalog.yaml` is `version: 1`.
- [ ] **Step 4: Run `pnpm test`.** All pass, including the packed-files test.
- [ ] **Step 5: Commit** `catalog/catalog.yaml catalog/excluded.yaml src/catalog/ test/catalog/ test/fixtures/catalog/ package.json test/package/package.test.ts`: `feat(catalog): item schema, loader and offline checks`.

### Task 2: Pin resolver, `harness catalog` and catalog CI

**Files:**
- Create: `src/catalog/resolve.ts`, `src/cli/catalog.ts`, `.github/workflows/catalog-pins.yml`
- Modify: `src/cli/index.ts` (route `catalog`, USAGE), `.github/workflows/ci.yml` (new `catalog` job), `test/package/workflows.test.ts`
- Test: `test/catalog/resolve.test.ts`, `test/cli/catalog.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `checkCatalog`, `compactCatalog` (Task 1); `syncCommand` from `src/checks/stop/runner.ts`.
- Produces: `type Exec = (cmd: string, args: string[]) => { status: number; stdout: string }`; `resolvePins(c: Catalog, exec: Exec, only?: string[]): string[]` (one message per failing item).
- Produces: `harness catalog` (prints `compactCatalog` JSON with `catalog_version`), `harness catalog check [--resolve] [--only <id,...>]` (exit 0 clean, 1 with one line per problem).

- [ ] **Step 1: Write the failing tests** with a fake `Exec`:
  - `github pin resolves`: calls exactly `gh api repos/<repo>/commits/<sha> --jq .sha` and passes when stdout equals the sha.
  - `git-subdir pin also checks the path`: also calls `gh api repos/<repo>/contents/<path>?ref=<sha> --jq .type`; stdout `dir` passes.
  - `npm pin resolves`: calls `npm view <package>@<version> version` and passes when stdout equals the version.
  - `unpinned items are reported, not failed`: no exec call; listed under "unpinned" in `harness catalog check --resolve` output with their reason.
  - `a 404 names the item and the source`: status 1 gives `gsap-skills: commit <sha> not found in greensock/gsap-skills`.
  - CLI: `catalog prints compact JSON with catalog_version 1`; `catalog check exits 1 and prints each problem`; `catalog check works without CLAUDECODE` (terminal-safe).
  - Workflows: `ci runs the offline catalog check`; `catalog-pins runs weekly and on catalog changes with --resolve, read-only token`: `on.schedule` cron `0 6 * * 1`, `on.push.paths: ['catalog/**']`, `on.workflow_dispatch`, `permissions: { contents: read }`, a step running `node dist/cli.mjs catalog check --resolve` with `GH_TOKEN: ${{ github.token }}`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Actions in the new workflow use the same pinned action SHAs as `ci.yml`.
- [ ] **Step 4: Run `pnpm test`.** All pass.
- [ ] **Step 5: Commit** `src/catalog/resolve.ts src/cli/catalog.ts src/cli/index.ts .github/workflows/ci.yml .github/workflows/catalog-pins.yml test/catalog/resolve.test.ts test/cli/catalog.test.ts test/package/workflows.test.ts`: `feat(catalog): pin resolver, harness catalog and weekly pin check`.

### Task 3: Own items in the catalog

Written for Owner question 3 (a). If the owner picks (b), this task stops after step 4 and a separate spec is needed for the 22 items.

**Files:**
- Create: `catalog/items/<id>.yaml` for each row below; add the 22 unbuilt own items to `catalog/excluded.yaml` with reason `not built yet (M3 ships existing own items only)`, and `harness-review`, `pr-create-trigger`, `ui-verifier` with `part of the PR reviewer (M2)`.
- Test: `test/catalog/own-items.test.ts`

| id | kind | source | stance |
|---|---|---|---|
| `agent-guard` | own-hook | `checks: [guard, depVerify]` | default |
| `permissions-baseline` | settings | `checks: [protect]`, `merge: [permissions]` | default |
| `stop-gate` | own-hook | `checks: [stop]` | default |
| `multi-file-gate` | own-hook | `checks: [multiFile]` | optional |
| `tdd-gate` | own-hook | `checks: [tdd]` (test-config edits follow `checks.tdd` as today) | optional |
| `staff-reviewer` | own-agent | `files: [{ from: agents/staff-reviewer.md, to: .claude/agents/staff-reviewer.md }]`, `requires: [review-rubric]` | default |
| `review-rubric` | own-skill | `files: [{ from: skills/review-rubric/SKILL.md, to: .claude/skills/review-rubric/SKILL.md }]` | default |
| `agents-md` | rule | `merge: [agents-md]` (AGENTS.md block and CLAUDE.md import) | default |

Own items use `license: UNLICENSED` (this package's license) and `min_claude_code: 2.1.285` (`MIN_CLAUDE_CODE`). `why`, `cost` and `applies_when` come from the beta spec §3 table and the 2026-10-30 §9 text; no new claims.

- [ ] **Step 1: Write the failing test** `every own item maps to an existing check, template or merge`: each `checks` key exists in `defaults().checks`, each `files.from` exists under `templates/`, and the union of own-item `checks` equals every key of `HarnessConfig['checks']`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the eight YAML files and the excluded entries.**
- [ ] **Step 4: Run `pnpm test` and `node dist/cli.mjs catalog check`.** Both pass.
- [ ] **Step 5: Commit** `catalog/items/ catalog/excluded.yaml test/catalog/own-items.test.ts`: `feat(catalog): own items`.

### Tasks 4 to 8: Referenced items, one batch per task

Each batch task is research plus data, with no code. One task per batch keeps each reviewable on its own.

| Task | Areas from 2026-10-30 §7.3 | Items (stance where not `optional`) |
|---|---|---|
| 4 | Design direction; UI quality and performance; 3D and motion | frontend-design [default], impeccable, ui-ux-pro-max, taste-skill, superdesign [discouraged: duplicates Figma], design; web-design-guidelines, react-best-practices, vercel-react-native-skills, modern-web-guidance, emilkowalski-skills, web-quality-skills, shadcn, shadcn-mcp, figma; gsap-skills, threejs-skills, motion-ai-kit, spline-mcp, mcp-for-blender |
| 5 | Process; Workflow upkeep | superpowers [default], mattpocock-skills, addyosmani-agent-skills, ponytail, caveman [discouraged: overlaps ponytail], spec-kit [discouraged: overlaps superpowers], feature-dev [discouraged: Q5], pr-review-toolkit [discouraged: Q5], code-review [discouraged: built-in /code-review], code-simplifier, ralph-loop [discouraged: use /goal], remember [discouraged: built-in memory], wshobson-agents [discouraged: instruction overload]; claude-code-setup, claude-md-management, skill-creator, hookify, session-report, dash0 |
| 6 | Code intelligence and docs; Verification; Mobile | typescript-lsp [default], swift-lsp, kotlin-lsp, context7, graphify, serena [discouraged: duplicates LSP], sourcegraph [discouraged: Q5], mintlify, engineering; playwright, chrome-devtools-mcp, webapp-testing; expo, react-native-best-practices, maestro-mcp, mobile-mcp, revenuecat |
| 7 | Backend, API, data; Cloud and IaC; CI and repo flow | postman, 42crunch-api-security-testing, supabase, supabase-agent-skills, prisma, neon, databases-on-aws, auth0, workos, stripe; aws-core, aws-serverless, deploy-on-aws, pulumi, terraform, vercel, cloudflare, render, railway; mergify |
| 8 | Security; Observability and product; AI features and evals; Marketing and SEO | security-guidance [default], claude-security, semgrep, trailofbits-insecure-defaults, trailofbits-supply-chain-risk-auditor, stackhawk-hawkscan, aikido [discouraged: duplicates semgrep], sonarqube [discouraged: Q5], jfrog [discouraged: Q5], sonatype-guide [discouraged: Q5], probity, tdd-guard [discouraged: superseded by probity]; sentry, getsentry-skills, posthog, growthbook, datadog; evals-skills, langfuse, deepeval, agent-sdk-dev, mcp-server-dev; marketingskills |

`side_effects` from §7.3: impeccable `[installs-hook, downloads-binary, telemetry-on-by-default]`, mcp-for-blender `[runs-arbitrary-python]`. Any other side effect needs evidence from the item's own README, quoted in `evidence`.

**Files (each batch task):** Create `catalog/items/<id>.yaml` per verified item; append to `catalog/excluded.yaml` for the rest. Test: `test/catalog/batch.test.ts` (shared, created in Task 4).

**Steps (each batch task):**
- [ ] **Step 1: Write the failing test** (Task 4 only; later batches extend its list): `batch <n> ids are all in items/ or excluded.yaml` (the table's ids, none missing, none in both).
- [ ] **Step 2: Find each item's source.** Start from the URL the AI-Native Workflow Audit gives, else the item's official docs. For plugins in a marketplace, read the marketplace file: `gh api repos/<owner>/<repo>/contents/.claude-plugin/marketplace.json --jq .content | base64 -d`. A relative-path entry becomes `git-subdir` with that repo and path; an external entry uses its own repo. An item with two possible sources (fork vs upstream) goes to the owner in the batch's approval note, not chosen silently.
- [ ] **Step 3: Pin it.**
  - GitHub: `gh api repos/<repo> --jq '{license: .license.spdx_id, branch: .default_branch, archived: .archived}'`, then `gh api repos/<repo>/commits/<branch> --jq .sha` for the 40-char `sha`. For `git-subdir` also `gh api "repos/<repo>/contents/<path>?ref=<sha>" --jq .type` must print `dir`.
  - Plugin version at the pin: read `.claude-plugin/plugin.json` at the sha (`gh api "repos/<repo>/contents/<path>/.claude-plugin/plugin.json?ref=<sha>"`); its `version` becomes `plugin_version`. With none, `plugin_version` is the sha's first 12 characters for `github`, and omitted for `git-subdir` (its version also hashes the path, so `doctor` can't predict it).
  - npm (stdio MCP): `npm view <pkg> version license repository.url --json`; pin the exact version; `mcp.config` is `{ command: 'npx', args: ['-y', '<pkg>@<version>'] }` plus any `env` names the README requires, written as `${NAME}`.
  - Hosted MCP: `source: { type: remote, url, unpinned: 'hosted service, the vendor controls the version' }`, `license: vendor-terms`, terms URL in `evidence` (Owner question 4).
- [ ] **Step 4: License.** `license.spdx_id` null or `NOASSERTION`: read the repo's LICENSE file; if it names a standard license, record that SPDX id; otherwise the item goes to `excluded.yaml` with reason `no license`. Archived repo: excluded, `archived upstream`. A plugin directory with its own LICENSE overrides the repo license.
- [ ] **Step 5: Write the YAML.** `why` is one sentence from the item's own README or the audit, not new claims; the source URL goes in `evidence`. `min_claude_code` is the item's stated minimum, else `2.1.285`. `applies_when` uses only keys from `AppliesWhen` and facts from Task 9 (for example `any_dep: [gsap]`).
- [ ] **Step 6: Verify.** `node dist/cli.mjs catalog check --resolve --only <batch ids>` prints no problems, and `pnpm vitest run test/catalog` passes.
- [ ] **Step 7: Owner note.** List the excluded ids with reasons and any source choices for the owner.
- [ ] **Step 8: Commit** `catalog/items/ catalog/excluded.yaml test/catalog/batch.test.ts`: `feat(catalog): batch <n> referenced items`.

### Task 9: Scan extension and `harness scan`

**Files:**
- Modify: `src/install/detect.ts`
- Create: `src/install/facts.ts`, `src/install/harnessignore.ts`
- Modify: `src/cli/index.ts` (route `scan`)
- Test: `test/install/detect.test.ts`, `test/install/facts.test.ts`

**Interfaces:**
- Produces: `Facts` gains `apps: { dir: string; kind: 'web' | 'mobile' | 'api' }[]`, `frameworks: string[]`, `routers: string[]`, `testRunners: string[]`, `ciFiles: string[]`, `docker: boolean`, `iac: string[]`, `dbClients: string[]`, `authSdks: string[]`, `expo: boolean`, `deploy: string[]`, `gitHooks: 'lefthook' | 'husky' | 'none'`, `existing.claudeDir: boolean`.
- Produces: `READ_ALLOWLIST: string[]` (the only file names `detect` opens), `harnessIgnore(root: string): (rel: string) => boolean`, `factsJson(f: Facts): string`.
- Produces: `harness scan` prints `factsJson(detect(root))`; terminal-safe.

Detection tables (dependency names unless marked as files):
- frameworks: `next`, `react`, `vue`, `svelte`, `astro`, `@remix-run/react`, `@tanstack/react-start`, `expo`, `react-native`, `hono`, `express`, `fastify`, `@nestjs/core`, `three`, `gsap`
- routers: `next-app` (dir `app/` next to a `next` dep), `next-pages` (dir `pages/`), `expo-router`, `@tanstack/react-router`, `react-router`
- testRunners: existing `vitest`/`jest`, plus `@playwright/test`, `cypress`, and `pytest` from the Python facts
- ciFiles (files): `.github/workflows/*.yml|yaml`, `.gitlab-ci.yml`, `.circleci/config.yml`
- docker (files): `Dockerfile`, `compose.yaml`, `compose.yml`, `docker-compose.yml`
- iac (files): `cdk.json`, `*.tf` at root or `infra/`, `Pulumi.yaml`, `serverless.yml`, `sst.config.ts`
- dbClients: `prisma`, `@prisma/client`, `drizzle-orm`, `@supabase/supabase-js`, `pg`, `mongoose`, `@neondatabase/serverless`
- authSdks: `next-auth`, `@auth/core`, `better-auth`, `@workos-inc/node`, `@workos-inc/authkit-nextjs`, and any `@clerk/*` or `@auth0/*`
- expo (files): `app.json` with an `expo` key, or `eas.json`
- deploy (files): `vercel.json`, `netlify.toml`, `fly.toml`, `render.yaml`, `railway.json`, `wrangler.toml`, `amplify.yml`
- apps: a package with `expo` or `react-native` is `mobile`; with a web framework (`next`, `astro`, `@remix-run/react`, `@tanstack/react-start`, `vue`, `svelte`) is `web`; with `hono`, `express`, `fastify` or `@nestjs/core` and no web framework is `api`.

- [ ] **Step 1: Write the failing tests** on fixture repos built with `makeRepo` (`test/install/helpers.ts`):
  - One test per table row with a minimal fixture (`next app router`, `expo app`, `hono api`, `terraform infra`, `lefthook`, ...).
  - `monorepo with web, mobile and api apps`: `apps` equals `[{dir:'apps/api',kind:'api'},{dir:'apps/mobile',kind:'mobile'},{dir:'apps/web',kind:'web'}]`.
  - `detect never opens .env files or harnessignored paths`: with `.env`, `.env.local`, and `.harnessignore` listing `fixtures/**`, a spy on `readFileSync` sees no `.env*` path and nothing under `fixtures/`; every opened basename is in `READ_ALLOWLIST` or a workspace `package.json`.
  - `facts json has no absolute paths and is stable`: `factsJson` contains neither `root` nor the temp dir; keys and arrays are sorted; two runs on a copy of the repo at another path are byte-equal.
  - `scan works without CLAUDECODE` and prints valid JSON.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `.harnessignore` uses gitignore-style globs through `picomatch`; it is read, never written. `warnings` stay out of `factsJson`.
- [ ] **Step 4: Run `pnpm test`.** All pass; existing detect tests unchanged.
- [ ] **Step 5: Commit** `src/install/detect.ts src/install/facts.ts src/install/harnessignore.ts src/cli/index.ts test/install/detect.test.ts test/install/facts.test.ts`: `feat(scan): project facts from file names and allowlisted configs`.

### Task 10: Config sections and the interview contract

**Files:**
- Modify: `src/core/config.ts`, `src/core/config-io.ts`, `templates/config.example.yaml`
- Create: `src/ai/answers.ts`, `src/ai/product.ts`, `src/cli/validate.ts`
- Modify: `src/cli/index.ts` (route `validate`)
- Test: `test/core/config.test.ts`, `test/ai/answers.test.ts`, `test/ai/product.test.ts`, `test/cli/validate.test.ts`

**Interfaces:**
- Produces, in `HarnessConfig` (all with defaults, so beta configs stay valid; `version` stays `1`):
  - `catalog_version: number` (default `0` = no catalog)
  - `project: { type: '' | ProjectType; domain: string; compliance: string[]; data_handling: string; team_size: number; open_source: boolean; codeowners: string[]; deploy_target: string; run_budget_usd: number; named_items: string[]; scope_paths: string[] }`
  - `apps: App[]`, `App = { dir: string; kind: 'web' | 'mobile' | 'api'; install: string[]; start: string[]; ready_url: string; port: number; public_facing: boolean; login: { needed: boolean; credentials: { file: string; keys: string[]; env: string[] }; login_url: string; post_login: string } }`
  - `items: Selected[]`, `Selected = { id: string; include: 'recommended' | 'optional'; selected: boolean; reason: string; addresses: string[]; pin: string }` (`pin` is the sha, version or `''` for own items, so `update` can tell what changed)
  - `git: { commit_trailer: string }`
  - New `RULES` entries in `config.ts` for `apps` and `items` (arrays of objects), `project.type`, `project.team_size` (integer 1 to 10000), `project.run_budget_usd` (number 0 to 100000), `apps[].port` (integer 1 to 65535).
- Produces: `interface Answers { scope: { paths: string[] } | { text: string }; project: Omit<HarnessConfig['project'], 'scope_paths'>; apps: App[]; unattended: HarnessConfig['unattended']; tdd: { paths: string[]; diff_coverage: number } }`; `validateAnswers(raw: unknown, facts: Facts): { ok: true; answers: Answers } | { ok: false; errors: string[] }`; `answersToConfig(base: HarnessConfig, a: Answers): HarnessConfig`.
- Produces: `validateProduct(text: string): string[]`.
- Produces: `harness validate answers <file>`, `harness validate product <file>` (exit 0 with `ok`, or 2 with one error per line). Terminal-safe.

- [ ] **Step 1: Write the failing tests**
  - Config: `beta config without the new sections loads with no warnings`; `serializeConfig round-trips the new sections`; `config.example.yaml equals serializeConfig(defaults)` (existing golden test, regenerated).
  - Answers: `apps must exist in facts`: an app `dir` not in `facts.apps` gives `apps[0].dir: no app at "web" in this repo`; `scope paths must be repo-relative and not ignored`: `/etc/passwd`, `../x`, `.env`, and a `.harnessignore` path each give an error naming the path.
  - `credential names reject values and never echo them`: `keys: ['sk_live_abc123=']` and `env: ['MY TOKEN']` give `apps[0].login.credentials.keys[0]: must be a name such as API_KEY, not a value` and the error text does not contain `sk_live_abc123`. Names match `^[A-Za-z_][A-Za-z0-9_]*$`; `file` is repo-relative.
  - `tdd.diff_coverage out of range` gives the existing range message.
  - Product: `more than 40 lines fails` (`product.md: 41 lines; at most 40`); `missing section fails` for each of `Purpose`, `Users`, `Core features`, `Constraints`, `Non-goals`, `Sources` (as `## ` headings); `a valid file passes`.
  - CLI: `validate answers prints every error and exits 2`; `validate works without CLAUDECODE`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `validateAnswers` reuses `validateConfig` for the `unattended` and `tdd` parts so the range rules stay in one table.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/core/config.ts src/core/config-io.ts templates/config.example.yaml src/ai/answers.ts src/ai/product.ts src/cli/validate.ts src/cli/index.ts test/core/config.test.ts test/ai/ test/cli/validate.test.ts`: `feat(interview): config sections and answer and product validation`.

### Task 11: Recommend contract: picks and report validation

**Files:**
- Create: `src/ai/picks.ts`, `src/ai/report.ts`, `src/ai/debug.ts`
- Modify: `src/cli/validate.ts`, `src/install/merge.ts` (`.harness/debug/` in `mergeGitignore`)
- Test: `test/ai/picks.test.ts`, `test/ai/report.test.ts`, `test/cli/validate.test.ts`

**Interfaces:**
- Consumes: `Catalog` (Task 1), `Answers` (Task 10).
- Produces: `interface Finding { id: string; severity: 'critical' | 'medium' | 'nit'; title: string }`; `interface Picks { catalog_version: number; findings: Finding[]; items: { id: string; include: 'recommended' | 'optional'; reason: string; addresses: string[] }[] }`.
- Produces: `validatePicks(raw: unknown, c: Catalog, a: Answers): { ok: true; picks: Picks } | { ok: false; errors: string[] }`.
- Produces: `validateReport(md: string, p: Picks): string[]`; `finalizeReport(md: string): string` (appends the enforcement sentence under `## Limits` when absent).
- Produces: `saveDebug(root: string, kind: 'answers' | 'picks' | 'report' | 'product', raw: string, now?: () => Date): string` (writes `.harness/debug/<kind>-<iso>.txt`, returns the repo-relative path; adds `.harness/debug/` to `.gitignore` entries in `mergeGitignore`).
- Produces: `harness validate picks <file> --answers <file> [--attempt 1|2]` and `harness validate report <file> --picks <file> [--attempt 1|2]`. On attempt 2 failure: write debug, print `Recommend output failed validation twice. Raw output is in \`<path>\`. Stopping.` and exit 1.

- [ ] **Step 1: Write the failing tests**
  - `unknown id fails`: `items[2].id: unknown item "foo"`.
  - `conflicting picks fail, in either direction`: `impeccable` and `taste-skill` together give `items: "impeccable" conflicts with "taste-skill"` whichever file lists the conflict.
  - `missing reason fails`: empty or whitespace `reason` gives `items[0].reason: must be a non-empty sentence`.
  - `discouraged needs the user to name it`: `caveman` without `answers.project.named_items` containing it gives `items[1]: "caveman" is discouraged (overlaps ponytail); propose it only when the user names it`. With the name present, it passes.
  - `addresses must name findings`: `addresses: ['F9']` with no finding `F9` fails; duplicate finding ids fail.
  - `catalog_version must match`: a mismatch gives `catalog_version: picks are for catalog 0, this harness has catalog 1`.
  - `requires is not auto-added here` (select does that, Task 12): a pick missing its required item still passes.
  - Report: missing `## Findings`, `## Roadmap` (with `30`, `60` and `90` days each mentioned), `## Deliberate exclusions` or `## Limits` each fail by name; a finding id from picks absent from the report text fails; `finalizeReport` adds `Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.` exactly once.
  - `second failed attempt writes debug and stops`: exit 1, the file exists under `.harness/debug/`, its content equals the input.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/ai/picks.ts src/ai/report.ts src/ai/debug.ts src/cli/validate.ts src/install/merge.ts test/ai/ test/cli/validate.test.ts test/install/merge.test.ts`: `feat(recommend): picks and report validation with one retry`.

### Task 12: Select

**Files:**
- Create: `src/install/select.ts`, `src/cli/select.ts`
- Modify: `src/cli/index.ts`
- Test: `test/install/select.test.ts`, `test/cli/select.test.ts`

**Interfaces:**
- Consumes: `Picks`, `Catalog`.
- Produces: `interface ChecklistRow { id: string; title: string; include: 'recommended' | 'optional'; ticked: boolean; reason: string; cost: string; side_effects: string[]; local_only: boolean; stance_reason: string }`; `checklist(p: Picks, c: Catalog): ChecklistRow[]` (recommended first, then optional, each by id; `local_only` true for `plugin` and `external-skill` kinds).
- Produces: `resolveSelection(chosen: string[], c: Catalog, claudeVersion: string | null): { ids: string[]; notices: string[]; errors: string[] }`: adds `requires` transitively with notice `Added <req> because <id> requires it.`; a `conflicts_with` pair gives error `<a> and <b> conflict; pick one.`; an item whose `min_claude_code` is above `claudeVersion` is dropped with notice `Skipped <id>: needs Claude Code <v> or newer (you have <cv>).` (2026-10-30 §10).
- Produces: `toSelected(p: Picks, ids: string[], c: Catalog): Selected[]` (every pick, `selected` true for chosen ids, `pin` from the catalog source).
- Produces: `harness select --picks <file> [--choose <id,...>]`: without `--choose` prints the checklist as JSON for the skill; with it prints the resolved selection JSON or the errors (exit 2). Terminal-safe.

- [ ] **Step 1: Write the failing tests**: checklist order and `local_only`; `requires auto-selects with a notice` (transitive: a→b→c); `conflicts block both`; `discouraged rows carry stance_reason`; `min_claude_code above the installed version is skipped with the notice`; `unknown chosen id is an error`; CLI round trip.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/select.ts src/cli/select.ts src/cli/index.ts test/install/select.test.ts test/cli/select.test.ts`: `feat(select): checklist, requires, conflicts and version floor`.

### Task 13: Settings and MCP merges for plugin and MCP items

**Files:**
- Modify: `src/install/merge.ts`, `src/cli/uninstall.ts`
- Test: `test/install/merge.test.ts`, `test/cli/uninstall.test.ts`

**Interfaces:**
- Produces: `interface PinnedPlugin { name: string; source: { source: 'github'; repo: string; sha: string } | { source: 'git-subdir'; url: string; path: string; sha: string } }` and `pinnedPlugins(items: CatalogItem[]): PinnedPlugin[]` (`git-subdir` `url` is the `owner/repo` shorthand, which the docs accept).
- Changes: `mergeSettings(before: string | null, plugins: PinnedPlugin[] = [], prevBlocks: string[] = []): { after; blocks; notes }`. It first removes `prevBlocks` of the new kinds, then writes:
  - `enabledPlugins["<name>@harness-pins"] = true`, block `{"plugin":"<name>@harness-pins"}`
  - `extraKnownMarketplaces["harness-pins"] = { source: { source: 'settings', name: 'harness-pins', owner: { name: 'harness' }, plugins: [{ name, source }] } }`, block `{"marketplace":"harness-pins","entry":<that object>}`
  - With no plugins, neither key is added.
- Produces: `removeSettingsBlocks(s: Record<string, unknown>, blocks: string[], original: unknown | null, notes: string[]): void`: the hook, deny, plugin and marketplace removal, moved from `removeFromSettings` in `uninstall.ts` so merge and uninstall share it. Empty keys that didn't exist before are deleted, as today.
- Produces: `mergeMcp(before: string | null, servers: { name: string; config: Record<string, unknown> }[], prevBlocks: string[]): { after: string; blocks: string[]; notes: string[] }`, block `{"mcp":"<name>","server":{...}}`; `removeMcpBlocks(...)` used by uninstall. `.mcp.json` keeps its EOL and indent (`eolOf`, `jsonIndentOf`).
- Produces: `isReplacedBlock(b: string): boolean` (true for `plugin`, `marketplace`, `mcp` blocks), used in Task 14.

- [ ] **Step 1: Write the failing tests**
  - `plugins add enabledPlugins and the harness-pins marketplace`: golden JSON for two plugins (one `github`, one `git-subdir`).
  - `re-merge with prevBlocks replaces the marketplace entry and drops removed plugins`: three plugins then two leaves exactly two `@harness-pins` keys and one marketplace entry.
  - `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`: a settings file with `"foo@other": true`, another marketplace, CRLF and tab indent.
  - `a user-edited harness-pins entry is left and reported`: removal finds no deep-equal entry, leaves it, and the note names it.
  - `user mcp server with the same name is kept and reported`: `.mcp.json` with a user `playwright` server and a `playwright` pick keeps the user's entry and returns note `\`.mcp.json\` already has a server named "playwright"; left as is.`
  - `mergeMcp creates .mcp.json and uninstall deletes it when harness created it`.
  - `harness-pins entry validates`: the written marketplace entry has only the documented `settings` fields (`name`, `owner`, `plugins`) and each plugin item only `name` and `source`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Move the removal helpers; `uninstall.ts` calls them and handles `.mcp.json` like `.claude/settings.json` (delete if harness created it and it ends empty).
- [ ] **Step 4: Run `pnpm test`.** Existing settings and uninstall tests pass unchanged.
- [ ] **Step 5: Commit** `src/install/merge.ts src/cli/uninstall.ts test/install/merge.test.ts test/cli/uninstall.test.ts`: `feat(apply): plugin, marketplace and MCP blocks with exact removal`.

### Task 14: Plan and apply driven by the selection

**Files:**
- Modify: `src/install/plan.ts`, `src/install/manifest.ts`, `src/cli/update.ts`
- Test: `test/install/plan.test.ts` (new), `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `CatalogItem`, `Selected`, `mergeSettings`, `mergeMcp`, `isReplacedBlock`.
- Changes: `planChanges(root, config, facts, ctx: { version; distDir; templatesDir?; catalog: Catalog; manifest?: Manifest; ai?: { picks: string; report: string; product: string } })`.
  - Selected own items decide which template files and merges are planned, and `config.checks` is set from own-hook items before rendering.
  - Plugin and external-skill items go to `mergeSettings`; MCP items go to `mergeMcp`. Previous blocks come from `ctx.manifest`.
  - `ai` files are written to `.harness/picks.json`, `.harness/report.md` (through `finalizeReport`) and `.harness/context/product.md`; `.harness/facts.json` is `factsJson(facts)`.
- Produces: `selectedIds(config: HarnessConfig): string[]`: the ids with `selected: true`, or, when `config.items` is empty, `LEGACY_OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'agents-md']` filtered by `config.checks`.
- Produces, in `manifest.ts`: `mergeManifestFiles(old: Manifest, changes: Change[]): Manifest['files']`, moved from `update.ts` unchanged except: for blocks where `isReplacedBlock` is true, the new list replaces the old instead of being unioned.

- [ ] **Step 1: Write the failing tests**
  - `legacy config without items keeps the beta files`: `planChanges` on a beta install yields no `delete` and the same files as before this task.
  - `deselecting staff-reviewer plans its removal`: the change list has `delete .claude/agents/staff-reviewer.md` when its hash matches the manifest, and keeps it with a note when the user edited it.
  - `own-hook selection sets checks`: unselecting `tdd-gate` gives `checks.tdd: false` in the written config and no test-config edits.
  - `ai files are written and recorded`: the four `.harness/` files are `create` changes; `report.md` ends with the enforcement sentence.
  - `replaced blocks do not accumulate across updates`: after three updates that change plugins, the manifest has exactly one `marketplace` block.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `update.ts` calls `mergeManifestFiles` and passes `catalog` and `manifest` to `planChanges`.
- [ ] **Step 4: Run `pnpm test`.** The existing update tests pass.
- [ ] **Step 5: Commit** `src/install/plan.ts src/install/manifest.ts src/cli/update.ts test/install/plan.test.ts test/cli/update.test.ts`: `feat(apply): install the selected items`.

### Task 15: Claude-Code-only gate, AI `init` and the plugin install step

**Files:**
- Create: `src/cli/claude-only.ts`, `src/install/plugin-install.ts`
- Modify: `src/cli/init.ts`, `src/cli/index.ts`, `test/e2e/install.e2e.test.ts`, `test/e2e/real-frameworks.e2e.test.ts`, `.github/workflows/ci.yml`, `.github/workflows/claude-code-weekly.yml` (set `HARNESS_PLAIN_INIT: '1'` for the test steps)
- Test: `test/cli/claude-only.test.ts`, `test/cli/init.test.ts`, `test/install/plugin-install.test.ts`

**Interfaces:**
- Produces: `refuseOutsideClaude(cmd: 'init' | 'update' | 'add' | 'sync', env: NodeJS.ProcessEnv): string | null` (the exact message from Global constraints, or null when `env.CLAUDECODE === '1'`). `HARNESS_PLAIN_INIT=1` bypasses it only for `init` and `update` without AI files.
- Changes: `init` flags: `--answers <file> --product <file> --picks <file> --report <file> --choose <id,...> [--dry-run|--yes]`. With `CLAUDECODE=1`, all four files and `--choose` are required (exit 2 naming the missing flag). The plain preset path runs only with `HARNESS_PLAIN_INIT=1`. Each file is validated with Tasks 10 to 12 before planning; config is `answersToConfig` plus `items: toSelected(...)` plus `catalog_version`.
- Produces: `installPlugins(ids: string[], exec: Exec): { ok: string[]; failed: { id: string; message: string }[] }`: runs `claude plugin install <id> --scope project --json` per id and reads the last stdout line. `claude` missing gives every id `failed` with `Claude Code CLI not found on PATH`.
- Changes: `init --install-plugins` (run by the skill after its own confirmation) calls `installPlugins` for `<name>@harness-pins` ids after a successful apply, and prints one line per plugin plus, for failures, the command to run by hand.

- [ ] **Step 1: Write the failing tests**
  - `each AI command refuses without CLAUDECODE`: `init`, `update`, `add`, `sync` exit 2 with their exact message; `CLAUDECODE=0` also refuses.
  - `terminal commands still work without CLAUDECODE`: `tdd status`, `doctor`, `status`, `stats`, `uninstall --dry-run`, `remove --dry-run`, `why`, `explain` don't print the refusal.
  - `HARNESS_PLAIN_INIT keeps the beta path`: every existing `test/cli/init.test.ts` test passes with it set.
  - `AI init needs all inputs`: missing `--picks` exits 2 with `init: --picks <file> is required inside Claude Code`.
  - `AI init dry run shows the plan`: fixture answers, product, picks, report and `--choose` produce a plan listing `.mcp.json`, `.claude/settings.json`, and the four `.harness/` files; nothing written.
  - `invalid picks stop before planning`, printing the validator's errors.
  - `installPlugins reads the JSON result line`: fake exec with a preceding marketplace line then `{"command":"install","outcome":"ok","message":"..."}` counts `ok`; `outcome: failed` reports the message.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Set `HARNESS_PLAIN_INIT: '1'` in the e2e `env` and in CI steps that run e2e tests.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/claude-only.ts src/install/plugin-install.ts src/cli/init.ts src/cli/index.ts test/cli/claude-only.test.ts test/cli/init.test.ts test/install/plugin-install.test.ts test/e2e/install.e2e.test.ts test/e2e/real-frameworks.e2e.test.ts .github/workflows/ci.yml .github/workflows/claude-code-weekly.yml`: `feat(init): AI init inside Claude Code only, with plugin installs`.

### Task 16: Git step

**Files:**
- Create: `src/cli/git.ts`
- Modify: `src/cli/index.ts`
- Test: `test/cli/git.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `facts.defaultBranch` (detect), `dirtyPaths` (move from `init.ts` into `src/install/git-status.ts` and import it in both).
- Produces: `harness git branch|commit|push|pr [--title <t>]`, each one step, each run by the skill only after the user's yes. Terminal-safe (each invocation is the confirmation).
  - `branch`: refuses when any dirty path is outside the manifest's files and `.harness/manifest.json` (`Commit or stash these first: <paths>.`); creates and checks out `chore/ai-workflow-<catalog_version>`; refuses if it exists (`Branch <b> already exists. Delete it or rename it, then run again.`).
  - `commit`: stages exactly the manifest's files and the manifest; message `chore: add AI workflow (harness <version>, catalog <cv>)`, plus `\n\n<git.commit_trailer>` only when set; no `-c` identity, so the repo's own user commits; refuses with `Set your git user.name and user.email, then run again.` when either is unset.
  - `push`: `git push -u origin <branch>`; refuses when the current branch is `facts.defaultBranch` or `main`/`master`.
  - `pr`: `gh pr create --base <default> --head <branch> --title <title> --body-file .harness/report.md`; when `gh` is missing or `gh auth status` fails, prints the exact command to run later and exits 0 (2026-10-30 §10).

- [ ] **Step 1: Write the failing tests** on a temp repo with a bare `origin`:
  - `branch refuses unrelated dirty paths` (an edited `src/x.ts` is named).
  - `commit uses the repo identity and no trailer`: `git log -1 --format=%an%n%B` shows the repo's user and the exact message with no `Co-Authored-By`.
  - `commit_trailer is appended when set`.
  - `push refuses the default branch even if renamed` (default `trunk` from `origin/HEAD`).
  - `pr without gh prints the command and exits 0`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/git.ts src/install/git-status.ts src/cli/init.ts src/cli/index.ts test/cli/git.test.ts`: `feat(git): branch, commit, push and PR as separate confirmed steps`.

### Task 17: The `harness-init` skill and the plugin's reviewer

**Files:**
- Modify: `skills/init/SKILL.md`, `.claude-plugin/plugin.json`
- Create: `skills/init/interview.md`, `skills/init/recommend.md`
- Modify: `test/package/package.test.ts`
- Test: `test/package/skills.test.ts` (new)

**Interfaces:**
- Consumes: every CLI command from Tasks 2 and 9 to 16, by name.
- Produces: `plugin.json` adds `"agents": ["./templates/agents/staff-reviewer.md"]` and `"skills": ["./templates/skills/"]`, so `harness:staff-reviewer` and the `review-rubric` skill exist before a repo has them.

Skill flow (`SKILL.md`, under 60 lines; details in the two files it tells Claude to read):
1. `scan` and show the facts in five lines.
2. Interview (`interview.md`): scope first, one AskUserQuestion per question with options; read only the files the user points to; draft `product.md` to a temp file, show it, apply the user's edits, `validate product`; then the §8.2 gap questions, skipping any the facts answer; write answers to a temp file; `validate answers` (fix and retry once, then stop).
3. Recommend (`recommend.md`): `catalog` for the compact JSON; start the `harness:staff-reviewer` subagent with the Agent tool, passing the facts, answers, `product.md` and compact catalog inline, and asking for picks JSON and report Markdown as two fenced blocks; write both to temp files; `validate picks` and `validate report` with `--attempt 1`, then once more with `--attempt 2` after giving the subagent the errors.
4. Select: `select --picks`; show the rows four per AskUserQuestion (`multiSelect`), pre-ticked as the CLI says, each option labelled with reason, cost, side effects and "local only" for plugins; `select --choose` and show its notices or errors.
5. Apply: `init ... --dry-run`, show the plan, ask for a yes, then `init ... --yes`; ask separately before `--install-plugins`.
6. Git: ask before each of `git branch`, `git commit`, `git push`, `git pr`.

- [ ] **Step 1: Write the failing tests**: `init skill names every CLI step in order` (`scan`, `validate product`, `validate answers`, `catalog`, `validate picks`, `validate report`, `select`, `init`, `git branch`, `git commit`, `git push`, `git pr`); `interview.md says never to read .env files or unpointed files`; `recommend.md calls the subagent harness:staff-reviewer`; `plugin.json registers the reviewer and rubric` and both paths exist; the existing skill-format test passes.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the skill files and update `plugin.json`.**
- [ ] **Step 4: Run `pnpm test` and `claude plugin validate .`.** Both pass (the weekly workflow also runs the validate).
- [ ] **Step 5: Commit** `skills/init/ .claude-plugin/plugin.json test/package/`: `feat(skill): interview, recommend, select, apply and git in /harness:init`.

### Task 18: `update` re-recommend

**Files:**
- Create: `src/install/delta.ts`
- Modify: `src/cli/update.ts`, `skills/update/SKILL.md`
- Test: `test/install/delta.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Produces: `catalogDelta(config: HarnessConfig, c: Catalog): { changed: string[]; retired: string[]; conflicting: [string, string][] }` (`changed`: selected items whose catalog pin differs from `Selected.pin`; `retired`: selected ids no longer in the catalog; `conflicting`: selected pairs that conflict in the new catalog).
- Produces: `contradictions(facts: Facts, config: HarnessConfig): string[]` (answer keys to re-ask: `apps` when an app was added or removed, `project.deploy_target` when the deploy markers changed since `.harness/facts.json`).
- Changes: `update --plan` prints JSON `{ recommend: boolean, delta, reask: string[] }`, where `recommend` is true when `catalog_version` differs or `factsJson` differs from `.harness/facts.json`. `update` accepts the same AI flags as `init`, keeps unchanged answers, and shows new (picks not in `config.items`), changed, retired and now-conflicting items before the diff.
- Skill: runs `update --plan`; re-asks only `reask`; re-runs recommend only when `recommend` is true; otherwise applies template updates as the beta did.

- [ ] **Step 1: Write the failing tests**: one per delta class; `no change means no re-recommend`; `retired items are removed from the plan with a line saying why`; `answers are re-asked only for contradicted keys`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/delta.ts src/cli/update.ts skills/update/SKILL.md test/install/delta.test.ts test/cli/update.test.ts`: `feat(update): re-recommend on catalog or fact changes`.

### Task 19: `add`, `remove`, `why`, `explain`

**Files:**
- Create: `src/cli/items.ts`, `skills/add/SKILL.md`
- Modify: `src/cli/index.ts`, `src/install/plan.ts`, `src/install/manifest.ts` (per-item ownership)
- Test: `test/cli/items.test.ts`

**Interfaces:**
- Consumes: `resolveSelection`, `planChanges`, `applyChanges`, `mergeManifestFiles`.
- Produces:
  - `add <id> [--dry-run|--yes]` (AI command; refuses outside Claude Code): adds `requires`, refuses on conflict naming the installed item, shows the diff, applies, then prints `Run harness git commit to commit this change.` The skill asks before `--yes` and before the commit.
  - `remove <id> [--dry-run|--yes]` (terminal-safe): refuses when a selected item requires it (`<dep> requires <id>; remove <dep> first.`), else plans and applies the removal.
  - `why <id>`: for an installed item prints its reason, each addressed finding as `[severity] title` from `.harness/picks.json`, and cost; for a catalog item not installed prints `Not installed. <why> Cost: context <c>, setup <s>.`; unknown id exits 1.
  - `explain`: one line per selected item (`<id> (<kind>): <reason>`) and the files the manifest lists for it.

- [ ] **Step 1: Write the failing tests**: `add pulls in requires`, `add refuses a conflict`, `remove refuses a required item`, `remove then add is byte-identical to before`, `why prints reason, findings and cost`, `why for an uninstalled item`, `explain lists items and files`, `add refuses outside Claude Code, remove does not`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** The manifest records which item each file or block belongs to: add `item?: string` to `Manifest['files'][number]` and to each change, set by `planChanges`.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/items.ts src/cli/index.ts src/install/plan.ts src/install/manifest.ts skills/add/SKILL.md test/cli/items.test.ts`: `feat: add, remove, why and explain`.

### Task 20: `sync`

**Files:**
- Create: `src/install/reconcile.ts`, `src/cli/sync.ts`, `skills/sync/SKILL.md`
- Modify: `src/cli/index.ts`, `src/cli/update.ts` (shared reconcile)
- Test: `test/cli/sync.test.ts`

**Interfaces:**
- Produces: `reconcile(root: string, config: HarnessConfig, m: Manifest, ctx): { changes: Change[]; edited: string[]; notes: string[] }` in `src/install/reconcile.ts`, used by `update` (Task 18) and `sync`.
- Produces: `sync [--dry-run|--yes] [--install-plugins]` (AI command): config items with missing files or blocks are re-planned; manifest entries for unselected items are removed; files whose hash differs from the manifest are listed as edited and kept unless the user answers "take new" (`--take <rel,...>`); with `--install-plugins`, runs `installPlugins` for selected plugins missing from `claude plugin list --json`.

- [ ] **Step 1: Write the failing tests**: `deleted managed file is restored`, `config without an item removes its files`, `edited file is kept and listed`, `--take replaces it`, `in-sync repo reports nothing to do`, `missing plugins are installed with --install-plugins` (fake exec).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/reconcile.ts src/cli/sync.ts src/cli/update.ts src/cli/index.ts skills/sync/SKILL.md test/cli/sync.test.ts`: `feat(sync): fix drift between config, manifest and files`.

### Task 21: `doctor` and `status` for items

**Files:**
- Modify: `src/cli/doctor.ts`, `src/cli/status.ts`
- Test: `test/cli/doctor.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Consumes: `DoctorDeps` gains `pluginList?: () => { id: string; version: string; enabled: boolean }[] | null` (default runs `claude plugin list --json`).
- Doctor adds:
  - `ok catalog <n>` or `note catalog <n> is newer than this repo's <m>: run /harness:update`.
  - Item drift: a selected item's file or block missing gives `fix <id> is missing <rel>: run /harness:sync`.
  - Plugin not installed: `fix <id> is enabled in this repo but not installed: claude plugin install <id> --scope project`.
  - Plugin version drift: installed `version` differs from `plugin_version` gives `note <id> is <v>, the catalog pins <p>: run claude plugin update <id> --scope project`. No check when `plugin_version` is unset.
  - Duplicate copy: an enabled `<name>@<other>` alongside `<name>@harness-pins` gives `note <name> is enabled twice (<other> and harness-pins); only one copy's hooks run. Disable one.`
  - `claude` missing or JSON unreadable gives one `note` and no plugin checks.
- Status adds `Catalog <n>`, the selected item count, and the not-installed plugin count.

- [ ] **Step 1: Write the failing tests**, one per line above, with a fake `pluginList`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/doctor.ts src/cli/status.ts test/cli/doctor.test.ts test/cli/status.test.ts`: `feat(doctor): catalog version, item drift and plugin version drift`.

### Task 22: End-to-end with a fake AI step

**Files:**
- Create: `test/e2e/recommend.e2e.test.ts`, `test/fixtures/ai/{answers.json,product.md,picks.json,report.md}`
- Test: same

- [ ] **Step 1: Write the test** `fake AI step through select, apply, update, remove, uninstall leaves the repo byte-identical`, on the `pnpmMonorepo` fixture (`test/e2e/fixtures.ts`) with `CLAUDECODE=1` and a fake `claude` on PATH that answers `plugin install` and `plugin list --json`:
  1. `validate answers`, `validate product`, `validate picks`, `validate report` all exit 0.
  2. `select --choose` with one own item, one plugin and one MCP item.
  3. `init ... --yes --install-plugins`: `.claude/settings.json` has `<name>@harness-pins`, `.mcp.json` has the server, the fake `claude` received `plugin install <name>@harness-pins --scope project --json`.
  4. Hook inputs piped into the installed dispatcher still give the beta decisions (reuse the existing helper).
  5. `update` with a catalog fixture where one item's sha changed: the plan shows it under "changed".
  6. `remove <mcp id> --yes`: `.mcp.json` is gone.
  7. `uninstall --yes`: `git status --porcelain` is empty and every pre-existing file is byte-identical.
- [ ] **Step 2: Run `pnpm vitest run --project e2e test/e2e/recommend.e2e.test.ts`.** It passes on the first run only if Tasks 1 to 21 are right; any failure is a bug in the owning task, fixed there.
- [ ] **Step 3: Run `pnpm test`** and confirm the full suite passes on the CI matrix after push (owner pushes).
- [ ] **Step 4: Commit** `test/e2e/recommend.e2e.test.ts test/fixtures/ai/`: `test(e2e): recommend flow through uninstall, byte-identical`.

### Task 23: Live runs, README and release notes (controller, owner approval before each batch)

**Files:**
- Modify: `README.md` (the `/harness:init` flow, teammate setup with the exact `claude plugin install` command, known limits: plugin picks are "local only" and missing in cloud sessions, `extraKnownMarketplaces` needs folder trust, MCP servers need each user's approval, Q6's IDE-terminal note). `HARNESS_PLAIN_INIT` stays out of it.
- Create: `docs/release-notes/<version>.md`
- Test: `test/package/readme.test.ts` (README does not contain `HARNESS_PLAIN_INIT`; release notes list every id in `catalog/excluded.yaml`)

- [ ] **Step 1: Ask the owner to approve batch 1** (a JS repo). On a local dummy repo under the scratchpad, never pushed: run real `/harness:init` in Claude Code with the plugin loaded via `--plugin-dir`. Record: every question asked, the subagent's raw output, whether validation passed first time, the checklist batching (the `AskUserQuestion` limits noted in Global constraints), the plan, and `claude plugin list --json` after `--install-plugins`. The git step runs `branch` and `commit` only; `push` and `pr` are run against a local bare remote, never GitHub.
- [ ] **Step 2: Owner judges the report and picks.** Record the verdict and any wrong pick as a finding against the rubric or catalog text, fixed in the owning task's files before the next batch.
- [ ] **Step 3: Batch 2** (a Python repo) and **batch 3** (a local copy of fitness-app, original untouched), each after its own approval, same records.
- [ ] **Step 4: Check that a teammate clone works:** clone the dummy repo locally, trust the folder, run the printed `claude plugin install` command, and confirm the plugin loads and `doctor` is clean.
- [ ] **Step 5: Write the README changes and the release notes.** The notes list: catalog version, item count, every excluded id with its reason (from `catalog/excluded.yaml`, including Q3's own items), unpinned items with reasons, and the known limits.
- [ ] **Step 6: Run `pnpm test`**, then request the final whole-branch review.
- [ ] **Step 7: Commit** `README.md docs/release-notes/ test/package/readme.test.ts`: `docs: M3 recommend README and release notes`.

## Owner actions this plan depends on

- Answer the Owner questions by the tasks named at the top of that section.
- Approve each live-run batch in Task 23.
- Push `feature/beta` after Task 22 so the CI matrix and the weekly pin check run, and merge when satisfied.
