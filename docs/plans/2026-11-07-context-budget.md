# Context budget and context-optimize implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. The owner confirms the method in review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** harness measures everything a repo loads into every Claude Code session, against a 2,000-token budget. It shows the result in `harness context`, `doctor` and `status`, asks before its own commands go over the budget, and applies trims it owns only on a yes. `/harness:context-optimize` proposes diffs for the person's own files. A SessionStart `compact` hook adds a 5-line state card after compaction.

**Size:** 18 tasks. Each is one PR, at or under 400 changed lines and 20 files (estimated at planning, measured at PR time).

**Architecture:**
- **Measuring.** `src/budget/` gets the repo side next to M3's `measure.ts`. Each file has one job:
  - `text.ts`: the text rules;
  - `imports.ts`: `@path` expansion;
  - `sources.ts`: always-loaded files;
  - `on-demand.ts`: on-demand files and the not-measured list;
  - `owners.ts`: who owns each file, from the manifest;
  - `summary.ts`: the combined offline set that `doctor`, `status`, the report and `harness context` all show;
  - `count-api.ts`: the token-counting API seam;
  - `recommend.ts`: the deterministic recommendations.
- **No double count.** The disk is the truth for files: harness's installed skills, agents and the `AGENTS.md` block are measured where they sit, with owners taken from the manifest. `measureSelection` contributes only what isn't on disk: the `harness-plugin` entry and the catalog plugin, external-skill and MCP picks. The budget asks are different, because they measure a selection before it is written. There, `measureSelection(ids)` is joined with the repo's own (`owner: 'repo'`) entries only.
- **CLI.** `src/cli/context.ts` handles the report and `--json`. `src/cli/context-apply.ts` handles `apply`. A `name-only` change goes through `mergePresetSettings` with no recorded blocks, so it only adds, and through `applyChanges`. A `remove` change calls `items('remove', …)`.
- **Hooks.** One new pure check, `state-card`, runs on SessionStart. One new fragment group, `SessionStart` with matcher `compact`.
- Every network call goes through an injected `fetch`, and every file read through an injected `RepoIO`. Tests never touch the network or the home folder.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml` (already a dependency). No new dependency.

**Spec:** `docs/specs/2026-11-03-context-budget-design.md` (owner-approved 2026-11-03, binding; §16 holds the rulings). Section numbers (§n) and ids (D, C, Q, X, U) refer to it.

## Spec drift against `main` 0cd5562 (resolved here)

The spec was written on 2026-11-03, before M3, the preset, PR size and the usage report merged. Checked against `main` 0cd5562 on 2026-11-07:

1. **Names that match.** `DEFAULT_CONTEXT_BUDGET`, `estimateTokens`, `alwaysLoadedText`, `ContextEntry`, `ContextMeasure`, `CountTokens`, `itemContext`, `measureSelection`, `budgetVerdict`, `budgetLines`, `itemContextLine`, `--over-budget` and `context.budget_tokens` (`num(0, 200000, true)`) are all in `src/budget/measure.ts` and `src/core/config.ts` as §12 says. `withNotice`, `emit`, `mergeContext` and `capMessage` exist after the dispatcher split (`src/hooks/{dispatch,io,notice}.ts`).
2. **`measureSelectionSync` and `extra` are new.** `status` and the usage report use the sync form. `extra` carries the preset's rows (`presetContext`). Task 8 joins the repo entries to `extra`, and Task 7 adds the `count` seam to the async form only.
3. **`exempt` (M3's "ask once, then exempt") isn't in the spec.** Items the person approved earlier keep an entry but don't count again (`approvedIds`, `docs/reference.md` "Context budget"). That stays. Q1's "what every teammate gets" applies to the totals shown by `harness context`, `doctor` and `status`, which never pass `exempt`. The budget asks keep `exempt` for selection items. The repo's own entries are never exempt.
4. **Skills that already have `disable-model-invocation: true`:** `add`, `init`, `sync` and `vet`. Q2 still needs `update` and `uninstall` (Task 1). `doctor` and `status` stay visible. The plugin now has 8 skills, not 5.
5. **`alwaysLoadedText` ignores `disable-model-invocation` today.** So `pluginEntry` counts all 8 plugin skills, and `src/vet/scan.ts:372` counts disabled skills too. Task 1 fixes the shared function, so both get it.
6. **The plugin registers `staff-reviewer` as a plugin agent** (`.claude-plugin/plugin.json` `agents`). An install also writes `.claude/agents/staff-reviewer.md`. Both load, so both count (~50 tokens each).
7. **The footprint has grown.** Measured on 0cd5562 (offline, characters ÷ 4, M3's rules):
   - the agents-md item: ~277 (block plus the `@AGENTS.md` line; `itemContext` keeps the markers);
   - plugin skills: ~295 today, and ~93 after Task 1 (`doctor` ~49, `status` ~44);
   - plugin agent: ~50;
   - `review-rubric`: ~49;
   - `pr-ship`: ~34;
   - project agent: ~50.

   That totals about 553 after Task 1, not the spec's 444. Task 1's footprint constant is the number measured in that task (owner decision 3; the spec's §11 is updated).
8. **The preset** writes its own `AGENTS.md` block (`<!-- harness:preset:start -->`) and skills recorded as `item: "preset:<id>"`. §3 knows only `harness`, `catalog:<id>` and `repo` as owners. Task 4 adds `preset:<id>` and counts it with harness in every total (owner decision 1).
9. **`cost.context_tokens` doesn't exist** in `src/catalog/schema.ts` (`cost: { context; setup }`, with unknown keys refused). There are 72 plugin and 6 external-skill items. `src/vet/fetch.ts` (`fetchTarball`) and `src/vet/scan.ts` (`scan(...).context.tokens`) already measure an item's always-loaded tokens at a sha. Tasks 17 and 18 reuse them. Filling the 78 values needs network, and the owner does it (owner decision 4).
10. **A recorded `skillOverrides` set block would be deleted by the next update.** `src/install/plan-preset.ts:35` says "Every recorded `set` block outside `sandbox` is the preset's today; a new writer of set blocks needs its own marker here". `mergePresetSettings` drops any non-sandbox set block it doesn't want. Task 13 excludes `set[0] === 'skillOverrides'` in both places.
11. **The fragment wires 6 events** (no SessionStart). The dispatcher already accepts `SessionStart` (`EVENTS` in `dispatch.ts`). Nothing runs on it, and change detection only *compares* at Stop, UserPromptSubmit and SessionEnd. So wiring it can't block, renew a baseline or eat a Stop attempt. `doctor` hard-codes `all 6 hook events` and its own `EVENTS` list. Task 11 adds the event there and derives the count.
12. **The doctor's missing-group copy.** Doctor's per-group loop already reports a missing fragment group as ``fix `.claude/settings.json`: `hooks.SessionStart` is missing the harness group for `compact`: run /harness:update``, and a missing event as `does not run the dispatcher for SessionStart`. The spec's bespoke line (`no compaction state-card hook…: run harness update`) would say the same thing a second time. Task 11 uses the existing lines (owner decision 5).
13. **`src/cli/doctor.ts` is 296 lines,** against the 300 limit. Task 9 puts the context lines in a new `src/cli/doctor-context.ts`, and doctor gains one import and one call.
14. **The state card's sources.**
    - `harnessNoticed` is a JSON list of `[file, hash]` pairs, not notice text. Line 5 builds its item from the file names.
    - `pendingNotice` is newline-joined notice text.
    - `status`'s `GATES` list now has 7 entries (it includes `pr-size`). It moves to a leaf `src/core/gates.ts`, so the hook bundle doesn't import `src/cli/status.ts`.
15. **"Degraded: only lines 1 and 2" can't hold.** A degraded dispatcher runs only `failClosed` checks, and the card is pure and fail-open, so it prints nothing. A missing state file gives a fresh state, never an error, so the card prints all 5 lines from it (`0` files, `none`). The plan drops the 2-line case (owner decision 6). The card reads `ctx.configErrors`, a new optional `Ctx` field set by `dispatch.ts`, to write line 2's invalid-config text.
16. **`sync` also calls `budgetGate`.** The spec lists `init`, `update` and `add`. All four get the widened ask, because Task 8 changes `budgetGate` itself.
17. **Unattended (Q6).** `isUnattended(input, env)` needs a hook input. The CLI has none, so Task 8 adds `unattendedEnv(env)` (the env parts) and `isUnattended` calls it.
18. **The usage report** (`src/report/metrics/usage.ts` `alwaysLoaded`) counts the whole `AGENTS.md` and `CLAUDE.md` *plus* the agents-md item, so the harness block counts twice. That is §12's "M3, TD, PS plug in" point for the report: Task 16 feeds it from `summary.ts`. Its export folds unknown ids to `other`, so repo paths never leave the machine.
19. **TD isn't merged.** No `harness-decision-*` rules, pointer line or `remember add` exist on `main`. The plan measures any `.claude/rules/**` file and labels `harness-decision-*` files as "team decisions". It adds no TD code.
20. **`measureRepo` returns a `RepoMeasure`,** not a bare `ContextEntry[]`. The on-demand and not-measured lists need somewhere to live. Its entries extend `ContextEntry`, so `budgetVerdict` takes them unchanged. `measureRepo` doesn't read `dirs.plugin`; the plugin row stays `measureSelection`'s.
21. **`CountTokens` gives no failure reason,** but §4's fallback line needs one. `apiCountTokens` takes an `onFail(reason)` callback.
22. **The "README known limits"** now live in `docs/reference.md#known-limits`. The config table is generated into `docs/reference.md` by `scripts/gen-config-docs.mjs --write`, and `templates/config.example.yaml` comes from `serializeConfig(defaults())`.

## Planning checks, run 2026-11-07

- **SessionStart payload (D6).** Read from code.claude.com/docs/en/hooks with WebFetch. The page was truncated past character 100,000, so the SessionStart section's example payload wasn't read.
  - The `source` values are `startup`, `resume`, `clear`, `compact` and `fork`. A matcher made only of word characters matches exactly, so `"compact"` works.
  - Output goes in `hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }`, which `emit` already writes for a `context` decision. Plain stdout is also added as context.
  - `additionalContext` is capped at 10,000 characters.
  - SessionStart has "No blocking or decision control". `onFailure` "does what exit 2 does on that event", which doesn't block there, so the group carries none (spec §9).
  - A `PostCompact` event exists (matchers `manual`, `auto`), with no decision control. It isn't used: the spec chose SessionStart `compact`, whose output reaches the model.
  - **Still to confirm live:** that `source` is the field name on the compact payload (live check 2).
- **Footprint.** Measured on 0cd5562 with `alwaysLoadedText`/`estimateTokens` bundled by esbuild (drift 7).

## Live checks (owner-run; not tasks)

These are §13's five checks, run as one batch after Task 15 merges and only with the owner's OK.
- **Checks 1 to 4 run Claude Code sessions and cost money.**
- **Check 5 uses `ANTHROPIC_API_KEY`.** The endpoint is free, but it needs the owner's key and network.

Results update the spec's §17 (U1 to U8):
- U2 decides whether rules and skills strip HTML comments too.
- U7 decides whether `name-only` may ever target a preloaded skill.
- U8 decides whether the divisor of 4 stays.

## Global constraints

- **Budget.** `context.budget_tokens` defaults to 2000 (D4). Only always-loaded text counts. The state card is listed as `after compaction: state card, at most ~300` and never counted.
- **The API key (D5, §4).**
  - `ANTHROPIC_API_KEY` is read from the env in `src/cli/context.ts` only, and sent only as the `x-api-key` header to `https://api.anthropic.com/v1/messages/count_tokens`.
  - It is never printed, logged, written to `events.jsonl` or a debug file, put in an error message, or passed to a child process.
  - Failures are reported by HTTP status or a fixed reason word only.
  - Harness never prompts for a key and never reads one from settings, `apiKeyHelper` or files.
- **Offline everywhere else (C12, Q4).** `doctor`, `status`, the budget asks, the report and the dispatcher never pass a `CountTokens`, so they never call `fetch`.
- **What is read (C2, §3).**
  - Files under the repo root only, plus `dirs.plugin` (through `measureSelection`).
  - Never `~/.claude`, the plugin cache, `installed_plugins.json`, auto memory, a parent folder, `.env*` or a `.harnessignore` path.
  - The only process spawned is `git ls-files`.
- **Copy.** §7 and §10 verbatim, except where a task gives the drift-adjusted text. Numbers use `toLocaleString('en-US')`, and offline numbers carry `~`. The API count is never called "exact" (C7).
- **No per-prompt injection (D7).** Only SessionStart with `source === 'compact'` gets the card.
- **Guard.** `context apply` joins `PERSON_ONLY` as `ask`. There is no new regex and no deny-rule change.
- **Size rules for every file touched:** `max-lines` 300, `max-lines-per-function` 50, `max-depth` 4, `max-params` 4, `complexity` 20. Thresholds are named constants, never bare numbers.
- **Tests.**
  - TDD: red first.
  - No network: `fetch`, `RepoIO`, `Exec` and `ExecBytes` are injected.
  - No `claude -p` and nothing paid.
  - `pnpm test` passes with `claude` off PATH: ``PATH="$(node -p "process.env.PATH.split(require('path').delimiter).filter(d=>!require('fs').existsSync(require('path').join(d,'claude'))).join(require('path').delimiter)")" pnpm test``.
  - A sentinel key value `sk-ant-TEST-SENTINEL-0000` is searched for in every captured output of the CLI tests.
- **Process.**
  - One PR per task, off `main`, on branch `feature/ctx-<n>-<slug>`. Rebase before starting and before merging.
  - Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit -m "…" -- <explicit paths>`, with no AI trailer and no footer.
  - Each task's last step checks `README.md` and `docs/reference.md`. Its PR body says "README: updated (…)" or "README: checked, no change", and the same for "reference.md".
- **Gates.** `pnpm typecheck` and `pnpm test` pass at the end of every task. `pnpm test:perf` also passes after Tasks 10 and 11.

## Review focus

1. **A hostile or huge repo file.** A 50 MB `CLAUDE.md`, a binary `AGENTS.md`, an import cycle, or `@../../etc/passwd`. Expected: a file over 4 MiB is sized, not read, and counts 0. Nothing outside the root is read; it is listed as an external import. A cycle stops. No throw (Task 3 and Task 4 tests).
2. **The key leaking through an error.** A `fetch` that throws an `Error` whose message contains the request headers, or a 401 body that echoes the key. Expected: the fallback line names the status or `network error` only, and the sentinel key appears in no output (Task 7 test).
3. **`update` or `sync` after `context apply`.** Expected: the `skillOverrides` set block survives an update with and without a preset, and `uninstall` still restores the file byte for byte (Task 13 test, drift 10).
4. **Compaction in a session whose harness files changed, or whose config is invalid.** Expected: the card still prints (no early return), line 2 says the config is invalid, no `systemMessage` comes from the card, and no Stop attempt or baseline changes (Task 10 test).
5. **A repo with no manifest, or one where `git ls-files` isn't available** (not a git repo, or git missing). Expected: `harness context` still reports, with every file owned by `repo` and nested files not listed, plus one note. `doctor` and `status` never throw on it (Task 5 and Task 12 tests).

---

## Dependencies and parallel lanes

| Task | Lane | Depends on (must be on `main`) | Files touched |
|---|---|---|---|
| 1 Skill frontmatter and `alwaysLoadedText` | A | none | `src/budget/measure.ts`, `skills/update/SKILL.md`, `skills/uninstall/SKILL.md`, `test/budget/measure.test.ts`, `test/package/package.test.ts` |
| 2 `context.count` and `count_model` keys | C | none | `src/core/config.ts`, `src/core/config-io.ts`, `scripts/gen-config-docs.mjs`, `templates/config.example.yaml`, `docs/reference.md` |
| 3 Text rules and `@` imports | A | none | `src/budget/text.ts`, `src/budget/imports.ts` (new) |
| 4 `measureRepo`: always-loaded sources and owners | A | 1, 3 | `src/budget/sources.ts`, `src/budget/owners.ts` (new) |
| 5 On-demand sources and not-measured list | A | 4 | `src/budget/on-demand.ts` (new), `src/budget/sources.ts` |
| 6 The combined offline set | A | 5 | `src/budget/summary.ts` (new) |
| 7 Token-counting API seam | A | 1, 2 | `src/budget/count-api.ts` (new), `src/budget/measure.ts` |
| 8 Budget asks: widened line, repo entries, unattended | A | 6, 7 | `src/budget/measure.ts`, `src/cli/install-selection.ts`, `src/core/unattended.ts`, `src/cli/{init,update,items,sync}.ts` (call sites) |
| 9 `doctor` and `status` lines | D | 6 | `src/cli/doctor-context.ts` (new), `src/cli/doctor.ts`, `src/cli/status.ts` |
| 10 State-card check | B | none | `src/checks/state-card.ts`, `src/core/gates.ts` (new), `src/cli/status.ts`, `src/hooks/{dispatch,check}.ts` |
| 11 SessionStart group, 7 events | B | 10, 9 | `templates/settings.fragment.json`, `src/cli/doctor.ts`, `test/templates/settings.test.ts`, `test/cli/doctor.test.ts` |
| 12 `harness context` report and `--json` | A | 6, 7 | `src/cli/context.ts`, `src/cli/context-copy.ts` (new), `src/cli/index.ts` |
| 13 Recommendations and `context apply` | A | 12 | `src/budget/recommend.ts`, `src/cli/context-apply.ts` (new), `src/cli/context.ts`, `src/install/plan-preset.ts`, `src/install/merge.ts`, `src/checks/guard.ts` |
| 14 `/harness:context-optimize` skill | A | 13 | `skills/context-optimize/SKILL.md` (new), `test/skills/context-optimize.test.ts` (new), `README.md`, `docs/reference.md` |
| 15 Known limits and the budget docs | A | 14, 11 | `docs/reference.md`, `README.md`, `test/package/readme.test.ts` |
| 16 Usage report always-loaded rows | E | 6 | `src/report/metrics/usage.ts`, `test/report/usage.test.ts`, `test/report/export.test.ts` |
| 17 `cost.context_tokens` in the catalog | F | 1 | `src/catalog/schema.ts`, `src/budget/measure.ts` (`itemContext`) |
| 18 Measure `context_tokens` at the pinned sha | F | 17 | `src/catalog/context-check.ts` (new), `src/cli/catalog.ts` |

- **Start now, in parallel:** 1, 2, 3 and 10. They touch no common file.
- **Lane A is serial,** through `measure.ts` (1 → 7 → 8) and `sources.ts` (4 → 5).
- **Task 17** edits `itemContext` in `measure.ts`. It merges after 8 or rebases onto it; there is no shared hunk with 7 or 8.
- **Lane B and Lane D share `status.ts` and `doctor.ts`.**
  - Task 10 (moving `GATES`) and Task 9 (the `Context:` line) both touch `status.ts`. Whichever merges second rebases.
  - Task 11 waits for Task 9 because both edit `doctor.ts`.
- **Task 16** (lane E) needs only Task 6. Task 18 needs only Task 17.
- `docs/reference.md` is shared by most tasks, so each task's docs step is its last step, done after rebasing.

## Plan decisions the spec leaves open (the owner can change them in review)

- **Branches:** `feature/ctx-<n>-<slug>`.
- **The first report line when over the budget:** `Context budget: ~2,410 of 2,000 tokens always loaded, over by ~410.` The same method sentence follows on that line as when within the budget.
- **The fallback line** (`Couldn't use the token-counting API (…); counts are best estimates.`) is the report's second line. Reasons: the HTTP status number, `timeout`, `network error` or `sandbox network`.
- **Recommendation thresholds, as named constants in `recommend.ts`:**
  - `NAME_ONLY_SHARE = 0.8`;
  - `LONG_FILE_LINES = 200`;
  - `MOVE_SHARE = 0.25`;
  - `DESCRIPTION_MAX = 1536`;
  - `SIDE_EFFECT = /\b(git push|gh pr create|npm publish|pnpm publish|yarn publish|deploy)\b/`.
- **`name-only` never targets a skill that any `.claude/agents/*.md` frontmatter lists under `skills:`.** That is C10, made generic. Live check 4 can lift it later. On `main` it rules out `review-rubric`.
- **Doctor:** when harness alone is over the budget, the `fix` line replaces the `note` line (only one prints).
- **`harness context apply` exit codes:** 0 applied or nothing to do, 1 apply failed, 2 usage error or refusal.

## Owner decisions (2026-11-07)

The owner answered questions 1 to 4, and the coordinator ruled on 5 and 6. All six took the recommended option and are **resolved**. They are recorded in the spec's §16 as C13 to C18.

1. **Resolved: preset ownership.** Preset files get the owner `preset:<id>`. They count with harness in every total, and `name-only` may target their skills (Tasks 4, 6, 13).
2. **Resolved: API counts against catalog-recorded numbers.** The recorded number stays, marked `(catalog estimate)`. The header adds `except <n> catalog estimates` (Task 12).
3. **Resolved: the footprint.** About 553 tokens is accepted. Task 1's constant is the measured value, and nothing else is removed. The spec's §11 is updated.
4. **Resolved: filling `cost.context_tokens`.** The owner runs `harness catalog check --resolve --context --write-context` once, locally, and commits the values. CI adds `--context` afterwards (manual step after Task 18).
5. **Resolved: the doctor copy.** Doctor uses only the existing per-group fix line for a missing SessionStart group (Task 11, drift 12).
6. **Resolved: the degraded dispatcher.** It prints no card. A missing state file gives the full card from a fresh state (Task 10, drift 15).

---

### Task 1: Skill frontmatter (Q2) and `alwaysLoadedText` follows the docs

**Lane A. Depends on:** nothing.

**Files:**
- Modify: `src/budget/measure.ts` (`alwaysLoadedText`), `skills/update/SKILL.md`, `skills/uninstall/SKILL.md`
- Test: `test/budget/measure.test.ts`, `test/package/package.test.ts`, `test/vet/*` (must stay green)

**Interfaces:**
- Produces:
  - `alwaysLoadedText('skill', text)` returns `''` when the frontmatter has `disable-model-invocation: true`.
  - Otherwise it returns `name: <name>\ndescription: <description + ' ' + when_to_use>`, with the description part cut at `SKILL_DESCRIPTION_MAX = 1536` characters.
  - `kind === 'agent'` is unchanged.
  - `export const SKILL_DESCRIPTION_MAX = 1536`.
  - `export const footprint = (dirs: { templates: string; plugin: string }, c: Catalog): number`, which is `measureSelectionSync(LEGACY_OWN, c, dirs).tokens`. `LEGACY_OWN` comes from `src/install/plan.ts`; no circular import exists today (check with `pnpm typecheck`).

- [ ] **Step 1: Write the failing tests.**
  - **`measure.test.ts`:**
    - a skill with `disable-model-invocation: true` gives `''`;
    - `when_to_use: Use it on X.` is appended after one space;
    - a 2,000-character description plus `when_to_use` is cut to 1,536 description characters;
    - `pluginEntry` over a fixture with one disabled and one visible skill counts only the visible one.
  - **`package.test.ts`:**
    - `init`, `update`, `uninstall`, `add`, `sync` and `vet` have `disable-model-invocation: true`; `doctor` and `status` don't;
    - `footprint({ templates: 'templates', plugin: '.' }, loadCatalog().catalog)` is at most `HARNESS_FOOTPRINT`, a named constant set to the value measured in Step 4 (about 553 at planning; drift 7). The comment says "raise only in a reviewed PR".
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/measure.test.ts test/package/package.test.ts`.
- [ ] **Step 3: Implement.** Add `disable-model-invocation: true` as the third frontmatter line of `skills/update/SKILL.md` and `skills/uninstall/SKILL.md`. The frontmatter regex in `package.test.ts:49` already allows it.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`. Record the footprint value in the constant and in the PR body. `test/vet` must pass unchanged, or the PR body names each changed number.
- [ ] **Step 5: Check the docs.**
  - `docs/reference.md` "Context budget": "For a skill, that's its name and description, plus `when_to_use`; a skill with `disable-model-invocation: true` costs nothing."
  - Known limits: "`init`, `update`, `uninstall` and `context-optimize` start only from their slash commands, not from plain words."
  - PR body: "README: checked, no change; reference.md: updated (context budget, known limits)".
- [ ] **Step 6: Commit.** `feat(budget): honour disable-model-invocation; update and uninstall are slash-only`.

### Task 2: `context.count` and `context.count_model`

**Lane C. Depends on:** nothing.

**Files:**
- Modify: `src/core/config.ts` (type, `defaults`, `RULES`), `src/core/config-io.ts` (`SECTIONS.context`), `scripts/gen-config-docs.mjs` (`WHAT`), `templates/config.example.yaml`, `docs/reference.md` (regenerated)
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/package/readme.test.ts` (unchanged)

**Interfaces:**
- Produces:
  - `HarnessConfig.context: { budget_tokens: number; count: 'auto' | 'offline'; count_model: string }`, defaulting to `{ budget_tokens: 2000, count: 'auto', count_model: 'claude-opus-5-5' }`.
  - `RULES['context.count'] = oneOf('auto', 'offline')`.
  - `RULES['context.count_model']`: a value matching `^claude-[a-z0-9-]{1,60}$` passes, and anything else fails with `must match ^claude-[a-z0-9-]{1,60}$`.
  - `SECTIONS.context`: `Always-loaded context budget. harness context measures it; init, update, add and sync ask before going over.`
  - `WHAT['context.budget_tokens']` keeps its text. New entries:
    - `context.count`: ``auto: use Anthropic's token-counting API in `harness context` when ANTHROPIC_API_KEY is set; offline: never.``
    - `context.count_model`: ``The model `harness context` asks the token-counting API to count for.``

- [ ] **Step 1: Write the failing tests.**
  - the defaults are as above;
  - `count: 'exact'` gives `"context.count" must be one of auto, offline`;
  - `count_model: 'gpt-4'` and `'claude-'` each fail;
  - `claude-sonnet-5-5` passes;
  - a config with only `budget_tokens` loads with the two defaults and no warning;
  - the golden `config.example.yaml` and reference tests fail until the files are regenerated.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/config.test.ts test/core/config-io.test.ts`.
- [ ] **Step 3: Implement.** Then regenerate both files the way `docs/plans/2026-11-05-pr-size.md` Task 2 did: `serializeConfig(defaults())` for the example, and `node scripts/gen-config-docs.mjs --write`.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** The reference config table is regenerated. PR body: "README: checked, no change; reference.md: updated (config keys)".
- [ ] **Step 6: Commit.** `feat(config): context.count and context.count_model`.

### Task 3: Text rules and `@` imports

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/budget/text.ts`, `src/budget/imports.ts`
- Test: `test/budget/text.test.ts`, `test/budget/imports.test.ts`

**Interfaces:**
- Produces in `text.ts`:
  - `export const MAX_FILE_BYTES = 4 * 1024 * 1024`;
  - `export const CUT_CHARS = 40_000`;
  - `export const lf = (s: string): string`: CRLF to LF;
  - `export function stripComments(s: string): string`: removes block-level `<!-- … -->` comments that sit outside fenced code blocks (``` or ~~~), including a comment that spans lines. Fences are tracked line by line.
  - `export interface Front { data: Record<string, unknown> | null; body: string; bad: boolean }`;
  - `export function splitFrontmatter(s: string): Front`: parses with `yaml`. On a parse error it gives `{ data: null, body: s, bad: true }`.
  - `export function pathsOf(data: Record<string, unknown> | null): string[] | null`: a list, or a comma-separated string split and trimmed; `null` when there is no `paths` key.
- Produces in `imports.ts`:
  - `export interface RepoIO { read(abs: string): string | null; size(abs: string): number | null; lsFiles(root: string): string[] | null }`. `read` returns null when the file is missing or unreadable; `lsFiles` returns null when git fails.
  - `export const realIO: RepoIO`. `lsFiles` runs `git ls-files -z` through `defaultExec` with `timeoutMs: 2000`.
  - `export const inside = (root: string, abs: string): boolean`.
  - `export interface Imported { path: string; text: string; by: string }` (repo-relative POSIX `path`; `by` is the importing file).
  - `export const MAX_HOPS = 4`.
  - `export function expandImports(root: string, start: { path: string; text: string }, io: RepoIO, seen: Set<string>, skip: (rel: string) => boolean): { files: Imported[]; external: string[] }`.
- The `@` rule:
  - An import is `@<path>` at the start of a line or after whitespace, outside fenced code blocks and inline code spans.
  - It is resolved relative to the importing file's folder.
  - `~/…`, an absolute path, or a path that resolves outside `root` goes to `external` and is never read.
  - A path in `seen`, or one where `skip(rel)` is true (`.env*`, `.harnessignore` matches), is dropped.
  - Hops are counted from `start`, and hop 5 isn't followed.

- [ ] **Step 1: Write the failing tests.**
  - **Text:**
    - CRLF and LF give equal counts;
    - a comment outside a fence is removed;
    - the same comment inside a ```` ``` ```` fence is kept;
    - the harness markers count 0;
    - `paths: [a, b]` and `paths: "a, b"` both give `['a','b']`;
    - unparseable frontmatter gives `bad: true` and the whole text.
  - **Imports**, with a fake `RepoIO` that records every path it is asked for:
    - a chain of 5 files: hops 1–4 are read and the 5th is not;
    - `a → b → a` stops;
    - `c` imported by both `a` and `b` is listed once;
    - `@~/x.md`, `@/etc/passwd` and `@../../out.md` go to `external`, and the fake saw no path outside `root`;
    - `` `@a.md` `` in a code span isn't an import;
    - `@.env` is skipped.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/text.test.ts test/budget/imports.test.ts`.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the tests again, then `pnpm typecheck`.
- [ ] **Step 5: Check the docs.** Nothing is user-visible. PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(budget): text rules and @-import expansion`.

### Task 4: `measureRepo`: always-loaded sources and owners

**Lane A. Depends on:** 1, 3.

**Files:**
- Create: `src/budget/sources.ts`, `src/budget/owners.ts`
- Test: `test/budget/sources.test.ts`, `test/budget/owners.test.ts`

**Interfaces:**
- Consumes: Task 3's `RepoIO`, `realIO`, `expandImports`, `splitFrontmatter`, `stripComments`, `lf`, `MAX_FILE_BYTES`, `CUT_CHARS`; Task 1's `alwaysLoadedText`; `estimateTokens`; `harnessIgnore` (`src/install/harnessignore.ts`).
- Produces in `owners.ts`:
  - `export type Owner = 'harness' | 'repo' | \`catalog:${string}\` | \`preset:${string}\``;
  - `export function ownersFrom(m: Manifest | null, c: Catalog | null): Map<string, Owner>`. A file whose `item` is an own catalog item maps to `harness`. Any other catalog item gives `catalog:<id>`. An item starting `preset:` gives `preset:<id>`. A file with no `item` gives `harness`.
  - `export const harnessShare = (o: Owner): boolean`: true for everything except `repo`.
- Produces in `sources.ts`:
  - `export interface SourceEntry extends ContextEntry { path: string; label: string; owner: Owner; load: 'always' | 'on-demand'; chars: number; note?: string; paths?: string[] }`. `tokens` is never null here.
  - `export interface RepoMeasure { always: SourceEntry[]; onDemand: SourceEntry[]; unmeasured: string[]; notes: string[] }`. `onDemand` and `unmeasured` stay empty until Task 5.
  - `export function measureRepo(root: string, o: { owners: Map<string, Owner>; skillsDisabled?: Set<string> }, io?: RepoIO): RepoMeasure`.
- The rules, which are spec §3.1 in this order:
  - **Root memory files.** `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` are read whole, after `stripComments`, and their imports are expanded. A size over `MAX_FILE_BYTES` gives `tokens: 0` and the note `over 4 MiB: Claude Code skips it`.
  - **The `@AGENTS.md` line** in `CLAUDE.md`, when the manifest records `CLAUDE.md` blocks, is its own `harness` entry, labelled `CLAUDE.md line @AGENTS.md`.
  - **`AGENTS.md` and `.claude/AGENTS.md`** are read directly only when none of the three root files exists, and never twice. The `harness:start`…`harness:end` text is a separate `harness` entry (`AGENTS.md harness block`). The `harness:preset:start`…`end` text is a separate `preset:<id>` entry. The rest is `repo`, or the importing file's owner.
  - **`.claude/rules/**/*.md`** with `pathsOf(...) === null` are always loaded, counting the body without the frontmatter. A rule with `bad` frontmatter is counted whole, with the note `frontmatter does not parse; counted whole`.
  - **Skills and commands.** `.claude/skills/*/SKILL.md` and `.claude/commands/*.md` go through `alwaysLoadedText('skill', …)`.
    - `skillOverrides` is read from `.claude/settings.json` and `.claude/settings.local.json`, with local winning.
    - `off` and `user-invocable-only` drop the skill; `name-only` counts `name: <name>`.
  - **Agents.** `.claude/agents/*.md` go through `alwaysLoadedText('agent', …)`.
  - **Owners** come from `o.owners.get(rel) ?? 'repo'`.
  - **Labels** follow §7.1: `CLAUDE.md`, `AGENTS.md (imported by CLAUDE.md)`, `.claude/rules/style.md`, `skill review-rubric`, `agent staff-reviewer`.
  - A file over `CUT_CHARS` gets the note `over 40,000 characters: Claude Code cuts it there`.
  - Every read goes through `io`, after `inside(root, abs)` and a `harnessIgnore(root)` check.

- [ ] **Step 1: Write the failing tests** (§13 "Loading rules" and "Skills"), in `makeRepo(files, { git: false })` fixtures:
  - **Memory files:**
    - `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` are each counted;
    - a `size` fake returning `4 MiB + 1` gives 0 with the note.
  - **AGENTS.md:**
    - counted directly when no `CLAUDE.md` exists;
    - counted through `@AGENTS.md` when one does;
    - counted once when both apply;
    - `CLAUDE.local.md` alone stops the direct read.
  - **Blocks:**
    - the harness block is a `harness` entry and its markers count 0;
    - the preset block is `preset:khubaib-frontend`.
  - **Rules:**
    - no `paths` and in a subfolder: always loaded;
    - with a list, or with a comma string: not in `always`;
    - bad frontmatter: counted whole, with the note.
  - **Skills:**
    - each of the four `skillOverrides` values, set in project settings and then in local settings;
    - a disabled skill counts 0;
    - a command file is counted.
  - **Owners:** taken from a manifest fixture with `review-rubric` (own item) as `harness`, a `shadcn` file as `catalog:shadcn` and a `preset:khubaib-frontend` file.
  - **Review focus 1:** the recording `RepoIO` saw no path outside `root`. Running with `HOME` pointed at a fixture holding a `CLAUDE.md` changes nothing.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/sources.test.ts test/budget/owners.test.ts`.
- [ ] **Step 3: Implement.** Keep each rule in its own function, so no function passes 50 lines.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the tests again, then `pnpm typecheck`.
- [ ] **Step 5: Check the docs.** Nothing is user-visible yet. PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(budget): measure the repo's always-loaded sources`.

### Task 5: On-demand sources and the not-measured list

**Lane A. Depends on:** 4.

**Files:**
- Create: `src/budget/on-demand.ts`
- Modify: `src/budget/sources.ts` (`measureRepo` calls it)
- Test: `test/budget/on-demand.test.ts`

**Interfaces:**
- Produces:
  - `export function onDemand(root: string, io: RepoIO, owners: Map<string, Owner>, skip: (rel: string) => boolean): { entries: SourceEntry[]; notes: string[] }`. It covers:
    - rules with `paths` (label `<rel> (paths: <globs joined ', '>)`, plus `paths`). A rule named `harness-decision-*` is grouped under the label `team decisions: <n> rules`;
    - nested `CLAUDE.md`/`AGENTS.md` below the root, from `io.lsFiles` (group label `nested CLAUDE.md: <n>`);
    - skill and agent bodies (group label `skill and agent bodies: <n>`).
  - When `lsFiles` returns null, the note is `not a git repository or git not found: nested CLAUDE.md files not listed`.
  - `export function unmeasuredSources(root: string, io: RepoIO): string[]`:
    - `plugin: <id>` for each `enabledPlugins` key in `.claude/settings.json` set to true whose marketplace isn't `harness-pins`;
    - `mcp: <name>` for each `.mcp.json` `mcpServers` key.
  - `measureRepo` fills `onDemand`, `unmeasured` and `notes`.

- [ ] **Step 1: Write the failing tests.**
  - a rule with `paths: src/api/**` is on demand, with its globs;
  - 3 `harness-decision-*` rules are one group;
  - a nested `pkg/CLAUDE.md` is found through a fake `lsFiles`;
  - `lsFiles` returning null gives the note and no throw (Review focus 5);
  - body tokens equal the whole file minus the frontmatter;
  - `enabledPlugins: { "some-plugin@market": true, "x@harness-pins": true, "off@m": false }` gives exactly `['plugin: some-plugin@market']`;
  - `.mcp.json` with `github` gives `mcp: github`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/on-demand.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm vitest run --project unit test/budget`, then `pnpm typecheck`.
- [ ] **Step 5: Check the docs.** PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(budget): on-demand sources and the not-measured list`.

### Task 6: The combined offline set

**Lane A. Depends on:** 5.

**Files:**
- Create: `src/budget/summary.ts`
- Test: `test/budget/summary.test.ts`

**Interfaces:**
- Consumes: `measureRepo`, `ownersFrom`, `measureSelectionSync`, `readManifest`, `loadCatalog`, `selectedIds`.
- Produces:
  - `export interface ContextSet { always: SourceEntry[]; onDemand: SourceEntry[]; unmeasured: string[]; notes: string[]; total: number; harness: number; catalog: number; repo: number; budget: number; method: 'estimate' | 'exact'; model: string | null }`.
  - `export function contextSet(root: string, config: HarnessConfig, dirs: { templates: string; plugin: string }, io?: RepoIO): ContextSet`. It returns `measureRepo(root, …).always`, plus `measureSelectionSync(selectedIds(config), …)`'s entries for `harness-plugin` (owner `harness`, label `skills harness:<names>` plus agents) and for catalog picks of kind `plugin`, `external-skill` and `mcp` (owner `catalog:<id>`). A null-token pick goes to `unmeasured` as `plugin: <id>`.
  - `harness` sums the `harness` and `preset:*` owners. `catalog` sums the `catalog:*` owners. `total = harness + catalog + repo`.
  - When the catalog fails to load, only the plugin row and the repo files count, with the note `the catalog has errors; catalog picks not measured`.
  - `export const repoOnly = (s: { always: SourceEntry[] }): SourceEntry[]`: the `owner === 'repo'` entries, for the budget asks.
  - `export const STATE_CARD_MAX_TOKENS = 300`.

- [ ] **Step 1: Write the failing tests.**
  - **No double count:** after a fixture install with `agents-md` and `review-rubric`, the harness block and the skill each appear once, and `total` equals the sum of the rows.
  - **Plugin row:** `harness-plugin` is in `always` with owner `harness`.
  - **Picks:** an M3 plugin pick with no number is in `unmeasured`.
  - **Bad catalog:** gives the note and doesn't throw.
  - **No manifest:** every file is `repo` (Review focus 5).
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/summary.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the tests again, then `pnpm typecheck`.
- [ ] **Step 5: Check the docs.** PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(budget): one offline always-loaded set for every view`.

### Task 7: Token-counting API seam

**Lane A. Depends on:** 1, 2.

**Files:**
- Create: `src/budget/count-api.ts`
- Modify: `src/budget/measure.ts` (`measureSelection` honours `opts.count`; `itemContext` and `pluginEntry` keep the texts they measure)
- Test: `test/budget/count-api.test.ts`, `test/budget/measure.test.ts`

**Interfaces:**
- Produces:
  - `export const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens'`.
  - `export const PER_CALL_MS = 5000`, `export const TOTAL_MS = 20000`.
  - `export function apiCountTokens(key: string, model: string, deps?: { fetch?: typeof fetch; now?: () => number; onFail?: (reason: string) => void }): CountTokens`.
  - It makes one `POST` per text, one at a time, then one baseline call with content `"."` first.
    - Headers: `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
    - Body: `{ model, messages: [{ role: 'user', content: text }] }`.
    - Each count is `max(0, input_tokens - baseline)`.
    - Each call uses `AbortSignal.timeout(min(PER_CALL_MS, deadline - now()))`.
  - On any non-2xx response, abort, throw or missing `input_tokens`, it calls `onFail(<status> | 'timeout' | 'network error')` and resolves `null`. It never puts `key`, a header or a response body in the reason.
  - `measureSelection(..., { count })`: with `count`, it collects `{ id, text }` for every measured entry and calls `count` once. On a record, it replaces the tokens and sets `method: 'exact'`; on `null`, the estimate stands. `measureSelectionSync` is unchanged.
  - `export function countKey(env: NodeJS.ProcessEnv, config: HarnessConfig): string | null`: `config.context.count === 'offline' ? null : env.ANTHROPIC_API_KEY || null`. This is the one place the variable is read, and only `src/cli/context.ts` calls it. A test greps `src/` for `ANTHROPIC_API_KEY` and finds only `count-api.ts`.

- [ ] **Step 1: Write the failing tests**, with an injected `fetch` that records calls:
  - **The request:** headers and body exactly as above; one call per text plus one baseline; the calls are sequential.
  - **The count:** baseline 7, text 19 gives 12; a text below the baseline gives 0.
  - **Failures:** 401, 429 and a timeout (with `now` past the deadline) each resolve `null`, and `onFail` gets `401`, `429` and `timeout`. A `fetch` that throws `new Error('x-api-key: sk-ant-TEST-SENTINEL-0000')` gives `network error`, and the sentinel is in no reason (Review focus 2).
  - **No key:** `countKey` with `count: 'offline'`, and with no variable set, is null.
  - **`measureSelection`:** with a count record, `method` is `'exact'`; with null, it is `'estimate'`.
  - **The read stays in one place:** the grep test.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/count-api.test.ts test/budget/measure.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** Not routed yet. PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(budget): token-counting API seam with offline fallback`.

### Task 8: Budget asks: widened line, repo entries, unattended refusal

**Lane A. Depends on:** 6, 7.

**Files:**
- Modify:
  - `src/budget/measure.ts` (`budgetLines`);
  - `src/cli/install-selection.ts` (`budgetGate`);
  - `src/core/unattended.ts`;
  - the `budgetGate` call sites in `src/cli/init.ts`, `update.ts`, `items.ts` (add and explain) and `sync.ts`.
- Test: `test/budget/measure.test.ts`, `test/cli/init.test.ts`, `test/cli/items.test.ts`, `test/cli/preset-init.test.ts`, `test/cli/status.test.ts` (the old exact line)

**Interfaces:**
- Produces:
  - `ContextEntry` gains `owner?: Owner`.
  - `budgetLines(v)` line 1 (X1) is ``Always-loaded context: ~<after> tokens (estimate), budget <budget>; harness and its picks ~<h>.`` Here `h` sums the non-exempt entries whose `owner` isn't `repo`. The other lines are unchanged.
  - `export const unattendedEnv = (env: NodeJS.ProcessEnv): boolean`, the three env checks moved out of `isUnattended`, which now calls it.
  - `budgetGate({ …, root, env })`:
    - it appends `repoOnly(measureRepo(root, …))` to both `extra` and `extraBefore`;
    - it never marks those entries `exempt`;
    - when `v.ask && unattendedEnv(env)`, it prints `Not added: it would take always-loaded context past the budget of <n> tokens, and no person is here to approve it. Run it in a session, or raise context.budget_tokens.` and returns 2, even with `--over-budget` (Q6).
  - `explain` passes the repo entries too, so its line is the repo total.

- [ ] **Step 1: Write the failing tests.**
  - M3's `budgetVerdict` tests pass unchanged.
  - `budgetLines` gives the widened line, and `budgetLines say estimate and name the unmeasured ids` still holds.
  - A repo `CLAUDE.md` of 1,900 tokens (7,600 characters) plus a 120-token pick asks.
  - `--yes` with an ask and no `--over-budget` exits 2 with M3's copy.
  - `CI=true` with `--over-budget --yes` exits 2 with the Q6 copy.
  - A change that doesn't raise the total and adds no unmeasured id doesn't ask, even over the budget.
  - No `fetch` is called. The tests stub `globalThis.fetch` to throw.
  - Update the four tests that match the old exact line.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget test/cli/init.test.ts test/cli/items.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.**
  - `docs/reference.md` "Context budget", **What counts**: "The repo's own CLAUDE.md, AGENTS.md, rules, skills and agents count too, because every teammate loads them."
  - **The limit**: "`init`, `update`, `add` and `sync` ask before going past it. An unattended run is refused, even with `--over-budget`."
  - README line 87: check it, and match the wording.
  - PR body: "README: updated (context line) or checked; reference.md: updated (context budget)".
- [ ] **Step 6: Commit.** `feat(budget): budget asks count the repo's own context`.

### Task 9: `doctor` and `status` lines

**Lane D. Depends on:** 6.

**Files:**
- Create: `src/cli/doctor-context.ts`
- Modify: `src/cli/doctor.ts` (one import, one call), `src/cli/status.ts` (the `Context:` line after the gates; `itemLines` drops its budget line)
- Test: `test/cli/doctor.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Produces:
  - `export function contextChecks(root: string, config: HarnessConfig, p: { ok: (s: string) => void; fix: (w: string, n: string) => void; note: (w: string, n?: string) => void }): void`. It calls `contextSet` (offline) and prints exactly one of these lines:
    - `ok always-loaded context ~<total> of <budget> tokens (best estimate); harness ~<harness>`;
    - `note always-loaded context ~<total> tokens is over the budget of <budget>: run /harness:context-optimize`;
    - `fix harness's own always-loaded text (~<harness> tokens) is over the budget of <budget>: report this as a harness bug, or raise context.budget_tokens`.
  - `export const contextLine = (s: ContextSet): string` gives `Context: ~<total> of <budget> tokens always loaded (best estimate); harness ~<harness>. Run harness context for details.`

- [ ] **Step 1: Write the failing tests.**
  - the three doctor cases: within budget, over, and harness alone over with `budget_tokens: 100`;
  - `fix` makes doctor exit 1 and `note` doesn't;
  - `status` prints `Context:` right after the gate lines, for a legacy install too;
  - neither calls `fetch` (stubbed to throw);
  - a repo with no `.git` doesn't throw (Review focus 5).
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/cli/doctor.test.ts test/cli/status.test.ts`.
- [ ] **Step 3: Implement.** `doctor.ts` must stay at 300 lines or fewer.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** `docs/reference.md` "Context budget": "`harness doctor` and `harness status` show the always-loaded total, counted offline." PR body: "README: checked, no change; reference.md: updated (context budget)".
- [ ] **Step 6: Commit.** `feat(cli): always-loaded context in doctor and status`.

### Task 10: State-card check

**Lane B. Depends on:** nothing.

**Files:**
- Create: `src/checks/state-card.ts`, `src/core/gates.ts`
- Modify:
  - `src/cli/status.ts` (imports `GATES` from `src/core/gates.ts`);
  - `src/hooks/check.ts` (`Ctx.configErrors?: string[]`);
  - `src/hooks/dispatch.ts` (sets `configErrors` on `ctx`; `stateCard` is appended to `registry`).
- Test: `test/checks/state-card.test.ts`, `test/hooks/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `export const GATES: [label: string, key: keyof HarnessConfig['checks']][]`, the 7 entries `status.ts:25` has now.
  - `export const CARD_LINE_MAX = 300`, `export const CARD_MAX = 1200`, `export const NOTICE_MAX = 160`.
  - `export function stateCard(ctx: Ctx): string`. It returns exactly 5 LF-joined lines with no trailing newline:
    1. `Harness state (re-added after compaction; hooks still enforce every gate):`
    2. `Gates: guard on, protect on, dep-verify on, multi-file off, tdd on, stop on, pr-size on`, from `GATES`. When `ctx.configErrors?.length`, it is `Gates: config invalid, so edits and Stop are blocked until a person fixes .harness/config.yaml` instead.
    3. One of:
       - `TDD: off`;
       - `TDD: paused for this session` (`isPaused(root, session)`);
       - `TDD: on; test files written this session: <n>`, then ` (<up to 3 of state.redTests>` with `, +<k> more` when there are more, then `)`.
    4. `Locked tests (failed this session, not yet passing; fix the code, not the test): ` plus `none`, or up to 5 paths and then `, +<k> more`.
    5. `Pending: ` plus `none`, or these items joined with `; `:
       - from `harnessNoticed`: `harness files changed (<files joined ', '>): tell the person; the next Stop blocks once until they review it`;
       - from each `pendingNotice` line: its first sentence (up to the first `. `), cut to `NOTICE_MAX`.

    Each line is cut to `CARD_LINE_MAX`, and the whole card to `CARD_MAX`.
  - `export const stateCardCheck: Check = { name: 'state-card', events: ['SessionStart'], pure: true, run }`. It returns `{ kind: 'context', text: stateCard(ctx), check: 'state-card' }` only when `ctx.input.source === 'compact'`, and `{ kind: 'allow' }` otherwise.

- [ ] **Step 1: Write the failing tests.**
  - golden output for each case of each line:
    - TDD off, paused and on;
    - 0, 3 and 7 test files;
    - locked none, 1 and 7;
    - pending none, harness files changed, a config-change notice, and both;
  - the 300- and 1,200-character caps;
  - `source: 'startup'`, `'resume'`, `'clear'` and `'fork'` give `''` through `dispatch`;
  - a missing state file gives 5 lines with `0` and `none` (drift 15);
  - an invalid config gives line 2's invalid text;
  - **Review focus 4:** through `dispatch(raw, registry, env)` with a changed harness file and a pending notice, the output is `hookSpecificOutput.additionalContext` holding the card. `stopAttempts` and `harnessFiles` are unchanged in the state file afterwards.
  - The `systemMessage` key is absent when no change-detection notice exists. A test with one present records that the notice's own `systemMessage` (from `withNotice`) is the only one.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/checks/state-card.test.ts test/hooks/dispatch.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`, then `pnpm test:perf`.
- [ ] **Step 5: Check the docs.** The check isn't wired yet. PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(hooks): state card after compaction`.

### Task 11: SessionStart group and 7 wired events

**Lane B. Depends on:** 10, and 9 (`doctor.ts`).

**Files:**
- Modify: `templates/settings.fragment.json`, `src/cli/doctor.ts` (`EVENTS` gains `'SessionStart'`; the count copy becomes `` `all ${EVENTS.length} hook events` ``)
- Test: `test/templates/settings.test.ts`, `test/cli/doctor.test.ts`, `test/e2e/install.e2e.test.ts`, `test/e2e/upgrade.e2e.test.ts`

**Interfaces:**
- Produces: the fragment's `"SessionStart": [{ "matcher": "compact", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs"], "timeout": 10 }] }]`, placed after `SessionEnd`, with no `onFailure`.

- [ ] **Step 1: Write the failing tests.**
  - **Fragment:** the events list ends with `SessionStart`, the matcher is `compact`, and there's no `onFailure`.
  - **Doctor:**
    - prints `ok settings run the dispatcher for all 7 hook events`;
    - a settings file without the group gives the existing `missing the harness group for \`compact\`` fix (drift 12).
  - **Update and uninstall** (e2e):
    - `update` on the old-install fixture adds the group in place and records its block;
    - `uninstall` removes it byte for byte.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/templates/settings.test.ts test/cli/doctor.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`, then `pnpm test:perf`.
- [ ] **Step 5: Check the docs.**
  - `docs/reference.md` "What `init` changes": add the SessionStart compact hook, which re-adds a 5-line state card after compaction.
  - Known limits: "The state card is added after compaction, but the summary of earlier hook messages is Claude Code's. The card doesn't restore them."
  - PR body: "README: checked, no change; reference.md: updated (hooks, known limits)".
- [ ] **Step 6: Commit.** `feat(install): wire SessionStart compact to the dispatcher`.

### Task 12: `harness context` report and `--json`

**Lane A. Depends on:** 6, 7.

**Files:**
- Create: `src/cli/context.ts` (args, counting, exit code), `src/cli/context-copy.ts` (the §7.1 text)
- Modify: `src/cli/index.ts` (async route `context` and `USAGE` lines)
- Test: `test/cli/context.test.ts`, `test/cli/context-copy.test.ts`

**Interfaces:**
- Consumes: `contextSet`, `apiCountTokens`, `countKey`, `STATE_CARD_MAX_TOKENS`.
- Produces:
  - `export async function context(args: string[], cli: CliEnv & { fetch?: typeof fetch }): Promise<number>`. It takes `[--json] [--offline]`.
    - With a key, it re-counts every `always` and `onDemand` text through `apiCountTokens` ; catalog-recorded numbers stay in the total, each marked `(catalog estimate)`, and the header adds `except <n> catalog estimates` (owner decision 2).
    - Exit codes: 0 within the budget, 1 over, 2 on a usage error. It writes nothing.
  - `export function reportText(s: ContextSet, recs: Rec[], fallback: string | null): string[]` gives §7.1 exactly:
    - Always-loaded rows are `'  ' + owner.padEnd(9) + label`, then tokens right-aligned to `REPORT_WIDTH = 62`.
    - `owner` prints `harness`, `catalog`, `preset` or `repo`.
    - Then the `Total` row, and `Not measured: …` for each unmeasured id.
    - The on-demand header ends with its total. Its groups follow.
    - `after compaction: state card, at most ~300` sits under on demand.
    - The not-measured sentence names the MCP servers.
    - The `Recommendations` section prints only when `recs` isn't empty (Task 13 fills it; `[]` here).
  - `export function reportJson(s, recs, fallback): object` follows §5's shape. `model` is `config.context.count_model` when the API was used, else null. `not_measured` is `["system prompt and tools", "output style", "personal context"]`.
  - `USAGE` gains `harness context [--json] [--offline]` and `harness context apply <n>[,<n>…] [--dry-run] [--yes]`.

- [ ] **Step 1: Write the failing tests.**
  - **Golden text:** §7.1's text for a fixture repo with the example's shape, under and over the budget, with both labels and the not-measured line.
  - **Copy:**
    - with the API (a fake `fetch`), the label is `Counted by Anthropic's token-counting API (claude-opus-5-5).` and there's no `~`;
    - a 429 gives the fallback line and `~` estimates, never mixed.
  - **`--json`:** the shape keys.
  - **Exit codes:** 0, 1 and 2 (`--bogus`).
  - **No network:**
    - `--offline` with a key set: `fetch` is never called;
    - `count: offline` the same.
  - **Review focus 2:** the sentinel key appears in no `out` line, in `events.jsonl`, or in the error text.
  - **Nothing written:** a `git status --porcelain` fixture is unchanged afterwards.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/cli/context.test.ts test/cli/context-copy.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.**
  - `docs/reference.md` "Commands in full": a `context [--json] [--offline]` row, saying it measures always-loaded and on-demand context against the budget, exits 1 over it, and uses Anthropic's token-counting API only when `ANTHROPIC_API_KEY` is set and `context.count` is `auto`.
  - README command table: add a `context` row.
  - PR body: "README: updated (command table); reference.md: updated (commands)".
- [ ] **Step 6: Commit.** `feat(cli): harness context report`.

### Task 13: Recommendations and `harness context apply`

**Lane A. Depends on:** 12.

**Files:**
- Create: `src/budget/recommend.ts`, `src/cli/context-apply.ts`
- Modify:
  - `src/cli/context.ts` (prints the recommendations; routes `apply`);
  - `src/install/plan-preset.ts` (`isPresetSet` skips `skillOverrides`);
  - `src/install/merge.ts` (`mergePresetSettings`'s `stale` skips `skillOverrides`);
  - `src/checks/guard.ts` (`PERSON_ONLY.context`).
- Test: `test/budget/recommend.test.ts`, `test/cli/context-apply.test.ts`, `test/checks/guard.test.ts`, `test/install/plan-preset.test.ts`

**Interfaces:**
- Produces:
  - `export type RecKind = 'name-only' | 'remove' | 'long-file' | 'scope-rule' | 'move-to-skill' | 'long-description' | 'user-only'`.
  - `export interface Rec { n: number; kind: RecKind; owner: Owner; target: string; saves: number | null; apply: boolean }`.
  - `export function recommend(s: ContextSet, preloaded: Set<string>): Rec[]`, with the rules of §5's table and the constants in "Plan decisions":
    - `name-only` and `remove` come first (largest saving first), then the user-file kinds in table order; `n` counts from 1;
    - `name-only` targets only `harness`, `preset:*` or `catalog:*` project skills, only while `total > NAME_ONLY_SHARE * budget`, and never a name in `preloaded`;
    - `remove` targets catalog plugin picks.
  - Copy, from §7.1:
    - harness-owned: `  <n>. harness  Show skill <name> by name only (saves ~<k>). Apply: harness context apply <n>`;
    - yours: `  <n>. yours    <file> is <lines> lines; move the parts that only matter for some folders into path-scoped rules. /harness:context-optimize proposes the diff.`;
    - each user-file kind has one sentence ending with `/harness:context-optimize proposes the diff.`;
    - plugin picks add `To turn it off for yourself only, disable it in .claude/settings.local.json.` (C8).
  - `export async function contextApply(args: string[], cli: ItemsEnv): Promise<number>`:
    - for `name-only`: `mergePresetSettings(before, [{ set: ['skillOverrides', name], value: 'name-only' }], [])`, then `mergeManifestFiles`, `applyChanges`, `stampHarnessFiles`, as `items.ts:186-195` does;
    - a key the person already set is left alone, and the merge's note is printed;
    - for `remove`: `items('remove', [id, ...(dryRun ? ['--dry-run'] : []), ...(yes ? ['--yes'] : [])], cli)`;
    - any other number refuses with `Recommendation <n> changes your own file; the context-optimize skill shows you the diff first.` and exit 2;
    - `--dry-run` prints `unifiedDiff`;
    - without `--yes` on a TTY it asks `Apply these changes? [y/N]`; with no TTY it prints `NO_TTY`.
  - `PERSON_ONLY.context = { kind: 'ask', allowed: (a) => a[0] !== 'apply' || PREVIEW(a.slice(1)), why: () => 'the agent is changing which skills load, in .claude/settings.json' }`.

- [ ] **Step 1: Write the failing tests.**
  - **Recommendations:**
    - each kind's trigger, and its no-trigger at the threshold edge;
    - `review-rubric` is never `name-only` while `staff-reviewer` preloads it;
    - the numbers are stable across two runs.
  - **`apply name-only`:**
    - writes the block, records `{"set":["skillOverrides","pr-ship"],"value":"name-only"}` and the parent `{}` block in the manifest;
    - leaves a person-set key alone, with the note.
  - **`apply remove`:** calls `items` (spy).
  - **Refusals:** `apply` on a `long-file` number refuses with exit 2.
  - **Dry run and prompt:** `--dry-run` writes nothing (the git status is unchanged), and the TTY prompt works.
  - **Review focus 3:**
    - after `apply`, an `update` with and without a preset keeps the block;
    - `init → context apply → uninstall` leaves the repo byte-identical.
  - **Guard:**
    - `harness context`, `harness context --json` and `harness context apply 1 --dry-run` are allowed;
    - `harness context apply 1 --yes` asks;
    - with `CI=true`, it is denied through `dispatch`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/budget/recommend.test.ts test/cli/context-apply.test.ts test/checks/guard.test.ts test/install/plan-preset.test.ts`.
- [ ] **Step 3: Implement.** Update the `plan-preset.ts:35` comment to name both writers.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.**
  - `docs/reference.md` "Commands in full": an `apply` row, saying it applies harness-owned recommendations only, is undone by `uninstall`, and asks when the agent runs it.
  - "Guard details": add `context apply`.
  - PR body: "README: checked or updated; reference.md: updated (commands, guard)".
- [ ] **Step 6: Commit.** `feat(cli): context recommendations and harness context apply`.

### Task 14: `/harness:context-optimize` skill

**Lane A. Depends on:** 13.

**Files:**
- Create: `skills/context-optimize/SKILL.md`, `test/skills/context-optimize.test.ts`
- Modify: `README.md`, `docs/reference.md`

**Interfaces:**
- Produces: the frontmatter exactly as in §6, with `disable-model-invocation: true`, and the 7 steps of §6 in at most 40 lines. The commands are `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" context --json`, `context`, `context apply <n…> --dry-run` and `context apply <n…> --yes`.

- [ ] **Step 1: Write the failing test.**
  - The frontmatter is exactly §6's.
  - The body names `/context all` and `/doctor`, and has the AskUserQuestion options `Apply all`, `Choose` and `None`.
  - It says never to edit `.harness/`, `.claude/settings*.json` or the harness block.
  - It contains the line "Never ask for an API key, and never print or echo `ANTHROPIC_API_KEY`."
  - It is under 40 lines.
  - `footprint` is unchanged (the skill costs 0).
- [ ] **Step 2: Run it and confirm it fails.** `pnpm vitest run --project unit test/skills/context-optimize.test.ts test/package/package.test.ts`.
- [ ] **Step 3: Write the skill.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** README: add `/harness:context-optimize` to the commands. `docs/reference.md` "Context budget": add "Run `/harness:context-optimize` to trim it." PR body: "README: updated (commands); reference.md: updated (context budget)".
- [ ] **Step 6: Commit.** `feat(skills): context-optimize`.

### Task 15: Known limits and the budget docs

**Lane A. Depends on:** 14, 11.

**Files:**
- Modify: `docs/reference.md` ("Context budget", "Known limits"), `README.md`
- Test: `test/package/readme.test.ts`

- [ ] **Step 1: Write the failing test.** `test('the reference carries the context-budget known limits, verbatim')` checks every `- ` line of spec §14 in `docs/reference.md`, the way the PE test at `readme.test.ts:44` does.
- [ ] **Step 2: Run it and confirm it fails.** `pnpm vitest run --project unit test/package/readme.test.ts`.
- [ ] **Step 3: Write the docs.**
  - Paste §14 into "Known limits", replacing the old line 476 ("The context count is an estimate…").
  - Rewrite "Context budget" to match the build: what counts, owners, the API (env var only, never stored, sends the measured text to Anthropic under the key's account), on demand, `doctor`/`status`/`context`, and the asks.
  - The README stays at about 120 lines.
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** PR body: "README: updated (context); reference.md: updated (context budget, known limits)".
- [ ] **Step 6: Commit.** `docs: context budget and its known limits`.

### Task 16: Usage report always-loaded rows

**Lane E. Depends on:** 6.

**Files:**
- Modify: `src/report/metrics/usage.ts` (`alwaysLoaded` returns `contextSet(...).always` mapped to `{ id: label, tokens }`)
- Test: `test/report/usage.test.ts`, `test/report/export.test.ts`

**Interfaces:**
- Produces: `alwaysLoaded(root, dirs)` keeps its signature and return type. The rows are now one per source, with no `AGENTS.md` double count (drift 18).

- [ ] **Step 1: Write the failing tests.**
  - The harness block appears once.
  - The sum equals `contextSet().total`.
  - The export folds a repo path label such as `.claude/rules/private.md` to `other`, and no path string appears in the export JSON.
  - The two existing tests are updated: the `AGENTS.md` directory case and the ids list.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/report/usage.test.ts test/report/export.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** `docs/reference.md` "Usage and adherence report": say the always-loaded table is `harness context`'s offline count. PR body: "README: checked, no change; reference.md: updated (report)".
- [ ] **Step 6: Commit.** `feat(report): always-loaded rows from the context set`.

### Task 17: `cost.context_tokens` in the catalog (C4)

**Lane F. Depends on:** 1.

**Files:**
- Modify: `src/catalog/schema.ts` (`cost` accepts `context_tokens`), `src/budget/measure.ts` (`itemContext`)
- Test: `test/catalog/schema.test.ts`, `test/budget/measure.test.ts`, `test/cli/items.test.ts` (`why` and `explain` lines)

**Interfaces:**
- Produces:
  - `cost: { context: Level; setup: Level; context_tokens?: number | null }`. The value is an integer from 0 to 200000 or `null`; anything else fails with `cost.context_tokens: must be an integer from 0 to 200000 or null`.
  - `itemContext` returns `{ id, tokens: item.cost.context_tokens ?? null }` for `plugin` and `external-skill`. MCP stays `null`.

- [ ] **Step 1: Write the failing tests.**
  - the schema accepts 0, 120 and `null`, and refuses `-1`, `1.5` and `'x'`;
  - a pick with 61 measures 61, and with no number it is unmeasured and asks (M3 plan C2 (a));
  - `harness why <id>` prints `Context: ~61 tokens (estimate).`
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/catalog/schema.test.ts test/budget/measure.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** `docs/reference.md` "Context budget", **Not measured**: "Plugins and external skills count the number the catalog records, measured at the pinned commit; with none recorded, they're listed as not measured." PR body: "README: checked, no change; reference.md: updated (context budget)".
- [ ] **Step 6: Commit.** `feat(catalog): cost.context_tokens`.

### Task 18: Measure `context_tokens` at the pinned sha

**Lane F. Depends on:** 17.

**Files:**
- Create: `src/catalog/context-check.ts`
- Modify: `src/cli/catalog.ts` (`--context`, and `--write-context` with `--context`)
- Test: `test/catalog/context-check.test.ts`, `test/cli/catalog.test.ts`

**Interfaces:**
- Consumes: `fetchTarball(r: Resolved, exec: ExecBytes)` and `cleanTmp` (`src/vet/fetch.ts`), and `scan(f, path).context.tokens` (`src/vet/scan.ts`).
- Produces:
  - `export function measureItemContext(item: CatalogItem, exec: ExecBytes): { tokens: number } | { error: string }`. `Resolved` is built from `source` as `{ repo, ref: sha, sha, path: source.path ?? '' }`. The temp folder is always cleaned.
  - `catalog check --resolve --context [--only <id,...>]`:
    - prints `<id>: cost.context_tokens is <x>, measured <y> at <sha7>` for a mismatch, which is a problem (exit 1);
    - lists items with no number under `Not measured:`, which isn't a problem.
  - `--write-context` rewrites each item file's `cost:` line with the measured value and changes nothing else in the file.
  - The CI workflow is unchanged. It runs `--resolve` only, so the network cost doesn't grow until the owner adds `--context` (owner decision 4).

- [ ] **Step 1: Write the failing tests**, with a fake `ExecBytes` serving a tarball fixture (as `test/vet` does):
  - a recorded value equal to the measurement passes;
  - an unequal value is a problem;
  - a missing value is listed;
  - `--write-context` changes only the `cost:` line (a byte diff of the fixture item);
  - a fetch error is a "could not verify" problem, not a mismatch;
  - the temp folder is gone afterwards.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/catalog/context-check.test.ts test/cli/catalog.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run `pnpm test`.
- [ ] **Step 5: Check the docs.** `docs/reference.md` "Commands in full": the `catalog check` row gains `--context [--write-context]`. PR body: "README: checked, no change; reference.md: updated (commands)".
- [ ] **Step 6: Commit.** `feat(catalog): measure context_tokens at the pinned commit`.

**Manual step after this task (owner, not an agent; owner decision 4).** It needs network and `gh` auth, and costs no money. It runs once Task 18 is merged, because `--write-context` ships in Task 18; Task 17 only adds the schema field.
1. From a checkout of `main`: `pnpm build && node dist/cli.mjs catalog check --resolve --context --write-context`.
2. Review the changed `catalog/items/*.yaml` `cost:` lines.
3. Commit them on a `chore/catalog-context-tokens` branch, and open a PR.
4. After it merges, add `--context` to the `catalog check --resolve` line in `.github/workflows/catalog-pins.yml`, in its own PR.

---

## Self-review (2026-11-07)

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | D1 scope, §3.1–3.3 | 4, 5, 6 |
  | D2 the command, §6 | 12, 13, 14 |
  | D3 enforcement, §8, §10 | 8, 9 |
  | D4 budget | 2 (siblings), existing key |
  | D5, §4 counting | 7, 12 |
  | D6, §9 the card | 10, 11 |
  | D7 relevance | 10 (compact only) |
  | §3.4 text rules | 3 |
  | §5 recommendations, apply, guard | 13 |
  | §7.1 copy | 12, 13 |
  | §7.2 budget copy | 8 |
  | §11 footprint | 1 |
  | §12 X1 | 8 |
  | §12 X2 | 7 |
  | §12 C4 | 17, 18 |
  | §12 report plug-in | 16 |
  | §12 PS (`pr-ship` keeps its description) | 1 (footprint) |
  | §12 TD | none (not merged; drift 19) |
  | §13 tests | spread across their tasks |
  | §13 live checks | owner batch |
  | §14 known limits | 15 |
  | §15 out of scope | nothing builds it |
  | §16 C1 | 11 |
  | §16 C2 | 4 |
  | §16 C7 | 12 |
  | §16 C8 | 13 |
  | §16 C9 | 1, 14 |
  | §16 C10 | 13 |
  | §16 C12 | 8, 9 |
  | §16 Q1 | 6, 8 |
  | §16 Q2 | 1 |
  | §16 Q3 | 2 |
  | §16 Q4 | 9 |
  | §16 Q5 | 14 |
  | §16 Q6 | 8 |

  - **Gaps:** C5 (no catalog change), C6 (writing rule) and C11 (TD's rules) need no code here.
- **Type consistency.** These names are used the same way across tasks: `RepoIO`, `SourceEntry`, `RepoMeasure`, `Owner`, `ContextSet`, `contextSet`, `repoOnly`, `Rec`, `recommend`, `apiCountTokens`, `countKey`, `unattendedEnv`, `stateCard`, `GATES`, `footprint` and `STATE_CARD_MAX_TOKENS`.
- **Review focus.** Each of the five lines has its test in its owning task: 1 in Tasks 3 and 4, 2 in Tasks 7 and 12, 3 in Task 13, 4 in Task 10, and 5 in Tasks 5, 6 and 9.
- **Proportion.** The plan is about 1.3 times the spec's length, with no function bodies. The only algorithm spelled out is the `@` import rule, which the signature doesn't decide.
