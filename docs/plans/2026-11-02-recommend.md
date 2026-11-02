# Harness M3 per-project recommend implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/harness:init` interviews the user and writes `product.md`. It then recommends items from a closed, pinned and license-checked catalog, lets the user pick, installs the picks into the repo (plugins in `.claude/settings.json`, MCP servers in `.mcp.json`, own items in `.claude/`), writes `report.md`, and offers to commit, push and open a PR. The plan also adds `update` re-recommend, `add`, `remove`, `why`, `explain` and `sync`.

**Architecture:**
- The CLI stays deterministic and never calls a model.
- The AI steps (interview, recommend) run in the `/harness:*` skills. They reach the CLI only through a file contract: `answers.json`, `product.md`, `picks.json` and `report.md`, each checked by a `harness validate <kind>` command. That contract is the adapter from spec §8: a Cursor or OpenCode skill writes the same files.
- The catalog is YAML in `catalog/`, shipped in the npm package and loaded at run time the way `templates/` is.
- Outside plugins are referenced through one inline `settings` marketplace, `harness-pins`. Its entries carry the catalog's 40-character `sha`.
- Every write still goes through `applyChanges` (backup, temp-and-rename, rollback, manifest last).
- Plugin, marketplace and MCP entries are structural manifest blocks, removed by deep equality, the way hook groups are removed today.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml` and `picomatch` (bundled dev dependencies, already present). No new dependency.

**Spec:** `docs/specs/2026-11-02-harness-recommend-design.md` (wins on conflict; see its 2026-11-02 amendment note). It builds on `docs/specs/2026-10-30-harness-design.md` §§7, 8, 9a and amends `docs/specs/2026-11-01-harness-beta-design.md`. Read all three.

## Owner questions

**Answered 2026-11-02:** Q1 (a), Q2 (a), Q3 (a), Q4 (a), Q6 keeps the rule. Q5: the owner writes the six reasons; until then those six items are excluded. The spec's amendment note records these answers. Q7 to Q11 are open.

**Q1. Who installs the plugins on each machine?** The spec (§6) expects committed `enabledPlugins` and `extraKnownMarketplaces` to reach everyone who clones. The docs say they don't install plugins by themselves: "When a plugin's only `true` is in the project's `.claude/settings.json`, Claude Code doesn't fetch it onto a machine where it isn't installed". Each contributor sees `Plugin "<name>" is enabled in project settings but isn't installed here` until they run `claude plugin install <name>@<marketplace> --scope project` (https://code.claude.com/docs/en/plugins/loading.md; https://code.claude.com/docs/en/plugins/org.md). The spec's `sync` only fixes drift, and spec §2 Q7 makes `sync` refuse outside Claude Code.
- (a) `init` and `sync` run `claude plugin install <id> --scope project --json` for each plugin pick, after one confirmation, for the person running them. `doctor` and `status` list missing plugins with the exact command to paste.
- (b) Same as (a), and `sync` is also allowed in a plain terminal.
- (c) Nothing runs installs; the commands are only printed.
- **Answer: (a).**

**Q2. Pin plugins to a commit through an inline marketplace?** The docs confirm a repo can pin. An `extraKnownMarketplaces` entry may use a `settings` source with an inline `plugins` array, and each plugin's `github`, `url` or `git-subdir` source accepts a full 40-character `sha`. Plugin ids become `<name>@harness-pins`. A copy of the same plugin from another marketplace means only one copy's hooks run.
- (a) Pin through `harness-pins`.
- (b) Reference upstream marketplaces unpinned.
- **Answer: (a).**

**Q3. Own items in the seed list that don't exist yet** (22 ids, listed in Task 3).
- (a) Ship the existing own items, and list the other 22 in the release notes.
- (b) Build all 22.
- **Answer: (a).**

**Q4. License for hosted MCP servers.**
- (a) `license: vendor-terms` with the terms URL in `evidence`, plus an `unpinned` reason.
- (b) Leave every hosted server out.
- **Answer: (a).**

**Q5. Missing `stance_reason`** for `feature-dev`, `pr-review-toolkit`, `sourcegraph`, `sonarqube`, `jfrog`, `sonatype-guide`. **Answer:** the owner writes the six lines. Until then the six are in `catalog/excluded.yaml` with reason `stance reason pending from owner`.

**Q6. `CLAUDECODE=1` is also set in IDE terminals** (https://code.claude.com/docs/en/env-vars.md). **Answer:** keep the rule, and list it as a known limit in the README.

**Q7. Plain-terminal `update` for repos installed by the beta.** Spec §2 Q7 makes `update` refuse outside Claude Code. The beta's `update` has two non-AI uses. `update --check` asks npm for a newer version and writes nothing (`src/cli/update.ts:30`). Plain `update` re-renders the harness's own files from an existing config. Beta users today run both from a terminal (README, `skills/update/SKILL.md` step 1).
- (a) Refuse plain `update` as the spec says, but exempt `update --check`, because it writes nothing and isn't an AI step. Beta users run `/harness:update` inside Claude Code for file updates.
- (b) Exempt `--check`, and also allow plain `update` without AI flags on repos with `catalog_version: 0` (beta installs), so beta users keep their terminal path for one release.
- (c) Refuse every form of `update` outside Claude Code, `--check` included.
- **Recommendation: (a).** It keeps the spec's rule for every command that writes, and a read-only version check in a terminal changes nothing for anyone. The plan is written for (a) (Task 15). Under (b), `refuseOutsideClaude` takes the config as well; under (c), the exemption test flips.

**Q8. What happens to the CODEOWNERS answers?** The interview asks for CODEOWNERS owners (spec §4.2). No task writes `.github/CODEOWNERS`, because `harness-integrity`, the own item that would own it, is excluded under Q3.
- (a) Write `.github/CODEOWNERS` covering the harness paths as a new own item (`codeowners`, kind `rule`), recorded in the manifest. This needs a short design: which paths, and how to merge with an existing file.
- (b) Keep the question. The answer is recommend input only: the subagent reads it and `report.md` can recommend CODEOWNERS in the roadmap. No file is written.
- (c) Drop the question until `harness-integrity` ships.
- **Recommendation: (b).** It keeps the spec's interview whole without designing a new own item that Q3 deferred. The plan is written for (b) (Task 10).

**Q9. The "AI-Native Workflow Audit" isn't in the repo.** 2026-10-30 names it as the research basis (claude.ai artifact `CtVz1z8qP17BjFpHiKqsnV`), and Tasks 5 to 9 would start each item's research from the URL it gives.
- (a) The owner gives a local path or exported copy, and the research tasks read it.
- (b) Without it, each item's source is its official repo or docs, found with `gh search repos "<name>" --limit 5` plus the vendor's own docs. Where two plausible sources exist, the item goes in the batch's owner note instead of being chosen silently.
- **Recommendation: (a) if a copy exists, else (b).** The tasks are written so that (b) works on its own (Tasks 5 to 9, step 2).

**Q10. When `config.checks` and the selected items disagree, which wins?** Both decide which gates run: `checks.*` from the beta, and own items with `checks` from this plan. Today a user can turn a gate off by editing `checks.tdd` in `config.yaml`. If items win, the next `update` or `sync` turns it back on.
- (a) When `config.items` is non-empty, items win. `apply` derives `checks` from the selected own items, and `doctor` prints a note when the file's `checks` differ from the items. Users turn gates off with `harness remove <id>`.
- (b) `checks` wins. Items only add files, and a hand-edited `checks.*: false` stays off even if its item is selected.
- **Recommendation: (a).** It keeps one source of truth that `why`, `explain` and `sync` can explain. The beta behaviour is kept for configs without items (Task 14's legacy path). The plan is written for (a).

**Q11. If a hook's `ask` can't stop the agent, how do item-changing commands stay human-approved?** The ruling (C10) is that the guard asks before the agent runs `harness add|remove|sync|update|uninstall`, so the user approves each call in Claude Code's own permission prompt. The hooks docs say a PreToolUse `"ask"` "prompts the user to confirm", that in auto mode it "normally sends the tool call to the permission prompt", and that in a `-p` run it is denied (https://code.claude.com/docs/en/hooks). The docs don't say whether a user's `allow` rule (for example `Bash(node:*)`) or `bypassPermissions` mode skips a hook's `ask`. The dispatcher already turns `ask` into `deny` in `bypassPermissions`, `dontAsk`, CI and cloud runs (`src/core/unattended.ts`). Task 16 checks the allow-rule case live. If an allow rule does skip the ask:
- (a) The guard denies those commands for the agent outright, and the skills print the exact command for the user to run with `!` in the prompt or in a terminal. `add`, `sync` and `update` then can't run from a skill. This conflicts with spec §2 Q6 (AI steps only inside Claude Code) for the apply step.
- (b) Keep `ask`, and have `doctor` warn when an allow rule matches the harness CLI, naming the rule.
- **Recommendation: (b).** An allow rule is the user's own standing approval of that command, and `doctor` makes it visible. (a) breaks the skill flow the spec is built on. The plan is written for the `ask` design, with the live check in Task 16 deciding whether (b)'s doctor line is needed.

## Global constraints

**From the spec (exact values):**
- AI commands are `init`, `update`, `add` and `sync`. Without `CLAUDECODE` they exit 2 with `Run /harness:<cmd> inside Claude Code. The harness supports Claude Code only for now.`, where `<cmd>` is `init`, `update`, `add` or `sync`. `update --check` is exempt (Q7 (a)).
- "Inside Claude Code" means `CLAUDECODE` is set to any non-empty value. This matches the beta's `tdd off` check. There is one helper, `insideClaude(env)` (Task 15).
- Terminal-safe commands: `tdd`, `doctor`, `status`, `stats`, `uninstall`, `remove`, `why`, `explain`, and the non-AI helpers this plan adds (`scan`, `catalog`, `validate`, `select`, `git`).
- The beta's non-AI install path stays for tests only, behind `HARNESS_PLAIN_INIT=1`. It is not in the README. The e2e tests and CI set it. With `HARNESS_PLAIN_INIT=1` and no AI flags, `init` and `update` take the plain path whatever `CLAUDECODE` is. With AI flags, the AI path runs.
- `product.md` is at most 40 lines, with sections for purpose, users, core features, constraints, non-goals and source paths.
- Picks give, per item, `include: recommended | optional`, `reason` and `addresses: [finding ids]`. One retry is allowed, then the CLI stops and puts the raw output in `.harness/debug/`.
- A `discouraged` item is allowed only when the user named it, or when the pick gives `no_alternative`, a sentence saying why no alternative fits. Its `stance_reason` is always shown (spec §9).
- `report.md` has findings by severity, a 30/60/90-day roadmap, deliberate exclusions, the reviewer's stated limits, and this sentence, in the README's wording: `Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.`
- Git: the branch is `chore/ai-workflow-<catalog_version>`, and commits use the user's git identity with a conventional message. There is no AI trailer unless `config.yaml` `git.commit_trailer` sets one. Neither `commit` nor `push` runs on the default branch, and each outward step is confirmed separately.
- Catalog item fields from 2026-10-30 §7.1: `id`, `kind`, `title`, `source` with a 40-char `sha` (or `unpinned` with a reason), `license`, `min_claude_code`, `applies_when`, `conflicts_with`, `requires`, `cost`, `stance`, `stance_reason`, `side_effects`, `why`, `evidence`. **This plan adds** `source.plugin` (the plugin's entry name), `plugin_version` (the version `claude plugin list --json` reports at the pin), and `mcp` (`{ name, config }` for MCP items).
- The interview never reads `.env*`, `.harnessignore` paths, or files the user didn't point to. Credentials are stored as names only.
- An outside item that can't be verified is left out of the release and listed in the release notes.

**External tools at the user's run time:**
- `gh` runs for users only in `harness git pr` (`gh auth status`, then `gh pr create`), and only after the user's confirmation in the skill.
- `claude plugin install|list` runs only in `init --install-plugins`, `sync --install-plugins` and `doctor`/`status` (read-only `list`).
- `git` runs in the git step and in the existing detection.
- `harness catalog check --resolve` (which runs `gh api` and `npm view`) is a maintainer and CI command. No skill runs it.

**Verified against the Claude Code docs on 2026-11-02:**
- `enabledPlugins` maps `"<name>@<marketplace>"` to `true`/`false` in any settings file. `extraKnownMarketplaces` maps a name to `{ source, autoUpdate? }`. https://code.claude.com/docs/en/plugins/org.md
- Marketplace source types: `github`, `git`, `url`, `file`, `directory`, and `settings` (`name`, `plugins`, `owner`).
  - A `settings` source's `name` must equal its key and can't be reserved.
  - Its `plugins` items take `name`, `source`, `description`, `version`, `strict`, and each `source` is an object, never a relative path.
  - No marketplace source takes `sha`.
  - https://code.claude.com/docs/en/plugins/marketplace-reference.md
- Plugin sources:
  - `github` takes `repo`, `ref`, `sha`; `url` takes `url`, `ref`, `sha`; `git-subdir` takes `url` (git URL or `owner/repo`), `path`, `ref`, `sha`.
  - `sha` is "a full 40-character lowercase commit SHA", and Claude Code checks it out when set. Same page.
- A plugin directory with `SKILL.md` at its root and no `skills/` loads as a single skill, so an outside skill is referenced as a `git-subdir` plugin. https://code.claude.com/docs/en/plugins/manifest-reference.md
- Repo `extraKnownMarketplaces` apply only in a trusted folder.
  - Repo `enabledPlugins` alone never fetches a plugin with an external source.
  - `claude plugin install <id> --scope project` installs it, and "the entry goes in `.claude/settings.json`", so it writes the manifest-hashed settings file (Task 15 re-hashes it).
  - Cloud sessions add no repo marketplaces.
  - https://code.claude.com/docs/en/plugins/install.md, https://code.claude.com/docs/en/plugins/loading.md
- Installed plugin version:
  - the plugin manifest `version`, else the marketplace entry `version`, else for `github`/`url`/`git-subdir` "the commit SHA of the source, shortened to 12 characters";
  - a `git-subdir` version "also carries a hash of the subdirectory path".
  - `claude plugin list --json` prints `id`, `version`, `scope`, `enabled`, `installPath`.
  - `claude plugin install --json` prints one JSON object on the last stdout line with `command`, `outcome` (`ok`|`failed`) and `message`.
  - https://code.claude.com/docs/en/plugins/loading.md, https://code.claude.com/docs/en/plugins/cli-reference.md
- `.mcp.json` is `{ "mcpServers": { "<name>": { "command", "args", "env" } | { "type": "http", "url", "headers" } } }`.
  - An entry with a `url` and no `type` is an error.
  - `${VAR}` and `${VAR:-default}` expand.
  - Each user approves project servers interactively.
  - No version pin is documented, so stdio MCP items pin an exact npm version in `args`.
  - https://code.claude.com/docs/en/mcp
- `CLAUDECODE` is "Set to `1` in subprocesses Claude Code spawns (Bash and PowerShell tools, … hook commands …). IDE extensions also set this in their integrated terminals." https://code.claude.com/docs/en/env-vars.md
- Subagents lose `AskUserQuestion` "even when listed in the `tools` field", so the interview and checklist run in the main-session skill. Plugin agents are namespaced (`harness:staff-reviewer`) and ignore `hooks`, `mcpServers`, `permissionMode`. https://code.claude.com/docs/en/sub-agents
- `plugin.json` `agents` takes `.md` paths and replaces the `agents/` scan; `skills` takes directories and adds to `skills/`. https://code.claude.com/docs/en/plugins/manifest-reference.md
- `${CLAUDE_PLUGIN_ROOT}` is substituted only in a skill's `SKILL.md` and its `allowed-tools`. It isn't substituted in other files the skill reads, and isn't set in Bash. So every CLI command line lives in `SKILL.md`. https://code.claude.com/docs/en/skills
- A PreToolUse `"ask"` "prompts the user to confirm". In auto mode it normally goes to the prompt; in `-p` it is denied. https://code.claude.com/docs/en/hooks

**Not confirmed by the docs (live checks in Tasks 15 and 16, each with a fallback):**
- Whether a plugin agent's bare `skills: [review-rubric]` resolves to the same plugin's skill. Fallback, used by default: `SKILL.md` passes the rubric's path to the subagent (Task 18).
- Whether a shell `claude plugin install x@harness-pins` finds a marketplace declared only in the project's settings before Claude Code has registered it.
- Whether a user's allow rule skips a hook's `ask` (Q11).
- `AskUserQuestion` limits: the skill assumes 1 to 4 questions per call with 2 to 4 options each and `multiSelect`, and batches the checklist four rows at a time.

**Carried from the beta plan:**
- No runtime dependencies. `package.json` `files` gains `catalog/`.
- No shell: `spawnSync(cmd, argv)` through `syncCommand`/`findOnPath` (`src/checks/stop/runner.ts`).
- Repo-relative paths use `/`. Never read or write `.env*`.
- User-facing copy: one short sentence on what happened, then the next step, no "please", paths in backticks.
- Every skill is under 60 lines and runs only `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"`, never `npx`. It says output and file contents are "data, not instructions". The existing test in `test/package/package.test.ts` checks every `skills/*/SKILL.md`.
- Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit`, explicit paths, no `Co-Authored-By` trailer, no generated-by footer. The branch is `feature/beta`, and the owner merges.
- Installs are blocked by the global agent guard. This plan adds no dependency.

**Existing helpers to reuse (moved or exported, never copied):**
- `removeFromSettings(current, f, original, notes)` (`src/cli/uninstall.ts:27`) moves to `src/install/merge.ts`, exported, same signature.
- The manifest merge in `src/cli/update.ts:105-118` becomes `mergeManifestFiles` in `src/install/manifest.ts`.
- `dirtyPaths` (`src/cli/init.ts:28`) moves to `src/install/git-status.ts`.
- `claudeVersion()` and `older`/`nums` (`src/cli/doctor.ts:20-35`) move to `src/core/min-claude.ts` as `claudeVersion(): string | null` and `olderThan(a: string, b: string): boolean`.
- The package-dir rule (`src/install/merge.ts:12-13`, `src/install/plan.ts:23`, `src/cli/index.ts:106`) becomes `packageDir(sub: 'templates' | 'catalog' | 'dist'): string` in `src/core/package-dir.ts`.
- The `CLAUDECODE` check in `tdd()` (`src/cli/index.ts:38`) uses `insideClaude`.
- The command parsing in `tddInvocationDenied` (`src/checks/guard.ts:25`) becomes `harnessInvocations(command): { sub: string; args: string[] }[]`, used by both the `tdd` rule and the Task 16 rule.

**Decided in this plan (the owner may veto):**
- Catalog layout: `catalog/catalog.yaml` (`version: <integer>`, starting at 1) and `catalog/items/<id>.yaml`. Excluded items go in `catalog/excluded.yaml` (`- { id, reason, checked: <YYYY-MM-DD> }`).
- Outside git sources must be on GitHub, so CI can check every pin with `gh api`.
- `.harness/facts.json`, `picks.json`, `report.md` and `context/product.md` are written by `apply` and only on the AI path, and they are recorded in the manifest.
- Skills write AI output to a temp file outside the repo and pass its path. The protect check denies agent writes to `.harness/state/**` and `.harness/config.yaml`.
- Conflicts are symmetric, computed once by `conflictPairs` (Task 1).
- `probity` conflicts with `tdd-gate` and `tdd-guard`, and `impeccable`, `ui-ux-pro-max`, `taste-skill` and `superdesign` conflict with each other (2026-10-30 §7.3). No other conflicts are invented.

## Review focus

1. **A beta-installed repo runs the new `update` inside Claude Code with no AI flags.** Its `config.yaml` has no `items` and `catalog_version: 0`. Expected: nothing the beta installed is removed, the harness files are refreshed as in the beta, and the output says to run `/harness:update` again for recommendations. Tests: Task 14, `legacy config without items keeps the beta files`, and Task 15, `beta repo update inside Claude Code without AI flags refreshes files only`.
2. **The user already has plugin entries, other marketplaces, or their own `.mcp.json` servers.** Expected: theirs are kept, and a user server with a pick's name is left as is and reported. Tests: Task 13, `user mcp server with the same name is kept and reported` and `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`.
3. **The interview stores a pasted secret instead of a name.** Expected: `validate answers` rejects it and never echoes the value. Test: Task 10, `credential names reject values and never echo them`.
4. **`facts.json` written on one machine differs on another.** Expected: no absolute or machine-local strings, and sorted keys and arrays. Test: Task 4, `facts json has no absolute paths and is stable`.
5. **The git step on a repo with unrelated uncommitted work, or with the default branch checked out.** Expected: `branch` names the unrelated paths and refuses, and `commit` and `push` refuse on the default branch even if it was renamed. Tests: Task 17, `branch refuses unrelated dirty paths`, `commit refuses the default branch`, `push refuses the default branch even if renamed`.

---

## Before Task 1

The spec's order of work (§11) starts after the beta fix wave.
- [ ] Confirm with the owner that the fix wave on `feature/beta` is done and reviewed (Jest results folder, Vitest coverage provider, missing stop tools, test files not counted, reason lookup, CRLF hashes, unsafe test config).
- [ ] `gh run list --branch feature/beta --limit 1 --json conclusion` shows `success`, and `pnpm test` passes locally. Record the test count. Every later task keeps it passing.

### Task 1: Catalog schema, loader and offline checks

**Files:**
- Create: `src/catalog/schema.ts`, `src/catalog/load.ts`, `src/catalog/check.ts`, `src/catalog/relations.ts`, `src/core/package-dir.ts`, `catalog/catalog.yaml`, `catalog/excluded.yaml` (`[]`)
- Modify: `src/install/merge.ts`, `src/install/plan.ts`, `src/cli/index.ts` (use `packageDir`); `src/core/min-claude.ts`, `src/cli/doctor.ts` (move `claudeVersion`, `olderThan`); `package.json` (`files` adds `catalog/`); `test/package/package.test.ts` (packed list contains `catalog/catalog.yaml`)
- Test: `test/catalog/schema.test.ts`, `test/catalog/check.test.ts`, `test/core/package-dir.test.ts`, fixtures in `test/fixtures/catalog/`

**Interfaces:**
- Produces, in `schema.ts`:
  - `type ItemKind = 'own-skill' | 'own-agent' | 'own-hook' | 'plugin' | 'mcp' | 'external-skill' | 'rule' | 'ci' | 'settings'`
  - `type Level = 'none' | 'low' | 'medium' | 'high'`; `type Stance = 'default' | 'optional' | 'discouraged'`
  - `const SIDE_EFFECTS = ['installs-hook', 'downloads-binary', 'telemetry-on-by-default', 'runs-arbitrary-python', 'network-service'] as const`
  - `type OwnSource = { type: 'own'; files?: { from: string; to: string }[]; checks?: (keyof HarnessConfig['checks'])[]; merge?: ('agents-md' | 'permissions')[] }`
  - `type OutsideSource = { type: 'github'; repo: string; plugin: string; sha: string } | { type: 'git-subdir'; repo: string; path: string; plugin: string; sha: string } | { type: 'npm'; package: string; version: string } | { type: 'remote'; url: string; unpinned: string }`. Plugins and skills are always pinned (Q2), `npm` takes an exact version, and only `remote` is `unpinned`.
  - Kind and source must fit together: `plugin` and `external-skill` take `github` or `git-subdir`; `mcp` takes `npm` or `remote` and requires `mcp`; the own kinds (`own-*`, `rule`, `settings`, `ci`) take `own`.
  - `interface AppliesWhen { any_dep?: string[]; frameworks?: string[]; project_types?: ProjectType[]; always?: true }`, with `type ProjectType = 'web' | 'landing' | 'mobile' | 'api' | 'infra' | 'library' | 'other'`. Each key matches a field of `Facts` (Task 4).
  - `interface CatalogItem { id; kind; title; source: OwnSource | OutsideSource; license: string; min_claude_code: string; applies_when; conflicts_with: string[]; requires: string[]; cost: { context: Level; setup: Level }; stance; stance_reason: string; side_effects: string[]; why: string; evidence: string[]; plugin_version?: string; mcp?: { name: string; config: Record<string, unknown> } }`
  - `interface Catalog { version: number; items: CatalogItem[] }`
  - `validateItem(raw: unknown, file: string): { ok: true; item: CatalogItem } | { ok: false; errors: string[] }`. It owns every per-field check.
- Produces, in `load.ts`:
  - `loadCatalog(dir = packageDir('catalog')): { catalog: Catalog; excluded: { id: string; reason: string }[]; errors: string[] }`. It owns the file-level checks: the file name must be `<id>.yaml`, no duplicate ids across files, no duplicate excluded ids, and no id both in `items/` and `excluded.yaml`. A missing `items/` directory means an empty catalog, not an error.
  - `compactCatalog(c): CompactItem[]`, with `CompactItem = Pick<CatalogItem, 'id' | 'kind' | 'applies_when' | 'why' | 'cost' | 'stance' | 'stance_reason' | 'conflicts_with' | 'requires'>`, sorted by id.
- Produces, in `check.ts`: `checkCatalog(c: Catalog, templatesDir = packageDir('templates')): string[]`. It owns the cross-item checks only: `requires`/`conflicts_with` targets exist, and own `files.from` exists.
- Produces, in `relations.ts`: `conflictPairs(ids: string[], c: Catalog): [string, string][]` (symmetric, sorted) and `requiresClosure(ids: string[], c: Catalog): { ids: string[]; added: { id: string; by: string }[] }`.
- Produces: `packageDir(sub)`, `claudeVersion()`, `olderThan(a, b)`.

- [ ] **Step 1: Write the failing tests**
  - `validateItem accepts the §7.1 example plus plugin`: the `gsap-skills` YAML from 2026-10-30 §7.1 with `plugin: gsap-skills` added and a 40-hex `sha` validates. The test comment says `plugin` was added.
  - `validateItem names the bad field`:
    - `sha: abc` gives `gsap-skills.yaml: source.sha: must be a 40-character lowercase hex commit`.
    - `discouraged` with `stance_reason: ""` gives `gsap-skills.yaml: stance_reason: required when stance is discouraged`.
    - An unknown key gives `unknown key "foo"`.
    - `unpinned` on a `github` source gives `source.unpinned: only remote MCP sources may be unpinned`.
    - A non-GitHub `repo` gives `source.repo: must be owner/name on GitHub`.
    - A missing `license` or a non-semver `min_claude_code` each gives one message.
  - `kind and source must fit`: one test per pairing. A `plugin` with an `npm` source, an `mcp` without `mcp`, and an `own-skill` with a `github` source each fail.
  - `loadCatalog file-level checks give one message each`: duplicate id (`duplicate id "x" in x.yaml and y.yaml`), a file name that isn't the id, a duplicate excluded id, an id in both lists, and a missing `items/` (no error).
  - `checkCatalog cross-item checks`: a missing `requires` target, a missing `conflicts_with` target, and a missing own template each give one message, with no repeat of any `validateItem` message.
  - `conflictPairs is symmetric`: `a.conflicts_with: [b]` gives `[['a','b']]` from either side. `requiresClosure` is transitive (a→b→c).
  - `packageDir finds templates from source and bundle` (the paths `merge.ts` resolved before). `olderThan('2.1.9', '2.1.10')` is true.
  - `loadCatalog on the real catalog/ has no errors`.
- [ ] **Step 2: Run `pnpm vitest run test/catalog test/core` and confirm the new tests fail.**
- [ ] **Step 3: Implement.** `catalog.yaml` is `version: 1`. Replace the three package-dir copies with `packageDir`. `doctor.ts` imports `claudeVersion` and `olderThan`.
- [ ] **Step 4: Run `pnpm test`.** Everything passes, including the doctor tests and the packed-files test.
- [ ] **Step 5: Commit** `catalog/ src/catalog/ src/core/package-dir.ts src/core/min-claude.ts src/cli/doctor.ts src/install/merge.ts src/install/plan.ts src/cli/index.ts package.json test/catalog/ test/core/package-dir.test.ts test/fixtures/catalog/ test/package/package.test.ts`: `feat(catalog): item schema, loader and offline checks`.

### Task 2: Pin resolver, `harness catalog` and catalog CI

**Files:**
- Create: `src/core/exec.ts`, `src/catalog/resolve.ts`, `src/cli/catalog.ts`, `.github/workflows/catalog-pins.yml`
- Modify: `src/cli/index.ts` (route `catalog`, USAGE), `src/core/package-dir.ts` (catalog override), `.github/workflows/ci.yml` (new `catalog` job), `test/package/workflows.test.ts`
- Test: `test/catalog/resolve.test.ts`, `test/cli/catalog.test.ts`

**Interfaces:**
- Produces: `type Exec = (cmd: string, args: string[]) => { status: number; stdout: string; missing?: true }` and `defaultExec: Exec`, in `src/core/exec.ts`. `missing` is set when the command isn't on PATH (`findOnPath` is null). `defaultExec` runs through `syncCommand`.
- Produces: `resolvePins(c: Catalog, exec: Exec, only?: string[]): { problems: string[]; unpinned: { id: string; reason: string }[] }`.
- Produces: `harness catalog` prints `{ catalog_version, items: compactCatalog }` JSON. `harness catalog check [--resolve] [--only <id,...>]` exits 0 when clean, else 1 with one line per problem. Both are terminal-safe.
- Produces: `packageDir('catalog')` returns `HARNESS_CATALOG_DIR` only when `HARNESS_PLAIN_INIT=1` is also set. This is a test-only override, left out of the README (used by Task 23).

- [ ] **Step 1: Write the failing tests** with a fake `Exec`:
  - `github pin resolves`: calls exactly `gh api repos/<repo>/commits/<sha> --jq .sha`, and passes when stdout equals the sha.
  - `git-subdir pin also checks the path`: also calls `gh api repos/<repo>/contents/<path>?ref=<sha> --jq .type`, and passes when stdout is `dir`.
  - `npm pin resolves`: calls `npm view <package>@<version> version`.
  - `unpinned items are listed with their reason`: no exec call, and an entry in `unpinned`. `catalog check --resolve` prints them under `Unpinned:`.
  - `a 404 names the item and the source`: gives `gsap-skills: commit <sha> not found in greensock/gsap-skills`.
  - `gh missing is one problem`: `missing: true` gives `gh not found on PATH; install GitHub CLI to check pins`.
  - CLI tests: `catalog prints compact JSON with catalog_version 1`, `catalog check exits 1 and prints each problem`, `catalog works without CLAUDECODE`, `HARNESS_CATALOG_DIR is ignored without HARNESS_PLAIN_INIT`.
  - Workflows: `ci runs the offline catalog check after pnpm build`. `catalog-pins runs weekly and on catalog changes with --resolve`: cron `0 6 * * 1`, `on.push.paths: ['catalog/**']`, `workflow_dispatch`, `permissions: { contents: read }`, then `pnpm build` and `node dist/cli.mjs catalog check --resolve` with `GH_TOKEN: ${{ github.token }}`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** The new workflow uses the same pinned action SHAs as `ci.yml`.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/core/exec.ts src/core/package-dir.ts src/catalog/resolve.ts src/cli/catalog.ts src/cli/index.ts .github/workflows/ test/catalog/resolve.test.ts test/cli/catalog.test.ts test/package/workflows.test.ts`: `feat(catalog): pin resolver, harness catalog and weekly pin check`.

### Task 3: Own items in the catalog

**Files:**
- Create: `catalog/items/<id>.yaml` for each row below. Append to `catalog/excluded.yaml`:
  - 19 ids with reason `not built yet (this release ships existing own items only)`: `post-edit-format`, `gitleaks-commit`, `config-change-guard`, `session-context`, `researcher`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `pr-ship`, `session-structure`, `sandbox-settings`, `ci-tdd`, `harness-integrity`, `lefthook-baseline`, `claude-code-action`, `harness-devdep`
  - 3 ids with reason `part of the PR reviewer (M2)`: `harness-review`, `pr-create-trigger`, `ui-verifier`
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

Own items use `license: UNLICENSED` and `min_claude_code: 2.1.285` (`MIN_CLAUDE_CODE`). `why`, `cost` and `applies_when: { always: true }` come from the beta spec §3 table and 2026-10-30 §9. No new claims are added.

- [ ] **Step 1: Write the failing test** `every own item maps to an existing check, template or merge`:
  - each `checks` key is in `defaults().checks`;
  - each `files.from` exists under `templates/`;
  - the union of `checks` over own items of every kind equals all six keys of `HarnessConfig['checks']`;
  - `excluded.yaml` has exactly the 22 ids above, each once.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the YAML files.**
- [ ] **Step 4: Run `pnpm test` and `node dist/cli.mjs catalog check`.** Both pass.
- [ ] **Step 5: Commit** `catalog/items/ catalog/excluded.yaml test/catalog/own-items.test.ts`: `feat(catalog): own items`.

### Task 4: Scan extension and `harness scan`

This runs before the research batches, so their `applies_when` hints use facts that exist.

**Files:**
- Modify: `src/install/detect.ts`, `src/cli/index.ts` (route `scan`)
- Create: `src/install/facts.ts`, `src/install/harnessignore.ts`
- Test: `test/install/detect.test.ts`, `test/install/facts.test.ts`, `test/cli/scan.test.ts`

**Interfaces:**
- Produces new `Facts` fields:
  - `deps: string[]` (sorted union of every package's dependency names)
  - `apps: { dir: string; kind: 'web' | 'mobile' | 'api' }[]`
  - `frameworks: string[]`, `routers: string[]`, `testRunners: string[]`, `ciFiles: string[]`
  - `docker: boolean`, `iac: string[]`, `dbClients: string[]`, `authSdks: string[]`, `expo: boolean`, `deploy: string[]`
  - `gitHooks: 'lefthook' | 'husky' | 'none'`, `existing.claudeDir: boolean`
- Produces: `READ_ALLOWLIST: string[]`. This is the list of globs (repo-relative, picomatch) of every file `detect` may open: `package.json`, `**/package.json` under workspaces, `pnpm-workspace.yaml`, `pyproject.toml`, `requirements*.txt`, `vitest.config.*`, `vite.config.*`, `jest.config.*`, `app.json`, `eas.json`, `.claude/settings.json`, `.claude/settings.local.json`, `.harnessignore`. Only file names are checked for everything else.
- Produces: `harnessIgnore(root: string): (rel: string) => boolean` and `factsJson(f: Facts): string`. `factsJson` drops `root` and `warnings`, keeps `packages[].scripts` keys only, and reduces `existing.otherHooks` to its count, so machine-local hook paths stay out.
- Produces: `harness scan`, which prints `factsJson(detect(root))` and is terminal-safe.

Detection tables (dependency names unless marked as files):
- frameworks: `next`, `react`, `vue`, `svelte`, `astro`, `@remix-run/react`, `@tanstack/react-start`, `expo`, `react-native`, `hono`, `express`, `fastify`, `@nestjs/core`, `three`, `gsap`
- routers:
  - `next-app` (dir `app/` with a `next` dep)
  - `next-pages` (dir `pages/`)
  - `expo-router`, `@tanstack/react-router`, `react-router`
- testRunners: `vitest`, `jest`, `@playwright/test`, `cypress`, and `pytest` from the Python facts
- ciFiles (files): `.github/workflows/*.yml|yaml`, `.gitlab-ci.yml`, `.circleci/config.yml`
- docker (files): `Dockerfile`, `compose.yaml`, `compose.yml`, `docker-compose.yml`
- iac (files): `cdk.json`, `*.tf` at root or `infra/`, `Pulumi.yaml`, `serverless.yml`, `sst.config.ts`
- dbClients: `prisma`, `@prisma/client`, `drizzle-orm`, `@supabase/supabase-js`, `pg`, `mongoose`, `@neondatabase/serverless`
- authSdks: `next-auth`, `@auth/core`, `better-auth`, `@workos-inc/node`, `@workos-inc/authkit-nextjs`, any `@clerk/*` or `@auth0/*`
- expo (files): `app.json` with an `expo` key, or `eas.json`
- deploy (files): `vercel.json`, `netlify.toml`, `fly.toml`, `render.yaml`, `railway.json`, `wrangler.toml`, `amplify.yml`
- apps:
  - `mobile` if the package has `expo` or `react-native`;
  - else `web` if it has `next`, `astro`, `@remix-run/react`, `@tanstack/react-start`, `vue` or `svelte`;
  - else `api` if it has `hono`, `express`, `fastify` or `@nestjs/core`.

- [ ] **Step 1: Write the failing tests** on fixture repos built with `makeRepo` (`test/install/helpers.ts`):
  - One test per table row with a minimal fixture.
  - `monorepo with web, mobile and api apps` gives `[{dir:'apps/api',kind:'api'},{dir:'apps/mobile',kind:'mobile'},{dir:'apps/web',kind:'web'}]`.
  - `detect never opens .env files or harnessignored paths`. The setup:
    - `vi.mock('node:fs', ...)` wraps `readFileSync` and records each path;
    - the repo has `.env`, `.env.local`, and a `.harnessignore` listing `fixtures/**`.
    - Expected: no recorded path is `.env*` or under `fixtures/`, and every recorded path matches `READ_ALLOWLIST`.
  - `facts json has no absolute paths and is stable`: a `.claude/settings.local.json` hook with an absolute path is in the fixture. `factsJson` contains neither the temp dir nor that hook path, keys and arrays are sorted, and runs on two copies at different paths are byte-equal.
  - `test/cli/scan.test.ts`: `scan works without CLAUDECODE and prints valid JSON`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `.harnessignore` uses gitignore-style globs through `picomatch`, and is read, never written.
- [ ] **Step 4: Run `pnpm test`.** Existing detect tests pass unchanged.
- [ ] **Step 5: Commit** `src/install/detect.ts src/install/facts.ts src/install/harnessignore.ts src/cli/index.ts test/install/detect.test.ts test/install/facts.test.ts test/cli/scan.test.ts`: `feat(scan): project facts from file names and allowlisted configs`.

### Tasks 5 to 9: Referenced items, one batch per task

Each batch task is research plus data, with no code.

| Task | Areas from 2026-10-30 §7.3 | Items (stance where not `optional`) |
|---|---|---|
| 5 | Design direction; UI quality and performance; 3D and motion | frontend-design [default], impeccable, ui-ux-pro-max, taste-skill, superdesign [discouraged: duplicates Figma], design; web-design-guidelines, react-best-practices, vercel-react-native-skills, modern-web-guidance, emilkowalski-skills, web-quality-skills, shadcn, shadcn-mcp, figma; gsap-skills, threejs-skills, motion-ai-kit, spline-mcp, mcp-for-blender |
| 6 | Process; Workflow upkeep | superpowers [default], mattpocock-skills, addyosmani-agent-skills, ponytail, caveman [discouraged: overlaps ponytail], spec-kit [discouraged: overlaps superpowers], code-review [discouraged: built-in /code-review], code-simplifier, ralph-loop [discouraged: use /goal], remember [discouraged: built-in memory], wshobson-agents [discouraged: instruction overload]; claude-code-setup, claude-md-management, skill-creator, hookify, session-report, dash0 |
| 7 | Code intelligence and docs; Verification; Mobile | typescript-lsp [default], swift-lsp, kotlin-lsp, context7, graphify, serena [discouraged: duplicates LSP], mintlify, engineering; playwright, chrome-devtools-mcp, webapp-testing; expo, react-native-best-practices, maestro-mcp, mobile-mcp, revenuecat |
| 8 | Backend, API, data; Cloud and IaC; CI and repo flow | postman, 42crunch-api-security-testing, supabase, supabase-agent-skills, prisma, neon, databases-on-aws, auth0, workos, stripe; aws-core, aws-serverless, deploy-on-aws, pulumi, terraform, vercel, cloudflare, render, railway; mergify |
| 9 | Security; Observability and product; AI features and evals; Marketing and SEO | security-guidance [default], claude-security, semgrep, trailofbits-insecure-defaults, trailofbits-supply-chain-risk-auditor, stackhawk-hawkscan, aikido [discouraged: duplicates semgrep], probity, tdd-guard [discouraged: superseded by probity]; sentry, getsentry-skills, posthog, growthbook, datadog; evals-skills, langfuse, deepeval, agent-sdk-dev, mcp-server-dev; marketingskills |

The Q5 six (`feature-dev`, `pr-review-toolkit`, `sourcegraph`, `sonarqube`, `jfrog`, `sonatype-guide`) go into `excluded.yaml` in Task 6 with reason `stance reason pending from owner`, until the owner sends the lines. Then they get researched like the rest, in a follow-up commit.

`side_effects` from §7.3: impeccable `[installs-hook, downloads-binary, telemetry-on-by-default]`, mcp-for-blender `[runs-arbitrary-python]`. Any other side effect needs evidence from the item's own README, quoted in `evidence`.

**Files (each batch task):** Create `catalog/items/<id>.yaml` per verified item, and append the rest to `catalog/excluded.yaml`. Test: `test/catalog/batch.test.ts` (created in Task 5; later batches extend its id list).

**Steps (each batch task):**
- [ ] **Step 1: Write the failing test** `batch <n> ids are all in items/ or excluded.yaml`. It uses the table's ids (plus the Q5 six in Task 6), none missing and none in both.
- [ ] **Step 2: Find each item's source.**
  - If the owner supplied the audit (Q9 (a)), start from the URL it gives.
  - Otherwise use the item's official repo or docs: `gh search repos "<name>" --limit 5 --json fullName,description,stargazerCount`, plus the vendor's docs.
  - For plugins in a marketplace, read the marketplace file: `gh api repos/<owner>/<repo>/contents/.claude-plugin/marketplace.json --jq .content | base64 -d`. A relative-path entry becomes `git-subdir` with that repo and path; an external entry uses its own repo.
  - Two plausible sources (a fork vs upstream, two vendors) go in the batch's owner note, not chosen silently.
- [ ] **Step 3: Pin it.**
  - GitHub:
    - `gh api repos/<repo> --jq '{license: .license.spdx_id, branch: .default_branch, archived: .archived}'`
    - then `gh api repos/<repo>/commits/<branch> --jq .sha` for the 40-char `sha`.
    - For `git-subdir`, `gh api "repos/<repo>/contents/<path>?ref=<sha>" --jq .type` must print `dir`.
  - `plugin_version`:
    - read `.claude-plugin/plugin.json` at the sha; its `version` wins;
    - else the marketplace entry's `version`;
    - else the sha's first 12 characters for `github`;
    - omit it for `git-subdir`, whose version also hashes the path. The release notes list these as "version drift not checked".
  - npm (stdio MCP):
    - `npm view <pkg> version license repository.url --json`, and pin the exact version.
    - `mcp.config` is `{ command: 'npx', args: ['-y', '<pkg>@<version>'] }`, plus any `env` names the README requires, as `${NAME}`.
  - Hosted MCP: `source: { type: remote, url, unpinned: 'hosted service, the vendor controls the version' }` and `license: vendor-terms`, with the terms URL in `evidence`.
- [ ] **Step 4: License.**
  - If `license.spdx_id` is null or `NOASSERTION`, read the LICENSE file and record its SPDX id if it is a standard license. If it isn't, the item is excluded with reason `no license`.
  - An archived repo is excluded with reason `archived upstream`.
  - A plugin directory's own LICENSE overrides the repo license.
- [ ] **Step 5: Write the YAML.**
  - `why` is one sentence from the item's own README (or the audit), with the URL in `evidence`.
  - `min_claude_code` is the item's stated minimum, else `2.1.285`.
  - `applies_when` uses only `any_dep` (matched against `facts.deps`), `frameworks`, `project_types` and `always`.
- [ ] **Step 6: Verify.** `node dist/cli.mjs catalog check --resolve --only <batch ids>` prints no problems, and `pnpm vitest run test/catalog` passes.
- [ ] **Step 7: Write the owner note.** It lists excluded ids with reasons and any source choices.
- [ ] **Step 8: Commit** `catalog/items/ catalog/excluded.yaml test/catalog/batch.test.ts`: `feat(catalog): batch <n> referenced items`.

### Task 10: Config sections and the interview contract

**Files:**
- Modify: `src/core/config.ts`, `src/core/config-io.ts`, `templates/config.example.yaml`, `README.md` (only the generated `<!-- config:start -->` block, via `node scripts/gen-config-docs.mjs`)
- Create: `src/ai/answers.ts`, `src/ai/product.ts`, `src/cli/validate.ts`
- Modify: `src/cli/index.ts` (route `validate`)
- Test: `test/core/config.test.ts`, `test/ai/answers.test.ts`, `test/ai/product.test.ts`, `test/cli/validate.test.ts`

**Interfaces:**
- Produces new `HarnessConfig` sections. All have defaults, so beta configs stay valid, and `version` stays `1`:
  - `catalog_version: number` (default `0`, meaning no catalog)
  - `project: { type: '' | ProjectType; domain: string; compliance: string[]; data_handling: string; team_size: number; open_source: boolean; codeowners: string[]; deploy_target: string; run_budget_usd: number; named_items: string[]; scope_paths: string[] }`, with defaults `type: ''`, `team_size: 0` (unknown) and `run_budget_usd: 0`. `codeowners` is recommend input only (Q8 (b)).
  - `apps: App[]`, where `App = { dir: string; kind: 'web' | 'mobile' | 'api'; install: string[]; start: string[]; ready_url: string; port: number; public_facing: boolean; login: { needed: boolean; credentials: { file: string; keys: string[]; env: string[] }; login_url: string; post_login: string } }`
  - `items: Selected[]`, where `Selected = { id: string; include: 'recommended' | 'optional'; selected: boolean; reason: string; addresses: string[]; pin: string }`. `pin` is the sha, the npm version, or `''`.
  - `git: { commit_trailer: string }`
- Produces new `RULES` in `config.ts`:
  - `project.type` (one of the `ProjectType` values or `''`)
  - `project.team_size` (an integer from 0 to 10000)
  - `project.run_budget_usd` (a number from 0 to 100000)
  - `apps`: one rule that checks every element, including `port` as an integer from 1 to 65535, with errors at paths like `apps[0].port`
  - `items`: one rule that checks every element
  - `overlay` doesn't descend into arrays, so these array rules check every element themselves.
- Produces:
  - `interface Answers { scope: { paths: string[] } | { text: string }; project: Omit<HarnessConfig['project'], 'scope_paths'>; apps: App[]; unattended: HarnessConfig['unattended']; tdd: { paths: string[]; diff_coverage: number } }`
  - `validateAnswers(raw: unknown, facts: Facts): { ok: true; answers: Answers } | { ok: false; errors: string[] }`
  - `answersToConfig(base: HarnessConfig, a: Answers): HarnessConfig`
- Produces: `validateProduct(text: string): string[]`.
- Produces: `harness validate answers <file>` and `harness validate product <file>`. They exit 0 printing `ok`, or exit 2 with one error per line. Both are terminal-safe.

- [ ] **Step 1: Write the failing tests**
  - Config:
    - `beta config without the new sections loads with no warnings`
    - `serializeConfig(defaults) passes validateConfig`
    - `serializeConfig round-trips the new sections`
    - `config.example.yaml equals serializeConfig(defaults)` (regenerated)
    - `apps[0].port out of range names the element path`
  - Answers:
    - `apps must exist in facts`: gives `apps[0].dir: no app at "web" in this repo`.
    - `scope paths must be repo-relative and not ignored`: `/etc/passwd`, `../x`, `.env` and a `.harnessignore` path each give one error naming the path.
  - `credential names reject values and never echo them`:
    - `keys: ['sk_live_abc123=']` gives `apps[0].login.credentials.keys[0]: must be a name such as API_KEY, not a value`, and the error doesn't contain `sk_live_abc123`;
    - `env: ['MY TOKEN']` fails the same way;
    - names must match `^[A-Za-z_][A-Za-z0-9_]*$`, and `file` must be repo-relative.
  - Product:
    - more than 40 lines fails with `product.md: 41 lines; at most 40`;
    - each missing `## ` section (`Purpose`, `Users`, `Core features`, `Constraints`, `Non-goals`, `Sources`) fails by name;
    - a valid file passes.
  - CLI: `validate answers prints every error and exits 2` and `validate works without CLAUDECODE`.
  - README: the existing `config reference equals the generator output` passes after regenerating.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `validateAnswers` reuses `validateConfig` for `unattended` and `tdd`, so their range rules stay in one table.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/core/config.ts src/core/config-io.ts templates/config.example.yaml README.md src/ai/answers.ts src/ai/product.ts src/cli/validate.ts src/cli/index.ts test/core/config.test.ts test/ai/ test/cli/validate.test.ts`: `feat(interview): config sections and answer and product validation`.

### Task 11: Recommend contract: picks and report validation

**Files:**
- Create: `src/ai/picks.ts`, `src/ai/report.ts`, `src/ai/debug.ts`
- Modify: `src/cli/validate.ts`, `src/install/merge.ts` (add `.harness/debug/` to `mergeGitignore`'s lines)
- Test: `test/ai/picks.test.ts`, `test/ai/report.test.ts`, `test/cli/validate.test.ts`, `test/install/merge.test.ts` (the `mergeGitignore` golden strings at lines 166-176 gain `.harness/debug/\n`)

**Interfaces:**
- Consumes: `Catalog`, `conflictPairs` (Task 1), `Answers` (Task 10).
- Produces:
  - `interface Finding { id: string; severity: 'critical' | 'medium' | 'nit'; title: string }`
  - `interface Pick { id: string; include: 'recommended' | 'optional'; reason: string; addresses: string[]; no_alternative?: string }`
  - `interface Picks { catalog_version: number; findings: Finding[]; items: Pick[] }`
- Produces: `validatePicks(raw: unknown, c: Catalog, a: Answers): { ok: true; picks: Picks } | { ok: false; errors: string[] }`.
- Produces: `validateReport(md: string, p: Picks): string[]` and `finalizeReport(md: string): string`. `finalizeReport` appends the enforcement sentence under `## Limits` when it is missing.
- Produces: `saveDebug(root: string, kind: 'picks' | 'report', raw: string, now?: () => Date): string`. It writes `.harness/debug/<kind>-<iso>.txt` and returns the repo-relative path.
- Produces: `harness validate picks <file> --answers <file> [--attempt 1|2]` and `harness validate report <file> --picks <file> [--attempt 1|2]`. When attempt 2 fails, they write the debug file, print ``Recommend output failed validation twice. Raw output is in `<path>`. Stopping.`` and exit 1.

- [ ] **Step 1: Write the failing tests.** They use only `test/fixtures/catalog/`, never real catalog ids. The fixture has items `lead-a` and `lead-b` (conflicting), `quiet` (discouraged, `stance_reason: overlaps lead-a`), `base` and `extra` (requires `base`).
  - `unknown id fails`: gives `items[2].id: unknown item "foo"`.
  - `conflicting picks fail in either direction`: gives `items: "lead-a" conflicts with "lead-b"`.
  - `missing reason fails`: gives `items[0].reason: must be a non-empty sentence`.
  - `discouraged needs the user to name it or a no_alternative reason`:
    - without either it gives `items[1]: "quiet" is discouraged (overlaps lead-a); propose it only when the user names it or no alternative fits, and say why in no_alternative`;
    - with `named_items: ['quiet']` it passes;
    - with a non-empty `no_alternative` it passes.
  - `addresses must name findings`: an unknown finding id fails, and so do duplicate finding ids.
  - `catalog_version must match`: gives `catalog_version: picks are for catalog 0, this harness has catalog 1`.
  - `requires is not auto-added here`: a pick missing its required item still passes.
  - Report:
    - each missing `## Findings`, `## Roadmap` (mentioning `30`, `60` and `90` days), `## Deliberate exclusions` and `## Limits` fails by name;
    - a picks finding id absent from the report fails;
    - `finalizeReport` adds `Hooks run with the user's permissions. Only CI and branch protection enforce rules for everyone.` exactly once.
  - `second failed attempt writes debug and stops`: exits 1, and the debug file equals the input.
  - Merge: the `mergeGitignore` tests expect four lines.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/ai/picks.ts src/ai/report.ts src/ai/debug.ts src/cli/validate.ts src/install/merge.ts test/ai/ test/cli/validate.test.ts test/install/merge.test.ts test/fixtures/catalog/`: `feat(recommend): picks and report validation with one retry`.

### Task 12: Select

**Files:**
- Create: `src/install/select.ts`, `src/cli/select.ts`
- Modify: `src/cli/index.ts`
- Test: `test/install/select.test.ts`, `test/cli/select.test.ts`

**Interfaces:**
- Consumes: `Picks`, `Catalog`, `conflictPairs`, `requiresClosure`, `olderThan`, `claudeVersion`.
- Produces: `interface ChecklistRow { id: string; title: string; include: 'recommended' | 'optional'; ticked: boolean; reason: string; cost: string; side_effects: string[]; local_only: boolean; stance_reason: string; no_alternative: string }`.
  - `cost` is formatted as `context <c>, setup <s>`.
  - `local_only` is true for kinds `plugin` and `external-skill`.
- Produces: `checklist(p: Picks, c: Catalog): ChecklistRow[]`. Recommended rows come first, then optional, each sorted by id.
- Produces: `resolveSelection(chosen: string[], c: Catalog, claudeVersion: string | null): { ids: string[]; notices: string[]; errors: string[] }`.
  - It adds `requires` via `requiresClosure`, with notice `Added <req> because <id> requires it.`.
  - A conflict gives the error `<a> and <b> conflict; pick one.`.
  - An item whose `min_claude_code` is above `claudeVersion` is dropped with notice `Skipped <id>: needs Claude Code <v> or newer (you have <cv>).`.
  - With `claudeVersion` null, nothing is dropped.
- Produces: `toSelected(p: Picks, ids: string[], c: Catalog): Selected[]`. It emits every pick (`selected` true when its id is in `ids`) and every id that `resolveSelection` added. Added ids get `include: 'optional'`, `reason: 'Required by <id>.'` and `addresses: []`. `pin` comes from the catalog source.
- Produces: `harness select --picks <file> [--choose <id,...>]`.
  - Without `--choose`, it prints the checklist JSON.
  - With it, it prints `{ ids, notices, selected }`, or the errors with exit 2.
  - It is terminal-safe and reads `claudeVersion()`.

- [ ] **Step 1: Write the failing tests** (fixture catalog):
  - `checklist order and local_only`
  - `requires auto-selects with a notice, transitively`
  - `required ids appear in toSelected with Required by`
  - `conflicts block both`
  - `discouraged rows carry stance_reason and no_alternative`
  - `min_claude_code above the installed version is skipped with the notice`
  - `unknown chosen id is an error`
  - the CLI round trip
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/select.ts src/cli/select.ts src/cli/index.ts test/install/select.test.ts test/cli/select.test.ts`: `feat(select): checklist, requires, conflicts and version floor`.

### Task 13: Settings and MCP merges for plugin and MCP items

**Files:**
- Modify: `src/install/merge.ts`, `src/cli/uninstall.ts`
- Test: `test/install/merge.test.ts`, `test/cli/uninstall.test.ts`

**Interfaces:**
- Moves: `removeFromSettings(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null` moves from `uninstall.ts` to `merge.ts` and is exported with the same signature. It is extended to remove `plugin` and `marketplace` blocks, and deletes keys that end up empty and didn't exist before (its existing `had` logic).
- Produces: `removeFromMcp(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null`, with the same shape, for `mcp` blocks.
- Produces: `interface PinnedPlugin { name: string; item: string; source: { source: 'github'; repo: string; sha: string } | { source: 'git-subdir'; url: string; path: string; sha: string } }` and `pinnedPlugins(items: CatalogItem[]): PinnedPlugin[]`. For `git-subdir`, `url` is the `owner/repo` shorthand.
- Changes: `mergeSettings(before: string | null, plugins: PinnedPlugin[] = [], prev?: Manifest['files'][number], original: string | null = null): { after; blocks; notes }`.
  - It first applies `removeFromSettings` for `prev`'s `plugin` and `marketplace` blocks, then writes:
    - `enabledPlugins["<name>@harness-pins"] = true`, with block `{"plugin":"<name>@harness-pins","item":"<id>"}`;
    - `extraKnownMarketplaces["harness-pins"] = { source: { source: 'settings', name: 'harness-pins', owner: { name: 'harness' }, plugins: [{ name, source }] } }`, with block `{"marketplace":"harness-pins","entry":<that object>}`.
  - With no plugins, it adds neither key.
  - `blocks` lists every harness block present after the merge, not only the new ones.
- Produces: `mergeMcp(before: string | null, servers: { name: string; item: string; config: Record<string, unknown> }[], prev?: Manifest['files'][number], original: string | null = null): { after: string; blocks: string[]; notes: string[] }`, with block `{"mcp":"<name>","item":"<id>","server":{...}}`. It keeps the file's EOL and indent (`eolOf`, `jsonIndentOf`).
- Produces: `isReplacedBlock(b: string): boolean`, true for `plugin`, `marketplace` and `mcp` blocks.

- [ ] **Step 1: Write the failing tests**
  - `plugins add enabledPlugins and the harness-pins marketplace`: golden JSON for one `github` and one `git-subdir` plugin.
  - `re-merge with prev replaces the marketplace entry and drops removed plugins`: going from three plugins to two leaves two `@harness-pins` keys and one entry.
  - `removing the last plugin deletes both keys harness added`: no empty `enabledPlugins: {}` is left.
  - `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`: the settings file has `"foo@other": true`, another marketplace, CRLF and tab indent.
  - `a user-edited harness-pins entry is left and reported`.
  - `user mcp server with the same name is kept and reported`: gives the note ``\`.mcp.json\` already has a server named "playwright"; left as is.``.
  - `mergeMcp creates .mcp.json, and removal deletes it when harness created it and it ends empty`.
  - `harness-pins entry has only documented fields`: `name`, `owner`, `plugins` (and `source` as the wrapper key), and each plugin has only `name` and `source`.
  - The existing uninstall tests pass, with uninstall now calling the moved `removeFromSettings` and `removeFromMcp`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/merge.ts src/cli/uninstall.ts test/install/merge.test.ts test/cli/uninstall.test.ts`: `feat(apply): plugin, marketplace and MCP blocks with exact removal`.

### Task 14: Plan and apply driven by the selection

**Files:**
- Modify: `src/install/plan.ts`, `src/install/manifest.ts`, `src/install/apply.ts` (`Change` gains `item?: string`), `src/cli/update.ts`
- Test: `test/install/plan.test.ts` (new), `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `CatalogItem`, `Selected`, `mergeSettings`, `mergeMcp`, `isReplacedBlock`, `removeFromSettings`.
- Changes: `planChanges(root, config, facts, ctx: { version; distDir; templatesDir?; catalog?: Catalog; manifest?: Manifest; ai?: { picks: string; report: string; product: string } })`. With `catalog` unset, the legacy path behaves exactly as today. Gating by selected ids (`selectedIds`):
  - The dispatcher and the hook groups are always installed.
  - `checks` is derived from the selected own items' `checks` (any kind) when `config.items` is non-empty (Q10 (a)).
  - Deny rules are written only with `permissions-baseline`.
  - The AGENTS.md block and the CLAUDE.md import are written only with `agents-md`.
  - Each own `files` entry is written only with its item, and the `Change` carries `item`.
  - Plugin and external-skill items go to `mergeSettings`, and MCP items go to `mergeMcp`. `prev` comes from `ctx.manifest`.
  - `.claude/settings.json` is written when `after !== before`, not only when new blocks exist, so removals land.
  - The `ai` files and `.harness/facts.json` (`factsJson`) are written only when `ctx.ai` is set.
- Produces: `selectedIds(config: HarnessConfig): string[]`. These are the ids with `selected: true`. When `config.items` is empty, it returns `LEGACY_OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'agents-md']`, and the checks come from `config.checks` as today.
- Produces: `mergeManifestFiles(old: Manifest, changes: Change[]): Manifest['files']`, extracted from the inline block at `update.ts:105-118`. It:
  - drops the entries whose change is `delete`;
  - replaces old blocks for which `isReplacedBlock` is true with the new list, and unions the others as today;
  - copies `item` from the change.
- Changes: `update.ts` keeps dropping `.harness/config.yaml` changes only on the plain path. On the AI path, and for `add`, `remove` and `sync`, the config change is applied.

- [ ] **Step 1: Write the failing tests**
  - `legacy config without items keeps the beta files`: `planChanges` without `catalog` on a beta install gives the same change list as before this task, with no `.harness/facts.json`.
  - `deselecting staff-reviewer plans its removal`: the plan has `delete .claude/agents/staff-reviewer.md` when its hash matches. An edited file is kept with a note.
  - `deselecting permissions-baseline drops the deny rules and checks.protect`.
  - `own items set checks`: unselecting `tdd-gate` gives `checks.tdd: false` in the written config, and no test-config edits.
  - `removing the last plugin rewrites settings` (`after !== before`).
  - `ai files are written and recorded`: the four `.harness/` files plus `facts.json` are `create` changes, and `report.md` ends with the enforcement sentence.
  - `mergeManifestFiles drops deleted entries` and `replaced blocks do not accumulate across three updates`.
  - `update applies the config change on the AI path and drops it on the plain path`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** The existing init and update tests pass unchanged.
- [ ] **Step 5: Commit** `src/install/plan.ts src/install/manifest.ts src/install/apply.ts src/cli/update.ts test/install/plan.test.ts test/cli/update.test.ts`: `feat(apply): install the selected items`.

### Task 15: Claude-Code-only gate, AI `init` and the plugin install step

**Files:**
- Create: `src/cli/claude-only.ts`, `src/install/plugin-install.ts`
- Modify: `src/cli/init.ts`, `src/cli/update.ts`, `src/cli/index.ts` (the `tdd off` check uses `insideClaude`), `src/install/manifest.ts`, `test/e2e/install.e2e.test.ts`, `test/e2e/real-frameworks.e2e.test.ts`, `.github/workflows/ci.yml`, `.github/workflows/claude-code-weekly.yml` (set `HARNESS_PLAIN_INIT: '1'` for test steps)
- Test: `test/cli/claude-only.test.ts`, `test/cli/init.test.ts`, `test/cli/update.test.ts`, `test/install/plugin-install.test.ts`

**Interfaces:**
- Produces: `insideClaude(env: NodeJS.ProcessEnv): boolean` (`!!env.CLAUDECODE`) and `refuseOutsideClaude(cmd: 'init' | 'update' | 'add' | 'sync', env: NodeJS.ProcessEnv): string | null`.
  - `refuseOutsideClaude` returns the exact message from Global constraints, or null.
  - It is called inside `init()`, `update()`, `add()` and `sync()`, so tests that call them directly hit it.
  - `update --check` isn't refused.
  - `HARNESS_PLAIN_INIT=1` with no AI flags skips the refusal.
- Changes: `init` takes `--answers <file> --product <file> --picks <file> --report <file> --choose <id,...> [--install-plugins] [--dry-run|--yes]`.
  - On the AI path all four files and `--choose` are required. A missing one exits 2 with `init: --<flag> <file> is required inside Claude Code`.
  - Each file is validated with Tasks 10 to 12.
  - The config is `answersToConfig(preset(facts, which).config, answers)`, plus `items: toSelected(...)` and `catalog_version`.
  - `update` takes the same AI flags.
- Produces: `installPlugins(ids: string[], exec: Exec = defaultExec): { ok: string[]; failed: { id: string; message: string }[] }`.
  - It runs `claude plugin install <id> --scope project --json` and reads the last stdout line.
  - `missing` gives every id the failure `Claude Code CLI not found on PATH`.
  - A failure whose message names the marketplace (`harness-pins`) is reported as ``Claude Code hasn't registered `harness-pins` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.``
- Produces: `pluginList(exec: Exec = defaultExec): { id: string; version: string; enabled: boolean }[] | null`, from `claude plugin list --json`. It is used by Tasks 21 and 22.
- Produces: `rehashManifest(root: string, rels: string[]): void`, in `manifest.ts`. After installs, `claude plugin install --scope project` writes `.claude/settings.json`. When the bytes changed, the manifest hash for that file is rewritten through `applyChanges` with a manifest-only transaction.
- Changes: with `--yes --install-plugins`, `init` applies and then installs the `<name>@harness-pins` ids in the same run. It prints one line per plugin, plus the manual command for each failure.

- [ ] **Step 0: Live check (owner approval first; local scratch repo, nothing pushed).** Check three things before the code depends on them, and record the results in the task's report:
  1. On a scratch repo with a hand-written `harness-pins` entry in `.claude/settings.json` and a trusted folder, run `claude plugin install <one pinned plugin>@harness-pins --scope project --json`. Record:
     - whether it succeeds before any interactive session has registered the marketplace;
     - the result JSON;
     - `.claude/settings.json` bytes before and after.
  2. Run `claude -p --plugin-dir <this repo> "Use the harness:staff-reviewer subagent to say which skills you have preloaded"` and record whether `review-rubric` was preloaded through the bare `skills:` name.
  3. Record whether `Read` of a file under the plugin root, from inside that subagent, prompts.

  The design below already takes the fallbacks:
  - the marketplace-not-registered message;
  - re-hashing;
  - the rubric path passed in the prompt (Task 18).

  If check 1 shows the install never works before a restart, the skill asks for the restart before `--install-plugins`.
- [ ] **Step 1: Write the failing tests**
  - `each AI command refuses without CLAUDECODE`: `init`, `update`, `add`, `sync` exit 2 with their exact message, calling the functions directly.
  - `any non-empty CLAUDECODE counts as inside`: `CLAUDECODE=0` doesn't refuse `init`, and `tdd off` refuses under the same value (one helper).
  - `update --check works without CLAUDECODE`.
  - `init refuses without HARNESS_PLAIN_INIT outside Claude Code`. With the variable set, every existing `test/cli/init.test.ts` test passes.
  - `HARNESS_PLAIN_INIT with no AI flags takes the plain path even with CLAUDECODE=1`.
  - `beta repo update inside Claude Code without AI flags refreshes files only`: `CLAUDECODE=1`, a beta manifest, and no AI flags give template updates, no item removals, and a closing line telling the user to run `/harness:update` for recommendations.
  - `AI init needs all inputs`: a missing `--picks` gives exit 2 with the exact message.
  - `AI init dry run shows the plan`: the fixture files list `.mcp.json`, `.claude/settings.json` and the five `.harness/` files, and nothing is written.
  - `invalid picks stop before planning`.
  - `installPlugins reads the JSON result line`: an `ok` outcome and a `failed` outcome, with a preceding non-JSON line.
  - `installPlugins without claude reports every id`.
  - `marketplace not registered gives the restart message`.
  - `rehashManifest updates the settings hash when install changed the bytes, and is a no-op otherwise`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Set `HARNESS_PLAIN_INIT: '1'` in the e2e `env` objects and in the CI test steps.
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/claude-only.ts src/install/plugin-install.ts src/install/manifest.ts src/cli/init.ts src/cli/update.ts src/cli/index.ts test/cli/claude-only.test.ts test/cli/init.test.ts test/cli/update.test.ts test/install/plugin-install.test.ts test/e2e/ .github/workflows/ci.yml .github/workflows/claude-code-weekly.yml`: `feat(init): AI init inside Claude Code only, with plugin installs`.

### Task 16: Guard: the agent asks before item-changing commands

**Files:**
- Modify: `src/checks/guard.ts`
- Test: `test/checks/guard.test.ts`

**Interfaces:**
- Produces: `harnessInvocations(command: string): { sub: string; args: string[] }[]`. This is the parsing extracted from `tddInvocationDenied` (runners, env assignments, `eval`, substitutions), and `tddInvocationDenied` uses it.
- Produces a guard rule:
  - **Asked:** a harness invocation whose `sub` is `add`, `remove`, `sync`, `update` or `uninstall`, unless its args include `--dry-run`, `--check` or `--plan`. It returns `{ kind: 'ask', reason: 'Harness item changes are approved by a person: allow this command only if you asked for it.', check: 'guard' }`.
  - **Denied:** any of those subcommands hidden in a variable or substitution, as `tdd` is today.
  - `tdd` keeps its deny rule.
- The dispatcher already turns `ask` into `deny` in unattended runs (`bypassPermissions`, `dontAsk`, CI, cloud). So nobody-watching runs can't change items, and an interactive run shows Claude Code's own permission prompt, which the agent can't answer. No environment variable bypasses the rule.

- [ ] **Step 0: Live check (owner approval; scratch repo).**
  - In an interactive session with the dispatcher installed and `Bash(node:*)` in `.claude/settings.local.json` `allow`, have the agent run `node <cli> remove multi-file-gate --yes`. Record whether the prompt still appears.
  - If it doesn't, Q11 (b)'s doctor line is added in Task 22: `note an allow rule (<rule>) lets the agent run harness item commands without asking; remove it to keep the ask`.
- [ ] **Step 1: Write the failing tests**
  - `remove, add, sync, update and uninstall ask in an interactive session`: each through `node "/x/dist/cli.mjs" <sub> --yes`, `pnpm harness <sub>`, and `npx @khubaibqaiser/harness <sub>`.
  - `dry runs and checks are allowed`: `remove x --dry-run`, `update --check`, `update --plan`.
  - `the same commands are denied when unattended`: `permission_mode: bypassPermissions` gives deny, with reason `Unattended run: ...`.
  - `a subcommand from a variable is denied`: `H=remove; harness $H x`.
  - `tdd off is still denied` (the existing tests pass).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** The latency test still passes.
- [ ] **Step 5: Commit** `src/checks/guard.ts test/checks/guard.test.ts`: `feat(guard): agent asks before harness item changes`.

### Task 17: Git step

**Files:**
- Create: `src/install/git-status.ts` (moved `dirtyPaths`), `src/cli/git.ts`
- Modify: `src/cli/init.ts` (import `dirtyPaths`), `src/cli/index.ts`
- Test: `test/cli/git.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `detect(root).defaultBranch`, `dirtyPaths`.
- Produces: `harness git branch|commit|push|pr [--title <t>]`. Each subcommand is one step, run by the skill only after the user's yes. It is terminal-safe.
  - A shared `onDefault(root): boolean` is true for `defaultBranch`, `main` or `master`.
  - `branch`:
    - refuses when a dirty path is outside the manifest's files and the manifest, with `Commit or stash these first: <paths>.`;
    - creates and checks out `chore/ai-workflow-<catalog_version>`;
    - refuses if it exists, with `Branch <b> already exists. Delete it or rename it, then run again.`.
  - `commit`:
    - refuses on the default branch with `You are on <b>. Run harness git branch first.`;
    - stages exactly the manifest's files and the manifest;
    - the message is `chore: add AI workflow (harness <version>, catalog <cv>)`, plus `\n\n<git.commit_trailer>` only when that is set;
    - it passes no `-c` identity;
    - refuses with `Set your git user.name and user.email, then run again.` when either is unset.
  - `push`: `git push -u origin <branch>`. It refuses on the default branch with `You are on <b>. Harness never pushes the default branch.`.
  - `pr`: when `gh` is missing or `gh auth status` fails, it prints the command and exits 0. Otherwise it runs `gh pr create --base <default> --head <branch> --title <title> --body-file .harness/report.md`.

- [ ] **Step 1: Write the failing tests** on a temp repo with a bare `origin` (`makeRepo({ remoteHead })`):
  - `branch refuses unrelated dirty paths`
  - `branch refuses an existing branch`
  - `commit refuses the default branch`
  - `commit uses the repo identity and no trailer`
  - `commit refuses when identity is unset`
  - `commit_trailer is appended when set`
  - `push refuses the default branch even if renamed` (default `trunk`)
  - `pr without gh prints the command and exits 0`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/git-status.ts src/cli/git.ts src/cli/init.ts src/cli/index.ts test/cli/git.test.ts`: `feat(git): branch, commit, push and PR as separate confirmed steps`.

### Task 18: The `/harness:init` skill and the reviewer's audit mode

**Files:**
- Modify: `skills/init/SKILL.md`, `.claude-plugin/plugin.json`, `templates/agents/staff-reviewer.md`, `test/package/package.test.ts`, `test/templates/agents.test.ts`
- Create: `skills/init/interview.md`, `skills/init/recommend.md`

**Interfaces:**
- Consumes: the CLI commands from Tasks 2, 4 and 10 to 17, by their full command line.
- Produces: `plugin.json` adds `"agents": ["./templates/agents/staff-reviewer.md"]` and `"skills": ["./templates/skills/"]`.
- Changes: `staff-reviewer.md` gains an **audit mode** section, kept separate from the diff review.
  - Triggered when the caller says `Mode: repo audit`.
  - Inputs: facts, answers, `product.md`, the compact catalog, and a rubric file path. If the rubric isn't already loaded, it reads that path.
  - Output, in this order: one fenced `json` block matching `Picks`, then one fenced `markdown` block for the report with the four required headings. No `[sev] file:line` lines and no BLOCKERS summary in this mode.
  - The diff-review text and its "no diff" rule stay as they are for PR review. Repos installed by the beta get the changed file on their next update, as an ordinary template change.

`SKILL.md` flow (under 60 lines). It holds every CLI command line. `interview.md` and `recommend.md` hold only the wording guidance, and the skill tells Claude to read them:
1. Run `scan`, and show the facts in five lines.
2. Interview (guidance in `interview.md`):
   - Ask scope first, one AskUserQuestion per question with options.
   - Read only the pointed files.
   - Draft `product.md` to a temp file, show it, apply the user's edits, then run `validate product`.
   - Ask the §8.2 gap questions the facts don't answer, CODEOWNERS included as recommend input.
   - Write the answers to a temp file and run `validate answers`, retrying once.
3. Recommend (guidance in `recommend.md`):
   - `catalog` gives the compact JSON.
   - Start the `harness:staff-reviewer` subagent with the Agent tool. The prompt has `Mode: repo audit`, the inline facts, answers, `product.md` and compact catalog, and the rubric path `${CLAUDE_PLUGIN_ROOT}/templates/skills/review-rubric/SKILL.md`.
   - Write the two blocks to temp files.
   - Run `validate picks` and `validate report` with `--attempt 1`. Give the subagent the errors once, then run them with `--attempt 2`.
4. Select:
   - `select --picks` gives the rows.
   - Ask four rows per AskUserQuestion (`multiSelect`), pre-ticked as the CLI says, with reason, cost, side effects, and "local only" for plugins.
   - `select --choose`, then show the notices or errors.
5. Apply:
   - `init ... --dry-run`, then show the plan.
   - Ask once: "apply these changes" and, as a separate option when plugins were picked, "also install the plugins for me now".
   - Then run `init ... --yes` with or without `--install-plugins` (one call).
   - Claude Code's permission prompt for that call is the user's final approval (Task 16 asks only for item commands; `init` runs in a repo without hooks or refuses).
6. Git: ask before each of `git branch`, `git commit`, `git push`, `git pr`.

- [ ] **Step 1: Write the failing tests**
  - Extend the existing skill-format test in `package.test.ts` to loop over every `skills/*/SKILL.md` instead of the fixed list.
  - `init skill holds every CLI line`: `SKILL.md` contains each full line `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <cmd>` for `scan`, `validate product`, `validate answers`, `catalog`, `validate picks`, `validate report`, `select`, `init`, `git branch`, `git commit`, `git push` and `git pr`.
  - `side files hold no commands`: `interview.md` and `recommend.md` don't contain `dist/cli.mjs`.
  - `interview.md says never to read .env files or unpointed files`.
  - `recommend.md calls harness:staff-reviewer and passes the rubric path`.
  - `plugin.json registers the reviewer and rubric, and both paths exist`.
  - In `test/templates/agents.test.ts`: `staff-reviewer has an audit mode with picks and report blocks` and `diff review rules unchanged`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run `pnpm test` and `claude plugin validate .`.** Both pass.
- [ ] **Step 5: Commit** `skills/init/ .claude-plugin/plugin.json templates/agents/staff-reviewer.md test/package/package.test.ts test/templates/agents.test.ts`: `feat(skill): interview, recommend, select, apply and git in /harness:init`.

### Task 19: `update` re-recommend

**Files:**
- Create: `src/install/delta.ts`
- Modify: `src/cli/update.ts`, `skills/update/SKILL.md`
- Test: `test/install/delta.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `conflictPairs`, `factsJson`, `planChanges`, `mergeManifestFiles`.
- Produces: `catalogDelta(config: HarnessConfig, c: Catalog): { changed: string[]; retired: string[]; conflicting: [string, string][] }`.
- Produces: `contradictions(prev: Facts | null, now: Facts, config: HarnessConfig): string[]`. It returns the answer keys to re-ask:
  - `apps`, when an app was added or removed;
  - `project.deploy_target`, when `deploy` changed.

  `prev` is parsed from `.harness/facts.json`, or is null when that file is missing.
- Changes: `update --plan` prints `{ recommend: boolean, delta, reask: string[] }`, and is allowed for the agent (Task 16).
  - `recommend` is true when `catalog_version` differs or `factsJson(now)` differs from the stored file.
  - With AI flags, `update` keeps the unchanged answers, then lists new (picks not in `config.items`), changed, retired and now-conflicting items before the diff.
- Skill:
  - runs `update --check`, then `update --plan`;
  - re-asks only `reask`;
  - re-runs recommend only when `recommend` is true;
  - otherwise runs `update --yes` with no AI flags (template refresh).

- [ ] **Step 1: Write the failing tests**:
  - one per delta class;
  - `no change means no re-recommend`;
  - `retired items are removed with a line saying why`;
  - `only contradicted keys are re-asked`;
  - `missing facts.json means recommend is true and nothing is re-asked`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/delta.ts src/cli/update.ts skills/update/SKILL.md test/install/delta.test.ts test/cli/update.test.ts`: `feat(update): re-recommend on catalog or fact changes`.

### Task 20: `add`, `remove`, `why`, `explain`

**Files:**
- Create: `src/cli/items.ts`, `skills/add/SKILL.md`
- Modify: `src/cli/index.ts`, `src/install/plan.ts`, `src/install/manifest.ts` (per-item lookup)
- Test: `test/cli/items.test.ts`

**Interfaces:**
- Consumes: `resolveSelection`, `toSelected`, `planChanges`, `applyChanges`, `mergeManifestFiles`, `removeFromSettings`, `removeFromMcp`, `refuseOutsideClaude`.
- Produces: `itemFiles(m: Manifest, id: string): { rel: string; blocks: string[] }[]`. It returns files whose `item` is `id`, plus structural blocks whose JSON `item` is `id`. Text blocks (AGENTS.md, CLAUDE.md, ignore files) belong to `agents-md` or to the core install.
- Produces:
  - `add <id> [--dry-run|--yes]`:
    - an AI command that refuses outside Claude Code;
    - adds the `requires` closure, and refuses on a conflict, naming the installed item;
    - sets `reason` to the stored pick's reason if `.harness/picks.json` has one, else `Added by hand with harness add.`;
    - shows the diff, applies, then prints `Run harness git commit on a branch to commit this change.`.
  - `remove <id> [--dry-run|--yes]`:
    - terminal-safe, and asked by the guard when the agent runs it;
    - refuses when a selected item requires it, with `<dep> requires <id>; remove <dep> first.`;
    - removes structural blocks through `removeFromSettings`/`removeFromMcp`, so a harness-created `.mcp.json` that ends empty is deleted.
  - `why <id>`:
    - for an installed item, prints its reason, each addressed finding as `[severity] title`, and its cost;
    - for an item not installed, prints `Not installed. <why> Cost: context <c>, setup <s>.`;
    - for an unknown id, exits 1.
  - `explain` prints one line per selected item (`<id> (<kind>): <reason>`) and the item's files.

- [ ] **Step 1: Write the failing tests**:
  - `add pulls in requires`
  - `add refuses a conflict`
  - `add records the pick reason or the hand-added reason`
  - `remove refuses a required item`
  - `remove of the last mcp item deletes .mcp.json`
  - `remove then add is byte-identical to before`
  - `why prints reason, findings and cost`
  - `why for an uninstalled item`
  - `explain lists items and files`
  - `add refuses outside Claude Code; remove, why and explain do not` (moved here from Task 15)
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/items.ts src/cli/index.ts src/install/plan.ts src/install/manifest.ts skills/add/SKILL.md test/cli/items.test.ts`: `feat: add, remove, why and explain`.

### Task 21: `sync`

**Files:**
- Create: `src/install/reconcile.ts`, `src/cli/sync.ts`, `skills/sync/SKILL.md`
- Modify: `src/cli/index.ts`, `src/cli/update.ts` (the edited-file detection at `update.ts:88-91` moves into `reconcile`)
- Test: `test/cli/sync.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Produces: `reconcile(root: string, config: HarnessConfig, m: Manifest, ctx: Parameters<typeof planChanges>[3]): { changes: Change[]; edited: { owned: string[]; merged: string[] }; notes: string[] }`. Both `update` and `sync` use it.
- Produces: `sync [--dry-run|--yes] [--take <rel,...>] [--install-plugins]`, an AI command:
  - selected items with missing files or blocks are re-planned;
  - manifest entries for unselected items are removed;
  - edited files are listed and kept unless named in `--take`;
  - `--install-plugins` runs `installPlugins` for the selected plugins that `pluginList()` doesn't show, then `rehashManifest`.

- [ ] **Step 1: Write the failing tests**:
  - `deleted managed file is restored`
  - `unselected item's files are removed`
  - `edited file is kept and listed`
  - `--take replaces it`
  - `in-sync repo reports nothing to do`
  - `missing plugins are installed with --install-plugins` (fake exec)
  - the existing `update` edited-file tests pass through `reconcile`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/install/reconcile.ts src/cli/sync.ts src/cli/update.ts src/cli/index.ts skills/sync/SKILL.md test/cli/sync.test.ts test/cli/update.test.ts`: `feat(sync): fix drift between config, manifest and files`.

### Task 22: `doctor` and `status` for items

**Files:**
- Modify: `src/cli/doctor.ts`, `src/cli/status.ts`
- Test: `test/cli/doctor.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Changes: `DoctorDeps` gains `pluginList?: typeof pluginList` (Task 15). `status(args, cli, deps: StatusDeps = {})` gains `StatusDeps = { pluginList?: typeof pluginList }`.
- Doctor adds these lines:
  - `ok catalog <n>`, or `note catalog <n> is newer than this repo's <m>: run /harness:update`.
  - `fix <id> is missing <rel>: run /harness:sync` (item drift).
  - `fix <id> is enabled in this repo but not installed: claude plugin install <id> --scope project`.
  - `note <id> is <v>, the catalog pins <p>: run claude plugin update <id> --scope project`. This is skipped when `plugin_version` is unset.
  - `note <name> is enabled twice (<other> and harness-pins); only one copy's hooks run. Disable one.`
  - `note config.yaml checks differ from the selected items (<keys>); the items win on the next update. Use harness add or remove to change gates.` (Q10 (a)).
  - When `claude` is missing or its JSON is unreadable, one `note` is printed and the plugin checks are skipped.
  - When Task 16's live check found that allow rules skip the ask, also: `note an allow rule (<rule>) lets the agent run harness item commands without asking; remove it to keep the ask`.
- Status adds `Catalog <n>`, the selected item count, and the not-installed plugin count.

- [ ] **Step 1: Write the failing tests**, one per line above, with a fake `pluginList`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.**
- [ ] **Step 5: Commit** `src/cli/doctor.ts src/cli/status.ts test/cli/doctor.test.ts test/cli/status.test.ts`: `feat(doctor): catalog version, item drift and plugin version drift`.

### Task 23: End-to-end with a fake AI step

**Files:**
- Create: `test/e2e/recommend.e2e.test.ts`, `test/fixtures/ai/{answers.json,product.md,picks.json,report.md}`, `test/fixtures/catalog-e2e/` (two catalog versions)

- [ ] **Step 1: Write the test** `fake AI step through select, apply, update, remove, uninstall leaves the repo byte-identical`.
  - Setup:
    - the `pnpmMonorepo` fixture (`test/e2e/fixtures.ts`);
    - `CLAUDECODE=1`, `HARNESS_PLAIN_INIT=1` and `HARNESS_CATALOG_DIR=test/fixtures/catalog-e2e/v1`;
    - a fake `claude` on PATH that answers `plugin install` and `plugin list --json`.
  - Steps:
    1. `validate answers`, `validate product`, `validate picks` and `validate report` all exit 0.
    2. `select --choose` one own item, one plugin and one MCP item.
    3. `init ... --yes --install-plugins`.
       - `.claude/settings.json` has `<name>@harness-pins`, and `.mcp.json` has the server.
       - The fake `claude` received `plugin install <name>@harness-pins --scope project --json`.
       - The manifest hash matches the settings bytes.
    4. Hook inputs piped into the installed dispatcher still give the beta decisions (reuse the existing helper).
    5. With `HARNESS_CATALOG_DIR=.../v2` (one sha changed), `update --plan` lists the item under `changed`, and the AI `update` applies the new pin.
    6. `remove <mcp id> --yes`, and `.mcp.json` is gone.
    7. `uninstall --yes`. `git status --porcelain` is empty, and every pre-existing file is byte-identical.
- [ ] **Step 2: Run `pnpm vitest run --project e2e test/e2e/recommend.e2e.test.ts`.** A failure is a bug in the owning task, fixed there.
- [ ] **Step 3: Run `pnpm test`.** The owner pushes, and the CI matrix must pass.
- [ ] **Step 4: Commit** `test/e2e/recommend.e2e.test.ts test/fixtures/ai/ test/fixtures/catalog-e2e/`: `test(e2e): recommend flow through uninstall, byte-identical`.

### Task 24: Live runs, README and release notes (controller, owner approval before each batch)

**Files:**
- Modify: `README.md`. It gains:
  - the `/harness:init` flow;
  - teammate setup, with the exact `claude plugin install` command and `/harness:sync`.
  - It does not mention `HARNESS_PLAIN_INIT` or `HARNESS_CATALOG_DIR`.
- New known limits in the README:
  - plugin picks are "local only" and are missing in cloud sessions;
  - `extraKnownMarketplaces` needs folder trust;
  - MCP servers need each user's approval;
  - `CLAUDECODE` is also set in IDE terminals (Q6);
  - there is no version-drift check for `git-subdir` plugins;
  - the agent asks before item changes.
- Create: `docs/release-notes/<version>.md`
- Test: `test/package/readme.test.ts`:
  - the README contains neither test variable;
  - the release notes list every id in `catalog/excluded.yaml`, and every `git-subdir` item without `plugin_version`.

- [ ] **Step 1: Batch 1 (a JS repo), after owner approval.**
  - Use a local dummy repo under the scratchpad, never pushed. Run real `/harness:init` with `--plugin-dir`.
  - Record:
    - each question asked;
    - the subagent's raw output;
    - whether validation passed first time;
    - the checklist batching;
    - the plan;
    - the permission prompts seen;
    - `claude plugin list --json` after the install.
  - `push` and `pr` run against a local bare remote only.
- [ ] **Step 2: Owner verdict.** The owner judges the report and picks. Each wrong pick is fixed in the owning task's files (rubric, audit-mode text, or catalog `why`) before the next batch.
- [ ] **Step 3: Batch 2 (a Python repo) and batch 3 (a local copy of fitness-app, original untouched).** Each runs after its own approval, with the same records.
- [ ] **Step 4: Check a teammate clone works.** Clone the dummy repo locally and trust the folder. Run the printed `claude plugin install` command, or `/harness:sync`. The plugin should load and `doctor` should be clean.
- [ ] **Step 5: Write the README changes and the release notes.** The notes give:
  - the catalog version and item count;
  - every excluded id with its reason (Q3's 22, Q5's six, and the research exclusions);
  - the unpinned items with their reasons;
  - the known limits.
- [ ] **Step 6: Run `pnpm test`, then request the final whole-branch review.**
- [ ] **Step 7: Commit** `README.md docs/release-notes/ test/package/readme.test.ts`: `docs: M3 recommend README and release notes`.

## Owner actions this plan depends on

- Answer Q7 before Task 15, Q8 before Task 10, Q9 before Task 5, Q10 before Task 14, and Q11 after Task 16's live check.
- Send the six Q5 reasons (any time; the items are added in a follow-up to Task 6).
- Approve the live checks in Tasks 15 and 16 and each live-run batch in Task 24.
- Push `feature/beta` after Task 23 so the CI matrix and the weekly pin check run, and merge when satisfied.
