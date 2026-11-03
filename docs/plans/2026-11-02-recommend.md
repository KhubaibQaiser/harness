# Harness M3 per-project recommend implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Refreshed 2026-11-03** against the platform-enforcement stack (PRs #13 to #19, slices S1 to S7, tip `feature/pe-7-doctor-status`; S8 and S9 add tests and the README only). File paths, signatures and line refs below are checked against that code. S8 adds one line to `src/install/plan.ts` and one to `src/cli/uninstall.ts`, so refs in those two files may be off by one on S9's tip. The refresh also adds the owner's context-budget requirement (2026-11-03) as a thin hook point (Task 13). Task numbers changed: see "Task map" below.

**Goal:** `/harness:init` interviews the user and writes `product.md`. It then recommends items from a closed, pinned and license-checked catalog, lets the user pick, installs the picks into the repo (plugins in `.claude/settings.json`, MCP servers in `.mcp.json`, own items in `.claude/`), writes `report.md`, and offers to commit, push and open a PR. The plan also adds `update` re-recommend, `add`, `remove`, `why`, `explain` and `sync`. Before any install grows harness's always-loaded context past the budget, the user is asked.

**Architecture:**
- The CLI stays deterministic and never calls a model.
- The AI steps (interview, recommend) run in the `/harness:*` skills. They reach the CLI only through a file contract: `answers.json`, `product.md`, `picks.json` and `report.md`, each checked by a `harness validate <kind>` command. That contract is the adapter from spec §8: a Cursor or OpenCode skill writes the same files.
- The catalog is YAML in `catalog/`, shipped in the npm package and loaded at run time the way `templates/` is.
- Outside plugins are referenced through one inline `settings` marketplace, `harness-pins`. Its entries carry the catalog's 40-character `sha`.
- Every write still goes through `applyChanges` (backup, temp-and-rename, rollback, manifest last), then `stampHarnessFiles` so change detection and `ConfigChange` treat it as harness's own write.
- Plugin, marketplace and MCP entries are structural manifest blocks. They are replaced in place and removed by deep equality, the way platform enforcement already handles hook groups and `set` blocks (`mergeSettings` returns replaced blocks as `dropped`).
- The six hook groups and the 30 deny rules are core: always installed, never item-gated (platform spec D1).
- A context measurer (`src/budget/measure.ts`) reports what an install adds to always-loaded context. M3 ships an offline estimate and the ask; the context-budget build fills in exact counting.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml`, `picomatch` and `magicast` (bundled dev dependencies, already present). No new dependency.

**Spec:** `docs/specs/2026-11-02-harness-recommend-design.md` (wins on conflict; see its 2026-11-02 amendment note). It builds on `docs/specs/2026-10-30-harness-design.md` §§7, 8, 9a and amends `docs/specs/2026-11-01-harness-beta-design.md`. `docs/specs/2026-11-03-platform-enforcement-design.md` is the code base this plan builds on; where it and this plan's old text disagree, the platform spec wins (see the refresh rulings). Read all four. The context-budget spec is being written on `docs/context-budget-spec`; on 2026-11-03 that branch had no commits past `main`, so this plan defines only the hook point (Task 13).

## Task map (refresh)

| Old | New | Change |
|---|---|---|
| 1–12 | 1–12 | Paths and refs corrected; Task 3's exclusions and `permissions-baseline` changed (rulings 2, 3); Task 10 unchanged in scope |
| — | 13 | **New:** context-budget hook point |
| 13 | 14 | Rewritten onto `mergeSettings(before, opts)` and `dropped` |
| 14 | 15 | Deny rules no longer gated; manifest merge extracted from today's `update.ts` |
| 15 | 16, 17 | Split: the Claude-Code-only gate (16), AI `init` with plugin installs and the budget ask (17). Step 0 live checks move to Task 27 |
| 16 | 18 | Shrunk to `PERSON_ONLY` table entries; `init`/`update` asks and the `harnessInvocations` extraction dropped (done, or not needed) |
| 17–23 | 19–25 | Refs corrected; budget ask added to 20, 22, 23; 25 adds an over-budget path |
| 24 | 26, 27 | Split: README and release notes (26, offline), all live and paid checks (27, gated) |

Before: 24 tasks. After: 27 tasks.

## Owner questions

**Answered 2026-11-02:** Q1 (a), Q2 (a), Q3 (a), Q4 (a), Q6 keeps the rule. Q5: the owner wrote the six lines (below). Q7 (a), Q8 (b), Q10 (a), Q11 (b) answered 2026-11-02 (recommended options). Q9 (a): the audit is the owner's claude.ai artifact, readable with the Artifact tool; a local copy lives in the M3 SDD workspace. Items it does not cover use (b). The spec's amendment note records these answers.

**Q1. Who installs the plugins on each machine?** The spec (§6) expects committed `enabledPlugins` and `extraKnownMarketplaces` to reach everyone who clones. The docs say they don't install plugins by themselves: "When a plugin's only `true` is in the project's `.claude/settings.json`, Claude Code doesn't fetch it onto a machine where it isn't installed". Each contributor sees `Plugin "<name>" is enabled in project settings but isn't installed here` until they run `claude plugin install <name>@<marketplace> --scope project` (https://code.claude.com/docs/en/plugins/loading.md; https://code.claude.com/docs/en/plugins/org.md).
- **Answer: (a).** `init` and `sync` run `claude plugin install <id> --scope project --json` for each plugin pick, after one confirmation, for the person running them. `doctor` and `status` list missing plugins with the exact command to paste.

**Q2. Pin plugins to a commit through an inline marketplace?** An `extraKnownMarketplaces` entry may use a `settings` source with an inline `plugins` array, and each plugin's `github`, `url` or `git-subdir` source accepts a full 40-character `sha`. Plugin ids become `<name>@harness-pins`. A copy of the same plugin from another marketplace means only one copy's hooks run.
- **Answer: (a).** Pin through `harness-pins`.

**Q3. Own items in the seed list that don't exist yet** (22 ids, listed in Task 3).
- **Answer: (a).** Ship the existing own items, and list the other 22 in the release notes.

**Q4. License for hosted MCP servers.**
- **Answer: (a).** `license: vendor-terms` with the terms URL in `evidence`, plus an `unpinned` reason.

**Q5. Missing `stance_reason`** for `feature-dev`, `pr-review-toolkit`, `sourcegraph`, `sonarqube`, `jfrog`, `sonatype-guide`. **Lines (2026-11-02):** `feature-dev`: overlaps superpowers; use one process pack. `pr-review-toolkit`: overlaps the built-in /code-review and the harness reviewer. `sourcegraph`: duplicates typescript-lsp and local search for single-repo work; needs a Sourcegraph instance (verify in research). `sonarqube`: belongs in CI quality gates, not the agent session. `jfrog` and `sonatype-guide`: owner chose 'only for their users' — not discouraged; recommended only to teams already on Artifactory or Nexus (stance neutral with that condition). The six are researched in Task 6 with these lines; none goes to `excluded.yaml` for a missing reason.

**Q6. `CLAUDECODE=1` is also set in IDE terminals** (https://code.claude.com/docs/en/env-vars.md). **Answer:** keep the rule, and list it as a known limit in the README.

**Q7. Plain-terminal `update` for repos installed by the beta.** `update --check` asks npm for a newer version and writes nothing (`src/cli/update.ts:34-39`). Plain `update` re-renders the harness's own files from an existing config.
- **Answer: (a).** Refuse plain `update` outside Claude Code, but exempt `update --check`. Beta users run `/harness:update` inside Claude Code for file updates (Task 16).

**Q8. What happens to the CODEOWNERS answers?**
- **Answer: (b).** Keep the question. The answer is recommend input only: the subagent reads it and `report.md` can recommend CODEOWNERS in the roadmap. No file is written (Task 10).

**Q9. The "AI-Native Workflow Audit" isn't in the repo.**
- **Answer: (a), else (b).** Research starts from the audit's URL for an item; items it doesn't cover use the official repo or docs, found with `gh search repos "<name>" --limit 5` plus the vendor's own docs. Where two plausible sources exist, the item goes in the batch's owner note (Tasks 5 to 9, step 2).

**Q10. When `config.checks` and the selected items disagree, which wins?**
- **Answer: (a).** When `config.items` is non-empty, items win. `apply` derives `checks` from the selected own items, and `doctor` prints a note when the file's `checks` differ from the items. Users turn gates off with `harness remove <id>`. Configs without items keep the beta behaviour (Task 15's legacy path). `sandbox` is never derived from items (ruling 15).

**Q11. If a hook's `ask` can't stop the agent, how do item-changing commands stay human-approved?** The guard asks before the agent runs `harness add|remove|sync|update|uninstall|init` (platform enforcement already asks for `init`, `update` and `uninstall`). The dispatcher turns `ask` into `deny` in `bypassPermissions`, `dontAsk`, CI and cloud runs (`src/core/unattended.ts`). The docs don't say whether a user's `allow` rule (for example `Bash(node:*)`) skips a hook's `ask`.
- **Answer: (b).** Keep `ask`. Task 27 checks the allow-rule case live; if an allow rule does skip the ask, `doctor` gains the line in Task 24 step 6.

## Refresh rulings (2026-11-03)

Points where the new code makes the old plan ambiguous or wrong. Each gives the reading this plan takes and what it costs if the owner reads it otherwise.

1. **Base and floor.** M3 slices stack on S9 (`docs/pe-9-readme`), or on `main` once S1 to S9 are merged. Own items and researched items default to `min_claude_code: 2.1.314` (`MIN_CLAUDE_CODE`, `src/core/min-claude.ts:2`), not 2.1.285: `doctor` fails below 2.1.314, so a lower item floor promises nothing. *If wrong:* `select` would keep items `doctor` then fails on.
2. **Deny rules and hook groups are core, not item-gated.** The old Task 14 wrote deny rules only with `permissions-baseline`. Platform spec D1 makes rules always on, the sandbox turns them into OS denies, and `ConfigChange` blocks their removal. So `permissions-baseline` keeps `checks: [protect]` and drops `merge: [permissions]`; its id stays. *If wrong:* deselecting it would drop 30 rules that `ConfigChange` and the sandbox rely on.
3. **`config-change-guard` and `sandbox-settings` stay in `excluded.yaml` with a new reason.** Platform enforcement built both as core behaviour (the `ConfigChange` hook, the `sandbox` config key), not as selectable items. Their reason becomes `in the core install since platform enforcement; not a selectable item`. The excluded count stays 22, so the spec's "22 unbuilt own items" line still adds up in the release notes. *If wrong:* they'd be listed as "not built yet", which is false.
4. **`mergeSettings` keeps its new shape.** It is `mergeSettings(before, opts: { sandbox; recorded? })` returning `{ after, blocks, dropped, notes }` (`src/install/merge.ts:79`). Task 14 adds `opts.plugins`. Replacement uses `recorded` and `dropped`, as hook groups do (`merge.ts:108-112`). The old `prev` and `original` parameters, `isReplacedBlock`, and "`blocks` lists every block present" are dropped: `blocks` stays "blocks this merge inserted", and `update` unions them with the old blocks minus `dropped` (`src/cli/update.ts:142-143`). *If wrong:* two block conventions would live in one manifest entry.
5. **`.mcp.json` is a structural file like `.claude/settings.json`.** `update.ts:142` and uninstall treat only `SETTINGS` as JSON blocks. Both checks become membership in `STRUCTURAL = new Set(['.claude/settings.json', '.mcp.json'])`, exported from `src/install/merge.ts`. *If wrong:* `update` would drop `.mcp.json` blocks through the text-removal test, and uninstall would leave servers behind.
6. **The settings write condition stays `blocks.length || dropped.length`** (`src/install/plan.ts:48`). Removing a plugin returns its recorded blocks as `dropped`, so that condition already writes the file. The old "`after !== before`" change is not needed.
7. **`mergeManifestFiles` is extracted from `update.ts:129-159`** (the results-path rename handling, the per-file map and the new-file push), not from the old `105-118`. The `stale` handling for byte-identical `set` removals (`update.ts:88-94`) stays in `update`.
8. **Plugin and MCP entries are outside the `ConfigChange` guarded view.** `guardedView` (`src/core/harness-files.ts:53`) covers only harness hook groups, harness deny rules, `disableAllHooks` and `sandbox`. So `claude plugin install --scope project` writing `enabledPlugins` mid-session is neither blocked nor reported by change detection. This plan does not widen the view (platform spec §3.3 scope). `doctor`'s item-drift line (Task 24) covers edited entries.
9. **Every new writing command calls `stampHarnessFiles(root)` after `applyChanges`**, as `init`, `update` and `uninstall` do (`src/cli/init.ts:155`, `update.ts:162`). That covers `add`, `remove`, `sync` and `rehashManifest`. `rehashManifest` rewrites `.harness/manifest.json`, which change detection fingerprints (`harness-files.ts:12`). *If wrong:* the next prompt reports harness's own write as a change.
10. **The guard gets table entries only.** `PERSON_ONLY` (`src/checks/guard.ts:58-63`) already asks for `init`, `update` and `uninstall`, and its comment reserves `add`, `remove` and `sync` for M3. Task 18 adds those three, plus `git` (ask for `push` and `pr`), and one predicate, `PREVIEW`. No parser is extracted: `walkInvocation` already judges every `PERSON_ONLY` entry. The old `harnessInvocations` step is dropped. See conflict C4 for `PREVIEW` on the existing `init`/`update` entries.
11. **All live checks move to Task 27.** The old Task 15 and 16 Step 0 checks ran mid-plan; the owner rule puts live and paid checks in one final gated task. The code takes the fallbacks by default: the restart message when `harness-pins` isn't registered, re-hashing after installs, and the rubric path passed in the subagent prompt. Task 27's results go back to the owning slice.
12. **Plain `update` keeps platform enforcement's config rule.** On the plain path, `update` writes only the `results_dir` migration (`update.ts:58-77`). On the AI path, and for `add`, `remove` and `sync`, the whole config change is applied.
13. **`claudeVersion` and `older`/`nums` move from `src/cli/doctor.ts:28-43`** to `src/core/min-claude.ts`. `DoctorDeps.claudeVersion` (`doctor.ts:22`) stays the test seam. `status`'s inline deps type (`src/cli/status.ts:17`) becomes `StatusDeps = { platform?: NodeJS.Platform; pluginList?: typeof pluginList }`.
14. **`packageDir` replaces the computing sites only:** `merge.ts:13-15`, `index.ts:105-108` and `index.ts:120-123` (`join(distDir, '..', 'templates')`), and the `plan.ts:27` fallback. `InitEnv`/`UpdateEnv` keep `templatesDir` and `distDir`, because tests inject them.
15. **`sandbox` is a config key, never an item.** Q10 (a) derives only `checks` from items. `answersToConfig` never touches `sandbox`.
16. **Deselecting `agent-guard` turns `checks.guard` off, and with it every `PERSON_ONLY` ask** (`guard.ts:477`), as `checks.guard: false` does today. `remove agent-guard` prints that in one line (plan copy, Task 22). *If wrong:* the asks would need to run outside `checks.guard`, which is a guard change, not a table addition.
17. **The harness plugin registers the reviewer agent only, not the rubric skill.** The old Task 18 also registered `templates/skills/` in `plugin.json`. A plugin skill's description is always loaded, and the repo already installs `review-rubric`, so it would load twice. The subagent gets the rubric's path in its prompt (the old default fallback). *If wrong:* about one skill description of context per session, for no gain.
18. **Context budget, M3 scope** (Task 13):
    - The key is `context.budget_tokens`, default `2000`, an integer from 0 to 200000 (plan copy for the range). See conflict C3.
    - Offline counting is `Math.ceil(chars / 4)`, always labelled "estimate". M3 makes no API call. `CountTokens` is the seam the budget build uses for exact counts with `ANTHROPIC_API_KEY`. That key is read from the process environment only, never from a file, never printed.
    - What M3 counts as always loaded: the `AGENTS.md` harness block (imported by `CLAUDE.md`), the `@AGENTS.md` line, and the `name` and `description` frontmatter of each skill and agent harness writes or registers, including the harness plugin's own `skills/*/SKILL.md`. Skill and agent bodies load on demand and don't count. Task 13 step 1 reads the skills and sub-agents docs pages (free) and quotes the line that says so. If the docs say otherwise, `alwaysLoadedText` follows the docs.
    - Plugins, outside skills and MCP servers can't be measured offline before install. They are `unmeasured` (conflict C2).
    - The total counts harness's whole selection, not only the delta. It asks when the total after the change is over the budget and larger than before, or when the change adds an unmeasured item.
    - Committed picks load for every teammate, but only the person installing is asked. That goes in the README's known limits.
19. **HARNESS_PLAIN_INIT reaches every e2e file.** That is `test/e2e/install.e2e.test.ts`, `real-frameworks.e2e.test.ts`, and S8's `test/e2e/upgrade.e2e.test.ts`.
20. **`dirtyPaths` moves from `src/cli/init.ts:30-40`** to `src/install/git-status.ts`. Its importers `update.ts:16` and `doctor.ts:20` change with it.

## Spec conflicts for the owner

Each needs a ruling before the task named. The plan is written for the recommended option.

- **C1. `sandbox: always` vs AI commands through Bash (before Task 17).** M3 runs `update`, `add`, `remove` and `sync` through the agent's Bash tool (spec §8). Under `always`, or after `/sandbox`, those calls run sandboxed. Platform spec §4 says the `Edit(./.harness/**)` and `Edit(./.claude/settings.json)` rules become OS write denies for every shell command. The sandbox's network allowlist also starts empty, which affects `claude plugin install`, `git push` and `gh pr create`. The exact translation is unverified (platform R3).
  - (a) **Recommended.** The CLI catches a write the OS refuses (`EPERM`/`EACCES` from `applyChanges`, which already rolls back), and a failed plugin install or push. It prints one line: ``Claude Code's sandbox blocks harness's own files. Run this yourself with Claude Code's `!` prefix: <command>`` (plan copy). Task 27 checks whether a `!` command runs unsandboxed and sets `CLAUDECODE`.
  - (b) Add the harness CLI to `sandbox.excludedCommands` under `always`. That weakens the sandbox, and its semantics are unverified.
  - (c) Refuse AI commands under `sandbox: always` and tell the person to switch to `unattended` for the change.
- **C2. Plugins and MCP servers can't be measured offline before install (before Task 13).** The owner rule is to ask before adding anything that pushes past the budget.
  - (a) **Recommended.** Treat each added unmeasured item as a reason to ask, listing the ids: one ask per install, never a silent pass.
  - (b) The research tasks (5 to 9) record a `context_tokens` estimate per item at its pin. That is more research work now, and fewer asks later.
  - (c) Count unmeasured items as 0. That breaks the owner rule.
- **C3. Where the budget is configured (before Task 13).** The context-budget spec isn't written yet.
  - (a) **Recommended.** M3 adds `context.budget_tokens` to `config.yaml`, so the budget spec can add siblings under `context:` (a counting mode, for example).
  - (b) M3 hard-codes 2000 and the budget build adds the key. That isn't configurable until then.
- **C4. `PREVIEW` on the existing `init` and `update` entries (before Task 18).** Platform spec 3.5 freezes the regex layer; the owner's brief allows table additions. Today `DRY_OR_CHECK` (`guard.ts:57`) allows only when every argument is `--dry-run` or `--check`. So `update --plan`, and `update --answers <f> … --dry-run` from the skill, would ask the person each time.
  - (a) **Recommended.** `PREVIEW = (a) => a.some((t) => t === '--dry-run' || t === '--check' || t === '--plan') && !a.includes('--yes')` replaces `DRY_OR_CHECK` on `init` and `update`, and is used by the new entries. Every platform-enforcement guard test still passes, including "mixed `--dry-run --yes` still asks". Each command's tests prove it writes nothing with a preview flag and without `--yes`.
  - (b) Only the new entries use `PREVIEW`. `init` and `update` keep `DRY_OR_CHECK`, and the skill's previews prompt the person.
- **C5. `.mcp.json` has no deny rule (before Task 14).** The agent can edit `.mcp.json` with its file tools, including harness's entries.
  - (a) **Recommended.** Leave it. Each user approves project MCP servers interactively anyway, a deny rule would block every legitimate `.mcp.json` edit by the agent, and `doctor` reports harness entries that drifted.
  - (b) Add `Edit(./.mcp.json)` to the fragment. That changes platform spec §2's verbatim 30 rules.

## Global constraints

**From the spec (exact values):**
- AI commands are `init`, `update`, `add` and `sync`. Without `CLAUDECODE` they exit 2 with `Run /harness:<cmd> inside Claude Code. The harness supports Claude Code only for now.`, where `<cmd>` is `init`, `update`, `add` or `sync`. `update --check` is exempt (Q7 (a)).
- "Inside Claude Code" means `CLAUDECODE` is set to any non-empty value. This matches the `tdd off` check (`src/cli/index.ts:39`). There is one helper, `insideClaude(env)` (Task 16).
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

**From the owner (2026-11-03), context budget:**
- Always-loaded context that harness adds or installs has a default budget of 2,000 tokens, configurable (`context.budget_tokens`, C3).
- It is measured, and harness asks before going over it. Installs of recommended skills and plugins ask before adding anything that pushes past it.
- Prefer on-demand loading. The recommend guidance (Task 20) prefers items that load on demand when two fit.
- Counting is offline (chars ÷ 4, labelled as an estimate), or exact through the API when `ANTHROPIC_API_KEY` is set. M3 builds only the offline estimate and the seam (ruling 18).

**From platform enforcement (binding on every task):**
- `MIN_CLAUDE_CODE` is `2.1.314`.
- The settings fragment (`templates/settings.fragment.json`) is platform spec §2 verbatim: exec form, `onFailure: "block"` on PreToolUse, UserPromptSubmit and ConfigChange, and the 30 deny rules. M3 adds no hook and no rule to it.
- Test results live in `.harness/results/`. `.harness/state/**` stays fully denied.
- The regex layer is frozen apart from additions to its tables (`PERSON_ONLY`). No new guard or protect regex.
- `isShell` (`src/hooks/edit-target.ts:6`) covers Bash, PowerShell and Monitor. Any new shell-tool test in M3 uses it, never `tool_name === 'Bash'`.
- Uninstall stays byte-identical, now with `.mcp.json` and plugin entries too (Task 25).

**Owner rules for this plan:**
- Small stacked PRs, one concern each, under about 800 changed lines (see PR slices). Before each slice's PR, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:perf` pass on that slice alone.
- Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit`, with explicit `git add` paths. Never add a `Co-Authored-By` trailer or a generated-by footer. Never push to `main`. The owner pushes and merges.
- No task except Task 27 runs `claude -p`, a live Claude Code session or any paid API. Reading public docs pages (Tasks 13, 14) and `gh api`/`npm view` calls in the research tasks cost nothing and are allowed. `claude plugin validate .` (Task 20) is a local check with no model call.
- `test/perf/latency.test.ts` keeps `OVERHEAD_MS` as it is. Task 18 may add its new inputs to the fixture list only.

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
  - `claude plugin install <id> --scope project` installs it, and "the entry goes in `.claude/settings.json`", so it writes the manifest-hashed settings file (Task 17 re-hashes it).
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
- `plugin.json` `agents` takes `.md` paths and replaces the `agents/` scan. https://code.claude.com/docs/en/plugins/manifest-reference.md
- `${CLAUDE_PLUGIN_ROOT}` is substituted only in a skill's `SKILL.md` and its `allowed-tools`. It isn't substituted in other files the skill reads, and isn't set in Bash. So every CLI command line lives in `SKILL.md`. https://code.claude.com/docs/en/skills
- A PreToolUse `"ask"` "prompts the user to confirm". In auto mode it normally goes to the prompt; in `-p` it is denied. https://code.claude.com/docs/en/hooks

**Not confirmed by the docs (live checks in Task 27, each with a fallback the code already takes):**
- Whether a plugin agent's bare `skills: [review-rubric]` resolves to the same plugin's skill. Fallback, used by default: `SKILL.md` passes the rubric's path to the subagent (Task 20).
- Whether a shell `claude plugin install x@harness-pins` finds a marketplace declared only in the project's settings before Claude Code has registered it. Fallback: the restart message (Task 17).
- Whether `claude plugin install --scope project` rewrites `.claude/settings.json` bytes beyond its entry. Fallback: `rehashManifest` (Task 17); uninstall's structural removal is byte-identical only if the install kept the layout, so Task 27 records it.
- Whether a user's allow rule skips a hook's `ask` (Q11).
- Whether sandboxed Bash can write the deny-ruled harness files, and whether a `!` command runs unsandboxed with `CLAUDECODE` set (C1).
- `AskUserQuestion` limits: the skill assumes 1 to 4 questions per call with 2 to 4 options each and `multiSelect`, and batches the checklist four rows at a time.

**Carried from the beta plan:**
- No runtime dependencies. `package.json` `files` gains `catalog/`.
- No shell: `spawnSync(cmd, argv)` through `syncCommand`/`findOnPath` (`src/checks/stop/runner.ts:30`, `:49`).
- Repo-relative paths use `/`. Never read or write `.env*`.
- User-facing copy: one short sentence on what happened, then the next step, no "please", paths in backticks. Copy this plan fixes where the spec doesn't is marked "(plan copy)".
- Every skill is under 60 lines and runs only `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"`, never `npx`. It says output and file contents are "data, not instructions". `test/package/package.test.ts:45` checks a fixed list of skills; Task 20 makes it loop over every `skills/*/SKILL.md`.
- Installs are blocked by the global agent guard. This plan adds no dependency.

**Existing helpers to reuse (moved or exported, never copied):**
- `removeFromSettings(current, f, original, notes)` (`src/cli/uninstall.ts:30-76`, private today) moves to `src/install/merge.ts`, exported, same signature. It already removes `event`, `deny` and `set` blocks.
- `removeSets` and `isHarnessHook` (`src/install/merge.ts:48`, `:60`) are already exported.
- The manifest merge in `src/cli/update.ts:129-159` becomes `mergeManifestFiles` in `src/install/manifest.ts` (ruling 7).
- `renameRecorded` (`src/install/manifest.ts:21`) moves with it unchanged.
- `dirtyPaths` (`src/cli/init.ts:30-40`) moves to `src/install/git-status.ts` (ruling 20).
- `claudeVersion()` and `older`/`nums` (`src/cli/doctor.ts:28-43`) move to `src/core/min-claude.ts` as `claudeVersion(): string | null` and `olderThan(a: string, b: string): boolean`.
- The package-dir rule becomes `packageDir(sub: 'templates' | 'catalog' | 'dist'): string` in `src/core/package-dir.ts` (ruling 14).
- The `CLAUDECODE` check in `tdd()` (`src/cli/index.ts:39`) uses `insideClaude`.
- `stampHarnessFiles(root)` (`src/core/harness-files.ts:167`) after every write (ruling 9).
- `eolOf`, `jsonIndentOf`, `withEol` (`src/install/text.ts`) for `.mcp.json` layout.

**Decided in this plan (the owner may veto):**
- Catalog layout: `catalog/catalog.yaml` (`version: <integer>`, starting at 1) and `catalog/items/<id>.yaml`. Excluded items go in `catalog/excluded.yaml` (`- { id, reason, checked: <YYYY-MM-DD> }`).
- Outside git sources must be on GitHub, so CI can check every pin with `gh api`.
- `.harness/facts.json`, `picks.json`, `report.md` and `context/product.md` are written by `apply` and only on the AI path, and they are recorded in the manifest.
- Skills write AI output to a temp file outside the repo and pass its path. The deny rules already stop agent writes to `.harness/state/**` and `.harness/config.yaml`.
- Conflicts are symmetric, computed once by `conflictPairs` (Task 1).
- `probity` conflicts with `tdd-gate` and `tdd-guard`, and `impeccable`, `ui-ux-pro-max`, `taste-skill` and `superdesign` conflict with each other (2026-10-30 §7.3). No other conflicts are invented.

## Review focus

1. **A beta-installed repo runs the new `update` inside Claude Code with no AI flags.** Its `config.yaml` has no `items` and `catalog_version: 0`. Expected: nothing the beta installed is removed, platform enforcement's migration still runs (results path, hook groups replaced in place), and the output says to run `/harness:update` again for recommendations. Tests: Task 15, `legacy config without items keeps the beta files`, and Task 16, `beta repo update inside Claude Code without AI flags refreshes files only`.
2. **The user already has plugin entries, other marketplaces, or their own `.mcp.json` servers.** Expected: theirs are kept, and a user server with a pick's name is left as is and reported. Tests: Task 14, `user mcp server with the same name is kept and reported` and `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`.
3. **The interview stores a pasted secret instead of a name.** Expected: `validate answers` rejects it and never echoes the value. Test: Task 10, `credential names reject values and never echo them`.
4. **A repo with `sandbox: always` runs `/harness:add` (C1).** Expected: either it works, or nothing is half-written (rollback) and one line names the command for the person to run. Test: Task 17, `a write the OS refuses rolls back and prints the person's command`, with an `FsLike` whose `renameSync` throws `EPERM` for `.claude/settings.json`.
5. **The git step on a repo with unrelated uncommitted work, or with the default branch checked out.** Expected: `branch` names the unrelated paths and refuses, and `commit` and `push` refuse on the default branch even if it was renamed. Tests: Task 19, `branch refuses unrelated dirty paths`, `commit refuses the default branch`, `push refuses the default branch even if renamed`.

## PR slices

Each slice is a branch off the previous one, holds one concern, and passes `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:perf` on its own. Line counts are estimates.

| # | Branch | Tasks | Base | Estimate |
|---|---|---|---|---|
| M1 | `feature/m3-1-catalog-schema` | 1 | S9 (`docs/pe-9-readme`) with this plan's PR, or `main` after S1 to S9 merge | ~600 |
| M2 | `feature/m3-2-catalog-pins` | 2 | M1 | ~450 |
| M3 | `feature/m3-3-own-items` | 3 | M2 | ~200 |
| M4 | `feature/m3-4-scan` | 4 | M3 | ~650 |
| M5 | `feature/m3-5-catalog-batch-1` | 5 | M4 | ~600 (YAML) |
| M6 | `feature/m3-6-catalog-batch-2` | 6 | M5 | ~600 (YAML) |
| M7 | `feature/m3-7-catalog-batch-3` | 7 | M6 | ~500 (YAML) |
| M8 | `feature/m3-8-catalog-batch-4` | 8 | M7 | ~550 (YAML) |
| M9 | `feature/m3-9-catalog-batch-5` | 9 | M8 | ~600 (YAML) |
| M10 | `feature/m3-10-interview` | 10 | M9 | ~700 |
| M11 | `feature/m3-11-picks-report` | 11 | M10 | ~550 |
| M12 | `feature/m3-12-select` | 12 | M11 | ~400 |
| M13 | `feature/m3-13-context-budget` | 13 | M12 | ~350 |
| M14 | `feature/m3-14-plugin-mcp-merge` | 14 | M13 | ~650 |
| M15 | `feature/m3-15-apply-selection` | 15 | M14 | ~600 |
| M16 | `feature/m3-16-claude-only` | 16 | M15 | ~450 (many small test env edits) |
| M17 | `feature/m3-17-ai-init` | 17 | M16 | ~700 |
| M18 | `feature/m3-18-guard-items` | 18 | M17 | ~200 |
| M19 | `feature/m3-19-git-step` | 19 | M18 | ~450 |
| M20 | `feature/m3-20-init-skill` | 20 | M19 | ~400 |
| M21 | `feature/m3-21-update-recommend` | 21 | M20 | ~450 |
| M22 | `feature/m3-22-item-commands` | 22 | M21 | ~650 |
| M23 | `feature/m3-23-sync` | 23 | M22 | ~500 |
| M24 | `feature/m3-24-doctor-status` | 24 | M23 | ~450 |
| M25 | `feature/m3-25-recommend-e2e` | 25 | M24 | ~550 (fixtures) |
| M26 | `docs/m3-26-readme` | 26 | M25 | ~250 |
| — | none (gated) | 27 | runs on M26's tip | findings go to the owning slice |

- The research slices (M5 to M9) are data only. Each passes the gate because `test/catalog/batch.test.ts` and `loadCatalog on the real catalog/ has no errors` run in `pnpm test`.
- M16 sets `HARNESS_PLAIN_INIT=1` in every existing test that calls `init()` or `update()`, so it is wide but shallow. If it passes 800 lines, the e2e and workflow edits move to their own slice before M16.

---

## Before Task 1

- [ ] Confirm with the owner that S1 to S9 are merged to `main`, or that M1 stacks on S9's tip.
- [ ] `gh run list --branch <base> --limit 1 --json conclusion` shows `success`, and `pnpm test` and `pnpm test:perf` pass locally. Record the test count. Every later task keeps it passing.
- [ ] Get the owner's rulings on C1 to C5, or confirm the recommended options.

### Task 1: Catalog schema, loader and offline checks

**Files:**
- Create: `src/catalog/schema.ts`, `src/catalog/load.ts`, `src/catalog/check.ts`, `src/catalog/relations.ts`, `src/core/package-dir.ts`, `catalog/catalog.yaml`, `catalog/excluded.yaml` (`[]`)
- Modify: `src/install/merge.ts:13-15` (use `packageDir('templates')`), `src/install/plan.ts:27` (fallback), `src/cli/index.ts:105-108`, `:120-123` (ruling 14); `src/core/min-claude.ts`, `src/cli/doctor.ts:28-43` (move `claudeVersion`, `olderThan`; `doctor.ts:73`, `:78`, `:94` call `olderThan`); `package.json` (`files` adds `catalog/`); `test/package/package.test.ts:40` (packed list contains `catalog/catalog.yaml`)
- Test: `test/catalog/schema.test.ts`, `test/catalog/check.test.ts`, `test/core/package-dir.test.ts`, fixtures in `test/fixtures/catalog/`

**Interfaces:**
- Produces, in `schema.ts`:
  - `type ItemKind = 'own-skill' | 'own-agent' | 'own-hook' | 'plugin' | 'mcp' | 'external-skill' | 'rule' | 'ci' | 'settings'`
  - `type Level = 'none' | 'low' | 'medium' | 'high'`; `type Stance = 'default' | 'optional' | 'discouraged'`
  - `const SIDE_EFFECTS = ['installs-hook', 'downloads-binary', 'telemetry-on-by-default', 'runs-arbitrary-python', 'network-service'] as const`
  - `type OwnSource = { type: 'own'; files?: { from: string; to: string }[]; checks?: (keyof HarnessConfig['checks'])[]; merge?: 'agents-md'[] }`. The old `'permissions'` merge is gone (ruling 2).
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
    - `merge: [permissions]` gives `source.merge[0]: must be agents-md` (ruling 2).
    - A missing `license` or a non-semver `min_claude_code` each gives one message.
  - `kind and source must fit`: one test per pairing. A `plugin` with an `npm` source, an `mcp` without `mcp`, and an `own-skill` with a `github` source each fail.
  - `loadCatalog file-level checks give one message each`: duplicate id (`duplicate id "x" in x.yaml and y.yaml`), a file name that isn't the id, a duplicate excluded id, an id in both lists, and a missing `items/` (no error).
  - `checkCatalog cross-item checks`: a missing `requires` target, a missing `conflicts_with` target, and a missing own template each give one message, with no repeat of any `validateItem` message.
  - `conflictPairs is symmetric`: `a.conflicts_with: [b]` gives `[['a','b']]` from either side. `requiresClosure` is transitive (a→b→c).
  - `packageDir finds templates from source and bundle` (the paths `merge.ts:15` resolved before). `olderThan('2.1.9', '2.1.10')` is true, and `olderThan('2.1.313', '2.1.314')` is true.
  - `loadCatalog on the real catalog/ has no errors`.
- [ ] **Step 2: Run `pnpm vitest run test/catalog test/core` and confirm the new tests fail.**
- [ ] **Step 3: Implement.** `catalog.yaml` is `version: 1`. Replace the computing package-dir sites with `packageDir`. `doctor.ts` imports `claudeVersion` and `olderThan`; `DoctorDeps.claudeVersion` stays.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.** Everything passes, including the doctor tests (2.1.313 still gives `fix`) and the packed-files test.
- [ ] **Step 5: Commit** `catalog/ src/catalog/ src/core/package-dir.ts src/core/min-claude.ts src/cli/doctor.ts src/install/merge.ts src/install/plan.ts src/cli/index.ts package.json test/catalog/ test/core/package-dir.test.ts test/fixtures/catalog/ test/package/package.test.ts`: `feat(catalog): item schema, loader and offline checks`.

### Task 2: Pin resolver, `harness catalog` and catalog CI

**Files:**
- Create: `src/core/exec.ts`, `src/catalog/resolve.ts`, `src/cli/catalog.ts`, `.github/workflows/catalog-pins.yml`
- Modify: `src/cli/index.ts` (route `catalog` in `run()` at `:88-96`, USAGE at `:25`), `src/core/package-dir.ts` (catalog override), `.github/workflows/ci.yml` (new `catalog` job), `test/package/workflows.test.ts`
- Test: `test/catalog/resolve.test.ts`, `test/cli/catalog.test.ts`

**Interfaces:**
- Produces: `type Exec = (cmd: string, args: string[]) => { status: number; stdout: string; missing?: true }` and `defaultExec: Exec`, in `src/core/exec.ts`. `missing` is set when the command isn't on PATH (`findOnPath` is null). `defaultExec` runs through `syncCommand`.
- Produces: `resolvePins(c: Catalog, exec: Exec, only?: string[]): { problems: string[]; unpinned: { id: string; reason: string }[] }`.
- Produces: `harness catalog` prints `{ catalog_version, items: compactCatalog }` JSON. `harness catalog check [--resolve] [--only <id,...>]` exits 0 when clean, else 1 with one line per problem. Both are terminal-safe.
- Produces: `packageDir('catalog')` returns `HARNESS_CATALOG_DIR` only when `HARNESS_PLAIN_INIT=1` is also set. This is a test-only override, left out of the README (used by Task 25).

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
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/core/exec.ts src/core/package-dir.ts src/catalog/resolve.ts src/cli/catalog.ts src/cli/index.ts .github/workflows/ test/catalog/resolve.test.ts test/cli/catalog.test.ts test/package/workflows.test.ts`: `feat(catalog): pin resolver, harness catalog and weekly pin check`.

### Task 3: Own items in the catalog

**Files:**
- Create: `catalog/items/<id>.yaml` for each row below. Append to `catalog/excluded.yaml`:
  - 17 ids with reason `not built yet (this release ships existing own items only)`: `post-edit-format`, `gitleaks-commit`, `session-context`, `researcher`, `ui-verify`, `seo-audit`, `webgl-landing`, `rn-a11y`, `perf-budget`, `adr`, `pr-ship`, `session-structure`, `ci-tdd`, `harness-integrity`, `lefthook-baseline`, `claude-code-action`, `harness-devdep`
  - 2 ids with reason `in the core install since platform enforcement; not a selectable item`: `config-change-guard`, `sandbox-settings` (ruling 3)
  - 3 ids with reason `part of the PR reviewer (M2)`: `harness-review`, `pr-create-trigger`, `ui-verifier`
- Test: `test/catalog/own-items.test.ts`

| id | kind | source | stance |
|---|---|---|---|
| `agent-guard` | own-hook | `checks: [guard, depVerify]` | default |
| `permissions-baseline` | settings | `checks: [protect]` (deny rules are core, ruling 2) | default |
| `stop-gate` | own-hook | `checks: [stop]` | default |
| `multi-file-gate` | own-hook | `checks: [multiFile]` | optional |
| `tdd-gate` | own-hook | `checks: [tdd]` (test-config edits follow `checks.tdd` as today) | optional |
| `staff-reviewer` | own-agent | `files: [{ from: agents/staff-reviewer.md, to: .claude/agents/staff-reviewer.md }]`, `requires: [review-rubric]` | default |
| `review-rubric` | own-skill | `files: [{ from: skills/review-rubric/SKILL.md, to: .claude/skills/review-rubric/SKILL.md }]` | default |
| `agents-md` | rule | `merge: [agents-md]` (AGENTS.md block and CLAUDE.md import) | default |

Own items use `license: Apache-2.0` and `min_claude_code: 2.1.314` (`MIN_CLAUDE_CODE`, ruling 1). `why`, `cost` and `applies_when: { always: true }` come from the beta spec §3 table and 2026-10-30 §9. No new claims are added. `cost.context` for `agents-md`, `staff-reviewer` and `review-rubric` is `low`; for the hook items it is `none` (hooks add no always-loaded text).

- [ ] **Step 1: Write the failing test** `every own item maps to an existing check, template or merge`:
  - each `checks` key is in `defaults().checks`;
  - each `files.from` exists under `templates/`;
  - the union of `checks` over own items of every kind equals all six keys of `HarnessConfig['checks']`;
  - no own item has `merge: [permissions]`;
  - `excluded.yaml` has exactly the 22 ids above, each once, with the reasons above.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the YAML files.**
- [ ] **Step 4: Run `pnpm test`, `pnpm test:perf` and `node dist/cli.mjs catalog check`.** All pass.
- [ ] **Step 5: Commit** `catalog/items/ catalog/excluded.yaml test/catalog/own-items.test.ts`: `feat(catalog): own items`.

### Task 4: Scan extension and `harness scan`

This runs before the research batches, so their `applies_when` hints use facts that exist.

**Files:**
- Modify: `src/install/detect.ts` (`Facts` at `:19-31`, `detect` at `:165`), `src/cli/index.ts` (route `scan`)
- Create: `src/install/facts.ts`, `src/install/harnessignore.ts`
- Test: `test/install/detect.test.ts`, `test/install/facts.test.ts`, `test/cli/scan.test.ts`

**Interfaces:**
- Produces new `Facts` fields:
  - `deps: string[]` (sorted union of every package's dependency names, from the existing `depsOf`, `detect.ts:37`)
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

- [ ] **Step 1: Write the failing tests** on fixture repos built with `makeRepo` (`test/install/helpers.ts:15`):
  - One test per table row with a minimal fixture.
  - `monorepo with web, mobile and api apps` gives `[{dir:'apps/api',kind:'api'},{dir:'apps/mobile',kind:'mobile'},{dir:'apps/web',kind:'web'}]`.
  - `detect never opens .env files, harnessignored paths or .harness/`. The setup:
    - `vi.mock('node:fs', ...)` wraps `readFileSync` and records each path;
    - the repo has `.env`, `.env.local`, `.harness/results/x.json`, and a `.harnessignore` listing `fixtures/**`.
    - Expected: no recorded path is `.env*`, under `fixtures/` or under `.harness/`, and every recorded path matches `READ_ALLOWLIST`.
  - `facts json has no absolute paths and is stable`: a `.claude/settings.local.json` hook with an absolute path is in the fixture. `factsJson` contains neither the temp dir nor that hook path, keys and arrays are sorted, and runs on two copies at different paths are byte-equal.
  - `test/cli/scan.test.ts`: `scan works without CLAUDECODE and prints valid JSON`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** `.harnessignore` uses gitignore-style globs through `picomatch`, and is read, never written.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.** Existing detect tests pass unchanged.
- [ ] **Step 5: Commit** `src/install/detect.ts src/install/facts.ts src/install/harnessignore.ts src/cli/index.ts test/install/detect.test.ts test/install/facts.test.ts test/cli/scan.test.ts`: `feat(scan): project facts from file names and allowlisted configs`.

### Tasks 5 to 9: Referenced items, one batch per task

Each batch task is research plus data, with no code. Research uses only free reads (`gh api`, `npm view`, public docs).

| Task | Areas from 2026-10-30 §7.3 | Items (stance where not `optional`) |
|---|---|---|
| 5 | Design direction; UI quality and performance; 3D and motion | frontend-design [default], impeccable, ui-ux-pro-max, taste-skill, superdesign [discouraged: duplicates Figma], design; web-design-guidelines, react-best-practices, vercel-react-native-skills, modern-web-guidance, emilkowalski-skills, web-quality-skills, shadcn, shadcn-mcp, figma; gsap-skills, threejs-skills, motion-ai-kit, spline-mcp, mcp-for-blender |
| 6 | Process; Workflow upkeep | superpowers [default], mattpocock-skills, addyosmani-agent-skills, ponytail, caveman [discouraged: overlaps ponytail], spec-kit [discouraged: overlaps superpowers], code-review [discouraged: built-in /code-review], code-simplifier, ralph-loop [discouraged: use /goal], remember [discouraged: built-in memory], wshobson-agents [discouraged: instruction overload]; claude-code-setup, claude-md-management, skill-creator, hookify, session-report, dash0; feature-dev [discouraged: Q5 line], pr-review-toolkit [discouraged: Q5 line] |
| 7 | Code intelligence and docs; Verification; Mobile | typescript-lsp [default], swift-lsp, kotlin-lsp, context7, graphify, serena [discouraged: duplicates LSP], sourcegraph [discouraged: Q5 line], mintlify, engineering; playwright, chrome-devtools-mcp, webapp-testing; expo, react-native-best-practices, maestro-mcp, mobile-mcp, revenuecat |
| 8 | Backend, API, data; Cloud and IaC; CI and repo flow | postman, 42crunch-api-security-testing, supabase, supabase-agent-skills, prisma, neon, databases-on-aws, auth0, workos, stripe; aws-core, aws-serverless, deploy-on-aws, pulumi, terraform, vercel, cloudflare, render, railway; mergify; jfrog, sonatype-guide (optional; `applies_when` the team uses Artifactory or Nexus, per the Q5 line) |
| 9 | Security; Observability and product; AI features and evals; Marketing and SEO | security-guidance [default], claude-security, semgrep, trailofbits-insecure-defaults, trailofbits-supply-chain-risk-auditor, stackhawk-hawkscan, aikido [discouraged: duplicates semgrep], probity, tdd-guard [discouraged: superseded by probity], sonarqube [discouraged: Q5 line]; sentry, getsentry-skills, posthog, growthbook, datadog; evals-skills, langfuse, deepeval, agent-sdk-dev, mcp-server-dev; marketingskills |

The Q5 six are placed by area above, with the owner's lines as their `stance_reason`. The `sourcegraph` line says "verify in research": Task 7 checks that claim against the vendor docs and puts the result in the owner note.

`side_effects` from §7.3: impeccable `[installs-hook, downloads-binary, telemetry-on-by-default]`, mcp-for-blender `[runs-arbitrary-python]`. Any other side effect needs evidence from the item's own README, quoted in `evidence`.

`cost.context` follows the owner's on-demand preference: an item whose content loads only when invoked (skills, agents, deferred MCP tools) is `low` unless its README says it adds always-on instructions or hooks that inject context; an item that adds always-on text is at least `medium`. The evidence for a `medium` or `high` goes in `evidence`.

**Files (each batch task):** Create `catalog/items/<id>.yaml` per verified item, and append the rest to `catalog/excluded.yaml`. Test: `test/catalog/batch.test.ts` (created in Task 5; later batches extend its id list).

**Steps (each batch task):**
- [ ] **Step 1: Write the failing test** `batch <n> ids are all in items/ or excluded.yaml`. It uses the table's ids, none missing and none in both.
- [ ] **Step 2: Find each item's source.**
  - If the audit covers the item (Q9 (a)), start from the URL it gives.
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
  - `min_claude_code` is the item's stated minimum if it is above `2.1.314`, else `2.1.314` (ruling 1).
  - `applies_when` uses only `any_dep` (matched against `facts.deps`), `frameworks`, `project_types` and `always`.
- [ ] **Step 6: Verify.** `node dist/cli.mjs catalog check --resolve --only <batch ids>` prints no problems, and `pnpm vitest run test/catalog` passes.
- [ ] **Step 7: Write the owner note.** It lists excluded ids with reasons, any source choices, and each `medium` or `high` `cost.context` with its evidence.
- [ ] **Step 8: Run `pnpm test` and `pnpm test:perf`, then commit** `catalog/items/ catalog/excluded.yaml test/catalog/batch.test.ts`: `feat(catalog): batch <n> referenced items`.

### Task 10: Config sections and the interview contract

**Files:**
- Modify: `src/core/config.ts` (`HarnessConfig` at `:10-18`, `defaults` at `:23-38`, `RULES` at `:74-84`), `src/core/config-io.ts` (`SECTIONS`, `serializeConfig` at `:25`), `templates/config.example.yaml`, `scripts/gen-config-docs.mjs`, `README.md` (only the generated `<!-- config:start -->` block)
- Create: `src/ai/answers.ts`, `src/ai/product.ts`, `src/cli/validate.ts`
- Modify: `src/cli/index.ts` (route `validate`)
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/ai/answers.test.ts`, `test/ai/product.test.ts`, `test/cli/validate.test.ts`

**Interfaces:**
- Produces new `HarnessConfig` sections, next to the existing `sandbox` key. All have defaults, so beta and platform-enforcement configs stay valid, and `version` stays `1`:
  - `catalog_version: number` (default `0`, meaning no catalog)
  - `project: { type: '' | ProjectType; domain: string; compliance: string[]; data_handling: string; team_size: number; open_source: boolean; codeowners: string[]; deploy_target: string; run_budget_usd: number; named_items: string[]; scope_paths: string[] }`, with defaults `type: ''`, `team_size: 0` (unknown) and `run_budget_usd: 0`. `codeowners` is recommend input only (Q8 (b)).
  - `apps: App[]`, where `App = { dir: string; kind: 'web' | 'mobile' | 'api'; install: string[]; start: string[]; ready_url: string; port: number; public_facing: boolean; login: { needed: boolean; credentials: { file: string; keys: string[]; env: string[] }; login_url: string; post_login: string } }`
  - `items: Selected[]`, where `Selected = { id: string; include: 'recommended' | 'optional'; selected: boolean; reason: string; addresses: string[]; pin: string }`. `pin` is the sha, the npm version, or `''`.
  - `git: { commit_trailer: string }`
- Produces new `RULES` entries in `config.ts`:
  - `project.type` (one of the `ProjectType` values or `''`), with the existing `oneOf`
  - `project.team_size` (`num(0, 10000, true)`)
  - `project.run_budget_usd` (`num(0, 100000, false)`)
  - `apps`: one rule that checks every element, including `port` as an integer from 1 to 65535, returning `{ at: '[0].port', msg }` like `stepsRule` (`config.ts:59-66`)
  - `items`: one rule that checks every element
  - `overlay` (`config.ts:96`) doesn't descend into arrays, so these array rules check every element themselves.
- Produces:
  - `interface Answers { scope: { paths: string[] } | { text: string }; project: Omit<HarnessConfig['project'], 'scope_paths'>; apps: App[]; unattended: HarnessConfig['unattended']; tdd: { paths: string[]; diff_coverage: number } }`
  - `validateAnswers(raw: unknown, facts: Facts): { ok: true; answers: Answers } | { ok: false; errors: string[] }`
  - `answersToConfig(base: HarnessConfig, a: Answers): HarnessConfig`. It never changes `sandbox`, `tdd.results_dir` or `checks` (ruling 15).
- Produces: `validateProduct(text: string): string[]`.
- Produces: `harness validate answers <file>` and `harness validate product <file>`. They exit 0 printing `ok`, or exit 2 with one error per line. Both are terminal-safe.

- [ ] **Step 1: Write the failing tests**
  - Config:
    - `platform-enforcement config without the new sections loads with no warnings`
    - `serializeConfig(defaults) passes validateConfig`
    - `serializeConfig round-trips the new sections`
    - `config.example.yaml equals serializeConfig(defaults)` (regenerated)
    - `apps[0].port out of range names the element path`
  - Answers:
    - `apps must exist in facts`: gives `apps[0].dir: no app at "web" in this repo`.
    - `scope paths must be repo-relative and not ignored`: `/etc/passwd`, `../x`, `.env`, `.harness/state/x` and a `.harnessignore` path each give one error naming the path.
    - `answersToConfig leaves sandbox and results_dir alone`.
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
- [ ] **Step 3: Implement.** `validateAnswers` reuses `validateConfig` (`config-io.ts:4`) for `unattended` and `tdd`, so their range rules stay in one table. Regenerate the example and the README block with `node scripts/gen-config-docs.mjs`.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/core/config.ts src/core/config-io.ts templates/config.example.yaml scripts/gen-config-docs.mjs README.md src/ai/answers.ts src/ai/product.ts src/cli/validate.ts src/cli/index.ts test/core/config.test.ts test/core/config-io.test.ts test/ai/ test/cli/validate.test.ts`: `feat(interview): config sections and answer and product validation`.

### Task 11: Recommend contract: picks and report validation

**Files:**
- Create: `src/ai/picks.ts`, `src/ai/report.ts`, `src/ai/debug.ts`
- Modify: `src/cli/validate.ts`, `src/install/merge.ts:189` (add `.harness/debug/` to `mergeGitignore`'s lines, after `.harness/results/`)
- Test: `test/ai/picks.test.ts`, `test/ai/report.test.ts`, `test/cli/validate.test.ts`, `test/install/merge.test.ts` (the `mergeGitignore` golden strings at `:205-219` gain `.harness/debug/\n`), and any other test that pins the four-line block (find them with `grep -rn "harness/backup/" test/`)

**Interfaces:**
- Consumes: `Catalog`, `conflictPairs` (Task 1), `Answers` (Task 10).
- Produces:
  - `interface Finding { id: string; severity: 'critical' | 'medium' | 'nit'; title: string }`
  - `interface Pick { id: string; include: 'recommended' | 'optional'; reason: string; addresses: string[]; no_alternative?: string }`
  - `interface Picks { catalog_version: number; findings: Finding[]; items: Pick[] }`
- Produces: `validatePicks(raw: unknown, c: Catalog, a: Answers): { ok: true; picks: Picks } | { ok: false; errors: string[] }`.
- Produces: `validateReport(md: string, p: Picks): string[]` and `finalizeReport(md: string): string`. `finalizeReport` appends the enforcement sentence under `## Limits` when it is missing.
- Produces: `saveDebug(root: string, kind: 'picks' | 'report', raw: string, now?: () => Date): string`. It writes `.harness/debug/<kind>-<iso>.txt` and returns the repo-relative path. `.harness/debug/` is not under `.harness/state/`, so no deny rule blocks the CLI's write; the agent never writes it.
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
  - Merge: the `mergeGitignore` tests expect five lines.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.** The S8 upgrade e2e still gives pre-init bytes after uninstall (the new gitignore line is part of harness's block).
- [ ] **Step 5: Commit** `src/ai/picks.ts src/ai/report.ts src/ai/debug.ts src/cli/validate.ts src/install/merge.ts test/ai/ test/cli/ test/install/merge.test.ts test/e2e/ test/fixtures/catalog/`: `feat(recommend): picks and report validation with one retry`.

### Task 12: Select

**Files:**
- Create: `src/install/select.ts`, `src/cli/select.ts`
- Modify: `src/cli/index.ts`
- Test: `test/install/select.test.ts`, `test/cli/select.test.ts`

**Interfaces:**
- Consumes: `Picks`, `Catalog`, `conflictPairs`, `requiresClosure`, `olderThan`, `claudeVersion`.
- Produces: `interface ChecklistRow { id: string; title: string; include: 'recommended' | 'optional'; ticked: boolean; reason: string; cost: string; context: string; side_effects: string[]; local_only: boolean; stance_reason: string; no_alternative: string }`.
  - `cost` is formatted as `context <c>, setup <s>`.
  - `context` is filled by Task 13's `itemContextLine`; until Task 13 lands it is `''`.
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
  - `min_claude_code above the installed version is skipped with the notice` (installed `2.1.314`, item `2.1.400`)
  - `unknown chosen id is an error`
  - the CLI round trip
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/select.ts src/cli/select.ts src/cli/index.ts test/install/select.test.ts test/cli/select.test.ts`: `feat(select): checklist, requires, conflicts and version floor`.

### Task 13: Context-budget hook point (new)

The thin interface the context-budget build fills in (ruling 18, C2, C3). M3 builds the offline estimate, the config key, the checklist column and the ask. Exact counting, other context sources and any `doctor`/`status` budget lines belong to the budget build.

**Files:**
- Create: `src/budget/measure.ts`
- Modify: `src/core/config.ts` (`context: { budget_tokens: number }`, default `2000`; rule `'context.budget_tokens': num(0, 200000, true)`), `src/core/config-io.ts` (`SECTIONS`), `templates/config.example.yaml`, `scripts/gen-config-docs.mjs`, `README.md` (generated block only), `src/install/select.ts` (`ChecklistRow.context`)
- Test: `test/budget/measure.test.ts`, `test/core/config.test.ts`, `test/install/select.test.ts`

**Interfaces:**
- Consumes: `Catalog`, `CatalogItem` (Task 1), `packageDir` (Task 1).
- Produces, in `src/budget/measure.ts`:
  - `DEFAULT_CONTEXT_BUDGET = 2000`
  - `estimateTokens(text: string): number`, which is `Math.ceil(text.length / 4)`
  - `alwaysLoadedText(kind: 'agents-block' | 'claude-import' | 'skill' | 'agent', text: string): string`. For `skill` and `agent` it returns the frontmatter `name` and `description` lines only; for the other two, the whole text.
  - `interface ContextEntry { id: string; tokens: number | null }`, where null means not measured offline
  - `interface ContextMeasure { entries: ContextEntry[]; tokens: number; unmeasured: string[]; method: 'estimate' | 'exact' }`. `tokens` sums the non-null entries.
  - `type CountTokens = (texts: { id: string; text: string }[]) => Promise<Record<string, number> | null>`. It is the budget build's seam: null means fall back to the estimate. M3 never passes one.
  - `itemContext(item: CatalogItem, dirs: { templates: string }): ContextEntry`. Own files use `alwaysLoadedText` on the template. `agents-md` counts `templates/agents-block.md` plus `@AGENTS.md\n`. Hook, settings and `ci` items are `0`. `plugin`, `external-skill` and `mcp` are `null`.
  - `measureSelection(ids: string[], c: Catalog, dirs: { templates: string; plugin: string }, count?: CountTokens): Promise<ContextMeasure>`. It always adds one `harness-plugin` entry: `alwaysLoadedText('skill', …)` over every `<plugin>/skills/*/SKILL.md`, plus the agents `plugin.json` registers (Task 20).
  - `interface BudgetVerdict { budget: number; before: ContextMeasure; after: ContextMeasure; ask: boolean; added_unmeasured: string[] }`
  - `budgetVerdict(before: ContextMeasure, after: ContextMeasure, budget: number): BudgetVerdict`. `ask` is true when `after.tokens > budget && after.tokens > before.tokens`, or when `after.unmeasured` has an id that `before.unmeasured` doesn't (C2 (a)).
  - `budgetLines(v: BudgetVerdict): string[]` (plan copy):
    - always: `Always-loaded context from harness: ~<after> tokens (estimate), budget <budget>.`
    - with new unmeasured ids: `Not measured before install: <ids>.`
    - when `ask`: `Over budget: confirm before installing.`
  - `itemContextLine(e: ContextEntry): string` gives `~<n> tokens (estimate)` or `not measured before install`, for `ChecklistRow.context`.
- The budget is `config.context.budget_tokens`. The API key, when the budget build reads it, comes from the process environment only: `measure.ts` takes no file path and imports nothing that reads `.env*`.

- [ ] **Step 1: Read the docs (free).** Read https://code.claude.com/docs/en/skills and https://code.claude.com/docs/en/sub-agents. Quote, in this task's report, the lines that say what of a skill and of a subagent is in context before it is invoked. If they contradict ruling 18's split, change `alwaysLoadedText` to follow the docs and tell the owner.
- [ ] **Step 2: Write the failing tests**
  - `estimateTokens rounds chars/4 up`: `''` gives 0, `'abcde'` gives 2.
  - `skills count only name and description`: a fixture `SKILL.md` with a 4,000-character body gives the same tokens as its frontmatter lines alone.
  - `agents-md counts the block and the import`: equals `estimateTokens(agentsBlock + '@AGENTS.md\n')`.
  - `plugins, outside skills and MCP are unmeasured`: `tokens: null`, and the id is in `unmeasured`.
  - `measureSelection always includes the harness plugin's own skills`: the `harness-plugin` entry is non-zero for the real `skills/`.
  - `verdict asks when growing past the budget`: before 1,800, after 2,100, budget 2,000 gives `ask: true`; before 2,100, after 2,050 gives `ask: false`; after 1,900 with no new unmeasured id gives `ask: false`.
  - `verdict asks for a new unmeasured item under budget`: before `[]`, after `['gsap-skills']` gives `ask: true` and `added_unmeasured: ['gsap-skills']`.
  - `budgetLines say estimate and name the unmeasured ids`.
  - `budget_tokens default is 2000, and -1 and 1.5 are rejected`.
  - `checklist rows show the context line`.
- [ ] **Step 3: Run them and confirm they fail.**
- [ ] **Step 4: Implement.** Regenerate the example and the README block.
- [ ] **Step 5: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 6: Commit** `src/budget/measure.ts src/core/config.ts src/core/config-io.ts templates/config.example.yaml scripts/gen-config-docs.mjs README.md src/install/select.ts test/budget/ test/core/config.test.ts test/install/select.test.ts`: `feat(budget): measure always-loaded context and ask over budget`.

### Task 14: Settings and MCP merges for plugin and MCP items

**Files:**
- Modify: `src/install/merge.ts` (`mergeSettings` at `:79-145`; add `removeFromSettings`, `mergeMcp`, `removeFromMcp`, `STRUCTURAL`), `src/cli/uninstall.ts` (drop the private `removeFromSettings` at `:30-76`, import it, and handle `.mcp.json` where it handles `SETTINGS`)
- Test: `test/install/merge.test.ts`, `test/cli/uninstall.test.ts`

**Interfaces:**
- Moves: `removeFromSettings(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null` moves from `uninstall.ts:30` to `merge.ts`, exported with the same signature. It gains `plugin` and `marketplace` blocks. It deletes `enabledPlugins` and `extraKnownMarketplaces` when they end up empty and weren't there before init, with its existing `had()` logic (`uninstall.ts:45`).
- Produces: `removeFromMcp(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null`, with the same shape, for `mcp` blocks.
- Produces: `STRUCTURAL: ReadonlySet<string>` = `.claude/settings.json` and `.mcp.json` (ruling 5).
- Produces: `interface PinnedPlugin { name: string; item: string; source: { source: 'github'; repo: string; sha: string } | { source: 'git-subdir'; url: string; path: string; sha: string } }` and `pinnedPlugins(items: CatalogItem[]): PinnedPlugin[]`. For `git-subdir`, `url` is the `owner/repo` shorthand.
- Changes: `mergeSettings(before: string | null, opts: { sandbox: SandboxMode; recorded?: string[]; plugins?: PinnedPlugin[] }): { after; blocks; dropped; notes }` (ruling 4). After the hook, deny and sandbox parts, it handles plugins:
  - It writes `enabledPlugins["<name>@harness-pins"] = true`, with block `{"plugin":"<name>@harness-pins","item":"<id>"}`, when absent.
  - It writes `extraKnownMarketplaces["harness-pins"] = { source: { source: 'settings', name: 'harness-pins', owner: { name: 'harness' }, plugins: [{ name, source }] } }`, with block `{"marketplace":"harness-pins","entry":<that object>}`.
  - A recorded `plugin` block whose plugin isn't in `opts.plugins` is removed from the file and returned in `dropped`.
  - A recorded `marketplace` block equal to the file's entry but not to the wanted entry is replaced in place, the old block goes to `dropped`, and the new one to `blocks`. That is the hook-group rule at `merge.ts:108-112`.
  - An entry that matches no recorded block (the person edited it) is left as is, with the note `` `.claude/settings.json`: the harness-pins marketplace was edited; left as is. harness doctor checks it.`` (plan copy).
  - With no plugins and nothing recorded, it adds neither key.
- Produces: `mergeMcp(before: string | null, servers: { name: string; item: string; config: Record<string, unknown> }[], recorded?: string[]): { after: string; blocks: string[]; dropped: string[]; notes: string[] }`, with block `{"mcp":"<name>","item":"<id>","server":{...}}`, and the same replace and drop rules. It keeps the file's EOL and indent (`eolOf`, `jsonIndentOf`).

- [ ] **Step 1: Write the failing tests**
  - `plugins add enabledPlugins and the harness-pins marketplace`: golden JSON for one `github` and one `git-subdir` plugin, next to the exec-form hook groups and the 30 deny rules.
  - `re-merge with recorded replaces the marketplace entry and drops removed plugins`: going from three plugins to two leaves two `@harness-pins` keys and one entry, and `dropped` holds the old marketplace block and one plugin block.
  - `removing the last plugin deletes both keys harness added`: no empty `enabledPlugins: {}` is left, and `dropped` is non-empty, so `planChanges` writes the file (ruling 6).
  - `existing enabledPlugins and marketplaces survive install and uninstall byte-identical`: the settings file has `"foo@other": true`, another marketplace, an existing `sandbox` key, CRLF and tab indent.
  - `a user-edited harness-pins entry is left and reported`.
  - `user mcp server with the same name is kept and reported`: gives the note ``\`.mcp.json\` already has a server named "playwright"; left as is.``.
  - `mergeMcp creates .mcp.json, and removal deletes it when harness created it and it ends empty`.
  - `harness-pins entry has only documented fields`: `name`, `owner`, `plugins` (and `source` as the wrapper key), and each plugin has only `name` and `source`.
  - `plugin entries leave the ConfigChange guarded view unchanged`: `guardedView` (`src/core/harness-files.ts:53`) of the file before and after a plugin merge is equal (ruling 8).
  - The existing uninstall tests pass, with uninstall now calling the moved `removeFromSettings` and `removeFromMcp`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/merge.ts src/cli/uninstall.ts test/install/merge.test.ts test/cli/uninstall.test.ts`: `feat(apply): plugin, marketplace and MCP blocks with exact removal`.

### Task 15: Plan and apply driven by the selection

**Files:**
- Modify: `src/install/plan.ts` (`planChanges` at `:19-83`), `src/install/manifest.ts`, `src/install/apply.ts` (`Change` at `:10-13` gains `item?: string` on `create` and `update`), `src/cli/update.ts` (`:129-159` move out)
- Test: `test/install/plan.test.ts` (new), `test/install/manifest.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `CatalogItem`, `Selected`, `mergeSettings`, `mergeMcp`, `STRUCTURAL`, `pinnedPlugins`, `removeFromSettings`.
- Changes: `planChanges(root, config, facts, ctx: { version; distDir; templatesDir?; legacyDir?; recorded?: string[]; catalog?: Catalog; mcpRecorded?: string[]; ai?: { picks: string; report: string; product: string } })`. It still returns `{ changes, manual, notes, dropped }`. With `catalog` unset, the legacy path behaves exactly as today. Gating by selected ids (`selectedIds`):
  - The dispatcher, the six hook groups and the 30 deny rules are always installed (ruling 2).
  - `checks` is derived from the selected own items' `checks` (any kind) when `config.items` is non-empty (Q10 (a)). `sandbox` is not derived (ruling 15).
  - The AGENTS.md block and the CLAUDE.md import (`plan.ts:54-57`) are written only with `agents-md`.
  - Each own `files` entry (today `plan.ts:43-44`) is written only with its item, and the `Change` carries `item`.
  - Plugin and external-skill items go to `mergeSettings` through `opts.plugins`. MCP items go to `mergeMcp` with `ctx.mcpRecorded`, and its `dropped` join the returned `dropped` and set `c.dropped` on the `.mcp.json` change, as `plan.ts:50-51` does for settings.
  - The settings write condition stays `blocks.length || dropped.length` (ruling 6).
  - The `ai` files and `.harness/facts.json` (`factsJson`) are written only when `ctx.ai` is set.
- Produces: `selectedIds(config: HarnessConfig): string[]`. These are the ids with `selected: true`. When `config.items` is empty, it returns `LEGACY_OWN = ['agent-guard', 'permissions-baseline', 'stop-gate', 'multi-file-gate', 'tdd-gate', 'staff-reviewer', 'review-rubric', 'agents-md']`, and the checks come from `config.checks` as today.
- Produces: `mergeManifestFiles(old: Manifest, changes: Change[]): Manifest['files']`, in `manifest.ts`, extracted from `update.ts:129-159` (ruling 7). It:
  - applies the results-path rename to recorded blocks or records hunks (today `:130-136`);
  - keeps old blocks unless the change dropped them, using `STRUCTURAL.has(rel)` where `update.ts:142` tests `SETTINGS`;
  - keeps the edited-file hash and backup rules (`:144-154`);
  - drops the entries whose change is `delete`;
  - copies `item` from the change into the entry.
- Changes: `Manifest['files'][number]` gains `item?: string`.
- Changes: `update.ts` calls `mergeManifestFiles`. It keeps dropping `.harness/config.yaml` changes on the plain path (`:77`, ruling 12). On the AI path, the config change is applied.

- [ ] **Step 1: Write the failing tests**
  - `legacy config without items keeps the beta files`: `planChanges` without `catalog` on a platform-enforcement install gives the same change list as before this task, with no `.harness/facts.json`.
  - `deselecting staff-reviewer plans its removal`: the plan has `delete .claude/agents/staff-reviewer.md` when its hash matches. An edited file is kept with a note.
  - `deselecting permissions-baseline turns checks.protect off and keeps all 30 deny rules`.
  - `own items set checks`: unselecting `tdd-gate` gives `checks.tdd: false` in the written config, and no test-config edits.
  - `items never change sandbox`: `sandbox: always` stays `always`, and its `set` blocks stay.
  - `removing the last plugin rewrites settings`.
  - `ai files are written and recorded`: the four `.harness/` files plus `facts.json` are `create` changes, and `report.md` ends with the enforcement sentence.
  - `mergeManifestFiles drops deleted entries`, `replaced marketplace blocks do not accumulate across three updates`, and `mcp blocks are kept as structural blocks`.
  - `update applies the config change on the AI path and keeps only the results_dir migration on the plain path`.
  - The existing `update` tests for the results rename and replaced hook groups pass unchanged through `mergeManifestFiles`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.** The existing init and update tests and S8's upgrade e2e pass unchanged.
- [ ] **Step 5: Commit** `src/install/plan.ts src/install/manifest.ts src/install/apply.ts src/cli/update.ts test/install/plan.test.ts test/install/manifest.test.ts test/cli/update.test.ts`: `feat(apply): install the selected items`.

### Task 16: Claude-Code-only gate (split from old Task 15)

**Files:**
- Create: `src/cli/claude-only.ts`
- Modify: `src/cli/init.ts` (`init` at `:53`), `src/cli/update.ts` (`update` at `:27`; `--check` stays first), `src/cli/index.ts:39` (`tdd off` uses `insideClaude`), every test that calls `init()` or `update()` directly (`test/cli/init.test.ts`, `test/cli/update.test.ts`, `test/cli/noninteractive.test.ts`, `test/cli/doctor.test.ts`, `test/cli/status.test.ts`, `test/cli/uninstall.test.ts` where they install first), `test/e2e/install.e2e.test.ts`, `test/e2e/real-frameworks.e2e.test.ts`, `test/e2e/upgrade.e2e.test.ts` (S8), `.github/workflows/ci.yml`, `.github/workflows/claude-code-weekly.yml` (set `HARNESS_PLAIN_INIT: '1'` for test steps)
- Test: `test/cli/claude-only.test.ts`, `test/cli/init.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Produces: `insideClaude(env: NodeJS.ProcessEnv): boolean` (`!!env.CLAUDECODE`) and `refuseOutsideClaude(cmd: 'init' | 'update' | 'add' | 'sync', env: NodeJS.ProcessEnv, aiFlags: boolean): string | null`.
  - It returns the exact message from Global constraints, or null.
  - It is called inside `init()` and `update()` here, and inside `add()` and `sync()` in Tasks 22 and 23, so tests that call them directly hit it.
  - `update --check` isn't refused.
  - `HARNESS_PLAIN_INIT=1` with `aiFlags` false returns null.
- Changes: with `CLAUDECODE` set and no AI flags, `update` on a beta or platform-enforcement install refreshes files only (the plain path) and ends with ``Run /harness:update again to get recommendations for this repo.`` (plan copy).

- [ ] **Step 1: Write the failing tests**
  - `each AI command refuses without CLAUDECODE`: `init` and `update` exit 2 with their exact message, calling the functions directly. (`add` and `sync` get the same test in their tasks.)
  - `any non-empty CLAUDECODE counts as inside`: `CLAUDECODE=0` doesn't refuse `init`, and `tdd off` refuses under the same value (one helper).
  - `update --check works without CLAUDECODE`.
  - `init refuses without HARNESS_PLAIN_INIT outside Claude Code`. With the variable set, every existing `test/cli/init.test.ts` test passes.
  - `HARNESS_PLAIN_INIT with no AI flags takes the plain path even with CLAUDECODE=1`.
  - `beta repo update inside Claude Code without AI flags refreshes files only`: `CLAUDECODE=1`, a beta manifest, and no AI flags give the platform-enforcement migration (hook groups replaced in place, results path), no item removals, and the closing line above.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Set `HARNESS_PLAIN_INIT: '1'` in the test `env` objects, the e2e `env` objects and the CI test steps.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/cli/claude-only.ts src/cli/init.ts src/cli/update.ts src/cli/index.ts test/cli/ test/e2e/ .github/workflows/ci.yml .github/workflows/claude-code-weekly.yml`: `feat(cli): AI commands run inside Claude Code only`.

### Task 17: AI `init`, plugin installs and the budget ask (split from old Task 15)

**Files:**
- Create: `src/install/plugin-install.ts`
- Modify: `src/cli/init.ts` (`parseArgs` at `:42-51`, USAGE at `:24`, plan at `:117-122`, apply at `:144-155`), `src/cli/update.ts` (USAGE at `:22`, the same AI flags), `src/cli/index.ts:25` (USAGE), `src/install/manifest.ts`
- Test: `test/cli/init.test.ts`, `test/cli/update.test.ts`, `test/install/plugin-install.test.ts`, `test/install/manifest.test.ts`

**Interfaces:**
- Consumes: `refuseOutsideClaude` (Task 16), `validateAnswers`, `validateProduct`, `validatePicks`, `validateReport`, `finalizeReport` (Tasks 10, 11), `resolveSelection`, `toSelected` (Task 12), `measureSelection`, `budgetVerdict`, `budgetLines` (Task 13), `planChanges` (Task 15), `Exec`, `defaultExec` (Task 2).
- Changes: `init` takes `--answers <file> --product <file> --picks <file> --report <file> --choose <id,...> [--install-plugins] [--over-budget] [--dry-run|--yes]`.
  - On the AI path all four files and `--choose` are required. A missing one exits 2 with `init: --<flag> <file> is required inside Claude Code`.
  - Each file is validated with Tasks 10 to 12.
  - The config is `answersToConfig(preset(facts, which).config, answers)`, plus `items: toSelected(...)` and `catalog_version`.
  - `update` takes the same AI flags.
- Changes, the budget ask:
  - After planning, `init` measures `before` (the current selection, `[]` for `init`) and `after` (the new one) with `measureSelection`, and prints `budgetLines(verdict)` with the plan.
  - With `ask` true and `--yes` but no `--over-budget`, it exits 2 before writing, with ``This goes over the context budget (~<after> of <budget> tokens, estimate). Run again with --over-budget to accept, or pick fewer items.`` (plan copy).
  - Interactive without `--yes`: the over-budget lines are printed before `Apply these changes? (y/N)`, and that confirm is the ask.
  - `--dry-run` never refuses; it prints the lines.
- Produces: `installPlugins(ids: string[], exec: Exec = defaultExec): { ok: string[]; failed: { id: string; message: string }[] }`.
  - It runs `claude plugin install <id> --scope project --json` and reads the last stdout line.
  - `missing` gives every id the failure `Claude Code CLI not found on PATH`.
  - A failure whose message names the marketplace (`harness-pins`) is reported as ``Claude Code hasn't registered `harness-pins` yet. Restart Claude Code in this folder (trust it if asked), then run /harness:sync.``
- Produces: `pluginList(exec: Exec = defaultExec): { id: string; version: string; enabled: boolean }[] | null`, from `claude plugin list --json`. Tasks 23 and 24 use it.
- Produces: `rehashManifest(root: string, rels: string[]): void`, in `manifest.ts`. `claude plugin install --scope project` writes `.claude/settings.json`. When the bytes changed, the manifest hash for that file is rewritten through `applyChanges` with a manifest-only transaction, then `stampHarnessFiles(root)` runs (ruling 9).
- Changes: with `--yes --install-plugins`, `init` applies and then installs the `<name>@harness-pins` ids in the same run. It prints one line per plugin, plus the manual command for each failure.
- Changes, C1 (a): when `applyChanges` throws an `ApplyError` caused by `EPERM` or `EACCES` on a harness path, or a plugin install fails with a sandbox network error, the command prints ``Claude Code's sandbox blocks harness's own files. Run this yourself with Claude Code's `!` prefix: <the same command line>`` (plan copy) and exits 1. Nothing is half-written, because `applyChanges` already rolls back.

- [ ] **Step 1: Write the failing tests**
  - `AI init needs all inputs`: a missing `--picks` gives exit 2 with the exact message.
  - `AI init dry run shows the plan and the budget`: the fixture files list `.mcp.json`, `.claude/settings.json` and the five `.harness/` files, the budget lines are printed, and nothing is written.
  - `invalid picks stop before planning`.
  - `over budget with --yes refuses before writing; --over-budget applies`: budget set to 10 in the answers base config.
  - `a new plugin pick asks under budget` (C2 (a)): one plugin pick, budget 2000, `--yes` without `--over-budget` exits 2.
  - `a write the OS refuses rolls back and prints the person's command`: an `FsLike` whose `renameSync` throws `EPERM` for `.claude/settings.json`. The repo is byte-identical afterwards, and the output has the `!` line.
  - `installPlugins reads the JSON result line`: an `ok` outcome and a `failed` outcome, with a preceding non-JSON line.
  - `installPlugins without claude reports every id`.
  - `marketplace not registered gives the restart message`.
  - `rehashManifest updates the settings hash when install changed the bytes, and is a no-op otherwise`, and `rehashManifest stamps the harness files` (no change reported by `changedFiles` afterwards).
  - `init --dry-run with every AI flag writes nothing` (backs C4's `PREVIEW`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/plugin-install.ts src/install/manifest.ts src/cli/init.ts src/cli/update.ts src/cli/index.ts test/cli/init.test.ts test/cli/update.test.ts test/install/plugin-install.test.ts test/install/manifest.test.ts`: `feat(init): AI init with plugin installs and the context-budget ask`.

### Task 18: Guard: the agent asks before item-changing commands

Platform enforcement already asks for `init`, `update` and `uninstall` (`src/checks/guard.ts:58-63`). This task adds table entries only (ruling 10).

**Files:**
- Modify: `src/checks/guard.ts:54-63` (`PERSON_ONLY`, its comment, `PREVIEW`)
- Test: `test/checks/guard.test.ts`, `test/perf/latency.test.ts` (new inputs in the fixture list only)

**Interfaces:**
- Produces: `PREVIEW = (a: string[]) => a.some((t) => t === '--dry-run' || t === '--check' || t === '--plan') && !a.includes('--yes')`. Under C4 (a) it replaces `DRY_OR_CHECK` on `init` and `update`.
- Produces `PERSON_ONLY` entries (each `why` is plan copy, shown as `Confirm: <why>`):
  - `add`: `{ kind: 'ask', allowed: PREVIEW, why: () => 'the agent is adding a harness item, which writes its files and settings' }`
  - `remove`: `{ kind: 'ask', allowed: PREVIEW, why: () => 'the agent is removing a harness item, which deletes its files and settings' }`
  - `sync`: `{ kind: 'ask', allowed: PREVIEW, why: () => 'the agent is syncing the harness items, which rewrites their files and settings' }`
  - `git`: `{ kind: 'ask', allowed: (a) => a[0] === 'branch' || a[0] === 'commit', why: () => 'the agent is pushing or opening a pull request for the harness changes' }`
- Unchanged: `tdd` keeps its deny; `uninstall` keeps `--dry-run` only; a subcommand hidden in a variable or substitution is denied by the existing walk (`guard.ts:205`); the dispatcher turns `ask` into `deny` in unattended runs, with the `Unattended run: ` prefix.

- [ ] **Step 1: Write the failing tests**
  - `add, remove and sync ask in an interactive session`: each through `node "/x/dist/cli.mjs" <sub> x --yes`, `pnpm harness <sub> x --yes`, `npx @khubaibqaiser/harness <sub> x --yes` and a PowerShell `tool_name` (`isShell`).
  - `git push and git pr ask; git branch and git commit are allowed`.
  - `previews are allowed`: `remove x --dry-run`, `add x --dry-run`, `sync --dry-run`, `update --plan`, `update --answers a.json --dry-run`.
  - `a preview with --yes still asks`: `remove x --dry-run --yes`.
  - `the same commands are denied when unattended`: `permission_mode: bypassPermissions` gives deny, with reason `Unattended run: ...`.
  - `a subcommand from a variable is denied`: `H=remove; harness $H x`.
  - Every existing guard test passes, including `mixed --dry-run --yes still asks` and `tdd off is still denied`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Update the `PERSON_ONLY` comment: M3's entries are in.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.** The latency budget holds.
- [ ] **Step 5: Commit** `src/checks/guard.ts test/checks/guard.test.ts test/perf/latency.test.ts`: `feat(guard): agent asks before harness item changes and outward git steps`.

### Task 19: Git step

**Files:**
- Create: `src/install/git-status.ts` (`dirtyPaths` moved from `src/cli/init.ts:30-40`), `src/cli/git.ts`
- Modify: `src/cli/init.ts`, `src/cli/update.ts:16`, `src/cli/doctor.ts:20` (import `dirtyPaths` from its new home), `src/cli/index.ts`
- Test: `test/cli/git.test.ts`

**Interfaces:**
- Consumes: `readManifest`, `detect(root).defaultBranch`, `dirtyPaths`.
- Produces: `harness git branch|commit|push|pr [--title <t>]`. Each subcommand is one step, run by the skill only after the user's yes. It is terminal-safe. The guard asks for `push` and `pr` when the agent runs them (Task 18).
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
  - `push`: `git push -u origin <branch>`. It refuses on the default branch with `You are on <b>. Harness never pushes the default branch.`. The deny rules don't see this push (it isn't a Bash command), so this refusal is the check.
  - `pr`: when `gh` is missing or `gh auth status` fails, it prints the command and exits 0. Otherwise it runs `gh pr create --base <default> --head <branch> --title <title> --body-file .harness/report.md`.
  - A push or `gh` call that fails with a sandbox network error prints the C1 (a) line.

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
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/git-status.ts src/cli/git.ts src/cli/init.ts src/cli/update.ts src/cli/doctor.ts src/cli/index.ts test/cli/git.test.ts`: `feat(git): branch, commit, push and PR as separate confirmed steps`.

### Task 20: The `/harness:init` skill and the reviewer's audit mode

**Files:**
- Modify: `skills/init/SKILL.md`, `.claude-plugin/plugin.json`, `templates/agents/staff-reviewer.md`, `test/package/package.test.ts:44-50`, `test/templates/agents.test.ts`
- Create: `skills/init/interview.md`, `skills/init/recommend.md`

**Interfaces:**
- Consumes: the CLI commands from Tasks 2, 4, 10 to 13 and 16 to 19, by their full command line.
- Produces: `plugin.json` adds `"agents": ["./templates/agents/staff-reviewer.md"]`. It does not register `templates/skills/` (ruling 17).
- Changes: `staff-reviewer.md` gains an **audit mode** section, kept separate from the diff review.
  - Triggered when the caller says `Mode: repo audit`.
  - Inputs: facts, answers, `product.md`, the compact catalog, and a rubric file path. It reads that path.
  - Output, in this order: one fenced `json` block matching `Picks`, then one fenced `markdown` block for the report with the four required headings. No `[sev] file:line` lines and no BLOCKERS summary in this mode.
  - When two items address the same finding, it prefers the one with the lower `cost.context` (the owner's on-demand preference).
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
   - Ask four rows per AskUserQuestion (`multiSelect`), pre-ticked as the CLI says, with reason, cost, context, side effects, and "local only" for plugins.
   - `select --choose`, then show the notices or errors.
5. Apply:
   - `init ... --dry-run`, then show the plan and the budget lines.
   - When the output has `Over budget:`, ask once whether to go over the budget, naming the tokens and any unmeasured ids. On a no, go back to step 4.
   - Ask once: "apply these changes" and, as a separate option when plugins were picked, "also install the plugins for me now".
   - Then run `init ... --yes`, with `--install-plugins` and `--over-budget` as the answers say (one call).
   - When the output has the sandbox line (C1 (a)), show the person the command and stop.
6. Git: ask before each of `git branch`, `git commit`, `git push`, `git pr`.

- [ ] **Step 1: Write the failing tests**
  - Change the skill-format test at `package.test.ts:44-50` to loop over every `skills/*/SKILL.md` instead of the fixed list.
  - `init skill holds every CLI line`: `SKILL.md` contains each full line `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" <cmd>` for `scan`, `validate product`, `validate answers`, `catalog`, `validate picks`, `validate report`, `select`, `init`, `git branch`, `git commit`, `git push` and `git pr`, and mentions `--over-budget`.
  - `side files hold no commands`: `interview.md` and `recommend.md` don't contain `dist/cli.mjs`.
  - `interview.md says never to read .env files or unpointed files`.
  - `recommend.md calls harness:staff-reviewer, passes the rubric path and prefers on-demand items`.
  - `plugin.json registers the reviewer only, and its path exists`.
  - `harness-plugin context stays under 500 tokens (estimate)`: `measureSelection([], …)`'s `harness-plugin` entry (plan copy for the limit; it keeps the plugin's own share small).
  - In `test/templates/agents.test.ts`: `staff-reviewer has an audit mode with picks and report blocks` and `diff review rules unchanged`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the files.**
- [ ] **Step 4: Run `pnpm test`, `pnpm test:perf` and `claude plugin validate .`.** All pass.
- [ ] **Step 5: Commit** `skills/init/ .claude-plugin/plugin.json templates/agents/staff-reviewer.md test/package/package.test.ts test/templates/agents.test.ts`: `feat(skill): interview, recommend, select, apply and git in /harness:init`.

### Task 21: `update` re-recommend

**Files:**
- Create: `src/install/delta.ts`
- Modify: `src/cli/update.ts` (args check at `:29`, USAGE at `:22`), `skills/update/SKILL.md`
- Test: `test/install/delta.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `conflictPairs`, `factsJson`, `planChanges`, `mergeManifestFiles`, `measureSelection`, `budgetVerdict`.
- Produces: `catalogDelta(config: HarnessConfig, c: Catalog): { changed: string[]; retired: string[]; conflicting: [string, string][] }`.
- Produces: `contradictions(prev: Facts | null, now: Facts, config: HarnessConfig): string[]`. It returns the answer keys to re-ask:
  - `apps`, when an app was added or removed;
  - `project.deploy_target`, when `deploy` changed.

  `prev` is parsed from `.harness/facts.json`, or is null when that file is missing.
- Changes: `update --plan` prints `{ recommend: boolean, delta, reask: string[] }` and writes nothing. The guard allows it (Task 18).
  - `recommend` is true when `catalog_version` differs or `factsJson(now)` differs from the stored file.
  - With AI flags, `update` keeps the unchanged answers, then lists new (picks not in `config.items`), changed, retired and now-conflicting items before the diff, then the budget lines (Task 17's ask applies).
- Skill:
  - runs `update --check`, then `update --plan`;
  - re-asks only `reask`;
  - re-runs recommend only when `recommend` is true, and asks before going over the budget as in Task 20 step 5;
  - otherwise runs `update --yes` with no AI flags (template refresh and platform-enforcement migration).

- [ ] **Step 1: Write the failing tests**:
  - one per delta class;
  - `no change means no re-recommend`;
  - `retired items are removed with a line saying why`;
  - `only contradicted keys are re-asked`;
  - `missing facts.json means recommend is true and nothing is re-asked`;
  - `update --plan writes nothing` (backs C4's `PREVIEW`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/delta.ts src/cli/update.ts skills/update/SKILL.md test/install/delta.test.ts test/cli/update.test.ts`: `feat(update): re-recommend on catalog or fact changes`.

### Task 22: `add`, `remove`, `why`, `explain`

**Files:**
- Create: `src/cli/items.ts`, `skills/add/SKILL.md`
- Modify: `src/cli/index.ts` (async routing like `init` at `:104-111`), `src/install/plan.ts`, `src/install/manifest.ts` (per-item lookup)
- Test: `test/cli/items.test.ts`

**Interfaces:**
- Consumes: `resolveSelection`, `toSelected`, `planChanges`, `applyChanges`, `mergeManifestFiles`, `removeFromSettings`, `removeFromMcp`, `refuseOutsideClaude`, `measureSelection`, `budgetVerdict`, `budgetLines`, `stampHarnessFiles`.
- Produces: `itemFiles(m: Manifest, id: string): { rel: string; blocks: string[] }[]`. It returns files whose `item` is `id`, plus structural blocks whose JSON `item` is `id`. Text blocks (AGENTS.md, CLAUDE.md, ignore files) belong to `agents-md` or to the core install.
- Produces:
  - `add <id> [--over-budget] [--dry-run|--yes]`:
    - an AI command that refuses outside Claude Code;
    - adds the `requires` closure, and refuses on a conflict, naming the installed item;
    - sets `reason` to the stored pick's reason if `.harness/picks.json` has one, else `Added by hand with harness add.`;
    - prints the budget lines, and refuses over budget with `--yes` and no `--over-budget` (Task 17's rule);
    - shows the diff, applies, calls `stampHarnessFiles`, then prints `Run harness git commit on a branch to commit this change.`.
  - `remove <id> [--dry-run|--yes]`:
    - terminal-safe, and asked by the guard when the agent runs it;
    - refuses when a selected item requires it, with `<dep> requires <id>; remove <dep> first.`;
    - removes structural blocks through `removeFromSettings`/`removeFromMcp`, so a harness-created `.mcp.json` that ends empty is deleted;
    - `remove agent-guard` also prints `The guard is off now, so the agent can run harness commands without asking.` (plan copy, ruling 16);
    - never asks about the budget (it only shrinks);
    - calls `stampHarnessFiles`.
  - `why <id>`:
    - for an installed item, prints its reason, each addressed finding as `[severity] title`, its cost and its context line;
    - for an item not installed, prints `Not installed. <why> Cost: context <c>, setup <s>.`;
    - for an unknown id, exits 1.
  - `explain` prints one line per selected item (`<id> (<kind>): <reason>`) and the item's files, then the budget's first line for the current selection.
- `skills/add/SKILL.md`: `add <id> --dry-run`, show the diff and the budget lines, ask (and ask about the budget when `Over budget:`), then `add <id> --yes [--over-budget]`.

- [ ] **Step 1: Write the failing tests**:
  - `add pulls in requires`
  - `add refuses a conflict`
  - `add records the pick reason or the hand-added reason`
  - `add over budget refuses with --yes and applies with --over-budget`
  - `add --dry-run writes nothing`
  - `remove refuses a required item`
  - `remove of the last mcp item deletes .mcp.json`
  - `remove then add is byte-identical to before`
  - `remove agent-guard prints the guard line`
  - `add and remove leave no change for change detection` (`changedFiles` of the snapshot before and after `stampHarnessFiles` is empty)
  - `why prints reason, findings and cost`
  - `why for an uninstalled item`
  - `explain lists items and files`
  - `add refuses outside Claude Code; remove, why and explain do not`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/cli/items.ts src/cli/index.ts src/install/plan.ts src/install/manifest.ts skills/add/SKILL.md test/cli/items.test.ts`: `feat: add, remove, why and explain`.

### Task 23: `sync`

**Files:**
- Create: `src/install/reconcile.ts`, `src/cli/sync.ts`, `skills/sync/SKILL.md`
- Modify: `src/cli/index.ts`, `src/cli/update.ts` (the edited-file detection at `:107-112` moves into `reconcile`)
- Test: `test/cli/sync.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Produces: `reconcile(root: string, config: HarnessConfig, m: Manifest, ctx: Parameters<typeof planChanges>[3]): { changes: Change[]; edited: { owned: string[]; merged: string[] }; notes: string[]; dropped: string[] }`. Both `update` and `sync` use it.
- Produces: `sync [--dry-run|--yes] [--take <rel,...>] [--install-plugins] [--over-budget]`, an AI command:
  - selected items with missing files or blocks are re-planned;
  - manifest entries for unselected items are removed;
  - edited files are listed and kept unless named in `--take`;
  - a restore that grows always-loaded context past the budget asks as in Task 17;
  - `--install-plugins` runs `installPlugins` for the selected plugins that `pluginList()` doesn't show, then `rehashManifest`;
  - it calls `stampHarnessFiles` after writing.

- [ ] **Step 1: Write the failing tests**:
  - `deleted managed file is restored`
  - `unselected item's files are removed`
  - `edited file is kept and listed`
  - `--take replaces it`
  - `in-sync repo reports nothing to do`
  - `missing plugins are installed with --install-plugins` (fake exec)
  - `sync refuses outside Claude Code`
  - `sync --dry-run writes nothing`
  - the existing `update` edited-file tests pass through `reconcile`
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/install/reconcile.ts src/cli/sync.ts src/cli/update.ts src/cli/index.ts skills/sync/SKILL.md test/cli/sync.test.ts test/cli/update.test.ts`: `feat(sync): fix drift between config, manifest and files`.

### Task 24: `doctor` and `status` for items

**Files:**
- Modify: `src/cli/doctor.ts` (`DoctorDeps` at `:22`; new lines after the results-path checks at `:164-167`), `src/cli/status.ts` (`status` at `:17`; new lines after the enforcement lines at `:43-48`)
- Test: `test/cli/doctor.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Changes: `DoctorDeps = { claudeVersion?; platform?; pluginList?: typeof pluginList }`. `status(args, cli, deps: StatusDeps = {})` with `StatusDeps = { platform?: NodeJS.Platform; pluginList?: typeof pluginList }` (ruling 13).
- Doctor adds these lines. The existing platform-enforcement lines (Claude Code floor, hook Node, dispatcher self-test, hook shape, sandbox, results path, last blocked settings change) stay as they are and come first:
  - `ok catalog <n>`, or `note catalog <n> is newer than this repo's <m>: run /harness:update`.
  - `fix <id> is missing <rel>: run /harness:sync` (item drift, files and structural blocks).
  - `fix <id> is enabled in this repo but not installed: claude plugin install <id> --scope project`.
  - `note <id> is <v>, the catalog pins <p>: run claude plugin update <id> --scope project`. This is skipped when `plugin_version` is unset.
  - `note <name> is enabled twice (<other> and harness-pins); only one copy's hooks run. Disable one.`
  - `note the harness-pins marketplace or a harness MCP server differs from what harness installed: run /harness:sync` (the edited-entry case from Task 14, and C5 (a)).
  - `note config.yaml checks differ from the selected items (<keys>); the items win on the next update. Use harness add or remove to change gates.` (Q10 (a)).
  - When `claude` is missing or its JSON is unreadable, one `note` is printed and the plugin checks are skipped.
- Status adds `Catalog <n>`, the selected item count, the not-installed plugin count, and the budget's first line for the current selection.

- [ ] **Step 1: Write the failing tests**, one per line above, with a fake `pluginList`. The existing doctor and status tests pass unchanged.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/cli/doctor.ts src/cli/status.ts test/cli/doctor.test.ts test/cli/status.test.ts`: `feat(doctor): catalog version, item drift and plugin version drift`.
- [ ] **Step 6 (only if Task 27 finds that an allow rule skips the ask, Q11 (b)):** add `note an allow rule (<rule>) lets the agent run harness item commands without asking; remove it to keep the ask`, with its test, as a follow-up commit on this slice.

### Task 25: End-to-end with a fake AI step

**Files:**
- Create: `test/e2e/recommend.e2e.test.ts`, `test/fixtures/ai/{answers.json,product.md,picks.json,report.md}`, `test/fixtures/catalog-e2e/` (two catalog versions)

- [ ] **Step 1: Write the test** `fake AI step through select, apply, update, remove, uninstall leaves the repo byte-identical`.
  - Setup:
    - the `pnpmMonorepo` fixture (`test/e2e/fixtures.ts:36`), whose path already has a space and `ü` (`PREFIX`, `:5`);
    - `CLAUDECODE=1`, `HARNESS_PLAIN_INIT=1` and `HARNESS_CATALOG_DIR=test/fixtures/catalog-e2e/v1`;
    - a fake `claude` on PATH that answers `plugin install` and `plugin list --json`.
  - Steps:
    1. `validate answers`, `validate product`, `validate picks` and `validate report` all exit 0.
    2. `select --choose` one own item, one plugin and one MCP item.
    3. `init ... --yes --install-plugins` exits 2 with the budget refusal (the plugin is unmeasured); the repo is unchanged.
    4. `init ... --yes --install-plugins --over-budget`.
       - `.claude/settings.json` has the six exec-form hook groups, the 30 deny rules and `<name>@harness-pins`, and `.mcp.json` has the server.
       - The fake `claude` received `plugin install <name>@harness-pins --scope project --json`.
       - The manifest hash matches the settings bytes, and change detection reports nothing.
    5. Hook inputs piped into the installed dispatcher still give the platform-enforcement decisions (reuse the existing helper), including a `ConfigChange` input for the plugin write, which is allowed.
    6. With `HARNESS_CATALOG_DIR=.../v2` (one sha changed), `update --plan` lists the item under `changed`, and the AI `update` applies the new pin with no duplicate marketplace block in the manifest.
    7. `remove <mcp id> --yes`, and `.mcp.json` is gone.
    8. `uninstall --yes`. `git status --porcelain` is empty, and every pre-existing file is byte-identical.
- [ ] **Step 2: Run `pnpm vitest run --project e2e test/e2e/recommend.e2e.test.ts`.** A failure is a bug in the owning task, fixed there.
- [ ] **Step 3: Run `pnpm test` and `pnpm test:perf`.** The owner pushes, and the CI matrix must pass.
- [ ] **Step 4: Commit** `test/e2e/recommend.e2e.test.ts test/fixtures/ai/ test/fixtures/catalog-e2e/`: `test(e2e): recommend flow through uninstall, byte-identical`.

### Task 26: README and release notes (split from old Task 24)

**Files:**
- Modify: `README.md`. It gains:
  - the `/harness:init` flow;
  - teammate setup, with the exact `claude plugin install` command and `/harness:sync`;
  - the context budget: what counts, that numbers are estimates, `context.budget_tokens`, and `--over-budget`.
  - It does not mention `HARNESS_PLAIN_INIT` or `HARNESS_CATALOG_DIR`.
- New known limits in the README, next to platform enforcement's (S9):
  - plugin picks are "local only" and are missing in cloud sessions;
  - `extraKnownMarketplaces` needs folder trust;
  - MCP servers need each user's approval;
  - `CLAUDECODE` is also set in IDE terminals (Q6);
  - there is no version-drift check for `git-subdir` plugins;
  - the agent asks before item changes;
  - plugins and MCP servers aren't measured before install, and only the person installing is asked about the budget (ruling 18);
  - under `sandbox: always`, item commands may need the `!` prefix (C1, with Task 27's result).
- Create: `docs/release-notes/<version>.md`
- Test: `test/package/readme.test.ts`:
  - the README contains neither test variable;
  - the README names `context.budget_tokens`;
  - the release notes list every id in `catalog/excluded.yaml`, and every `git-subdir` item without `plugin_version`.

- [ ] **Step 1: Write the failing test.**
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the README changes and the release notes.** The notes give:
  - the catalog version and item count;
  - every excluded id with its reason (Q3's 22 and the research exclusions);
  - the unpinned items with their reasons;
  - the known limits.
- [ ] **Step 4: Run `pnpm test` and `pnpm test:perf`, then request the final whole-branch review.**
- [ ] **Step 5: Commit** `README.md docs/release-notes/ test/package/readme.test.ts`: `docs: M3 recommend README and release notes`.

### Task 27: Live checks and live runs (gated: owner approval before each batch)

**Paid: it runs real Claude Code sessions.** No step here runs until the owner approves that batch in chat. Everything runs in local dummy repos under the scratchpad that are never pushed. Results go to the controller; this task commits nothing. Each finding is fixed in the owning slice, and the offline suite is re-run.

- [ ] **Step 1: Ask the owner for approval of batch A (checks).** Name the checks below and the machine. Wait for a clear yes.
- [ ] **Step 2: Batch A, the checks moved from the old Tasks 15 and 16** (ruling 11). Record each with Claude Code's version and the observed result:
  1. On a scratch repo with a hand-written `harness-pins` entry in `.claude/settings.json` and a trusted folder, run `claude plugin install <one pinned plugin>@harness-pins --scope project --json`. Record whether it succeeds before any interactive session has registered the marketplace, the result JSON, and `.claude/settings.json` bytes before and after. If it never works before a restart, the skill asks for the restart before `--install-plugins` (Task 20).
  2. `claude -p --plugin-dir <this repo> "Use the harness:staff-reviewer subagent to say which skills you have preloaded"`. Record whether `review-rubric` was preloaded through the bare `skills:` name.
  3. Whether `Read` of a file under the plugin root, from inside that subagent, prompts.
  4. In an interactive session with the dispatcher installed and `Bash(node:*)` in `.claude/settings.local.json` `allow`, have the agent run `node <cli> remove multi-file-gate --yes`. Record whether the prompt still appears (Q11; decides Task 24 step 6).
  5. Under `sandbox: always`, have the agent run `/harness:add <own item>`. Record whether the write is refused, and whether a `!`-prefixed run of the same command runs unsandboxed with `CLAUDECODE` set (C1).
  6. `ConfigChange` fires on the `claude plugin install` write, and harness allows it (ruling 8).
- [ ] **Step 3: Ask the owner for approval of live-run batch 1 (a JS repo).**
- [ ] **Step 4: Batch 1.** Run real `/harness:init` with `--plugin-dir`. Record:
  - each question asked;
  - the subagent's raw output;
  - whether validation passed first time;
  - the checklist batching;
  - the plan and the budget lines, and whether the budget ask appeared when it should;
  - the permission prompts seen;
  - `claude plugin list --json` after the install.
  - `push` and `pr` run against a local bare remote only.
- [ ] **Step 5: Owner verdict.** The owner judges the report and picks. Each wrong pick is fixed in the owning task's files (rubric, audit-mode text, or catalog `why`) before the next batch.
- [ ] **Step 6: Batch 2 (a Python repo) and batch 3 (a local copy of fitness-app, original untouched).** Each runs after its own approval, with the same records.
- [ ] **Step 7: Check a teammate clone works.** Clone the dummy repo locally and trust the folder. Run the printed `claude plugin install` command, or `/harness:sync`. The plugin should load and `doctor` should be clean.
- [ ] **Step 8: Report** every result to the owner, with the slice each fix went to.

## Owner actions this plan depends on

- Merge S1 to S9 (or approve stacking M1 on S9's tip) and this plan's PR before M1.
- Rule on C1 to C5, or confirm the recommended options, before the task each names.
- Approve each batch in Task 27 separately.
- Push each slice's branch after its gate passes, and merge them in order M1 to M26.
- Rule on any refresh ruling above you read differently, before the task that owns it.
