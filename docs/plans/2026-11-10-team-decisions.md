# Team decisions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. The owner confirms the method in review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** teams keep shared decisions in `docs/decisions/`, one file each. `harness remember` writes them only with the person's yes. Each active decision becomes a generated `.claude/rules/harness-decision-<id>.md` that Claude Code loads when its paths are touched. Git checks and a 90-day expiry flag stale ones in `doctor`, `status`, `remember check` and a Stop note. A Stop nudge points at `remember add` when a session states a rule.

**Size:** 15 tasks. Each is one PR, at or under 400 changed lines and 20 files (estimated at planning, measured at PR time).

**Architecture:**
- **Decision core.** It lives in `src/core/`, next to the other shared modules. Each file has one job:
  - `decision-file.ts`: the schema, the id, parse, validate and serialise;
  - `decision-rule.ts`: the rule bytes and the cap;
  - `decisions.ts`: reading the folder, and `sync`;
  - `decisions-stale.ts`: the git staleness states;
  - `secrets.ts`: `scanSecrets` and `redactSecrets`.
- **Writes** go through `applyChanges` (`src/install/apply.ts`) as one transaction. The decision file and the rule files are written together. The manifest is passed explicitly as `mergeManifestFiles(m, ruleChanges)`, so it records only the rules and never `docs/decisions/`. `stampHarnessFiles` runs afterwards, so change detection doesn't report harness's own write.
- **Uninstall** needs no new code. A rule is a manifest `create` entry with no `item`, so `removalChanges` (`src/cli/uninstall.ts`) deletes it on a hash match. `removeEmptyDirs` then removes an emptied `.claude/rules/`.
- **CLI.** `src/cli/remember.ts` handles the write subcommands. `src/cli/remember-read.ts` handles `list` and `check`.
- **Hooks.**
  - The guard gets one `PERSON_ONLY` entry. That entry hands off to `rememberAsk` in `src/checks/remember.ts`, which uses the quote check in `src/checks/quote.ts`.
  - Protect gets one isolated function in `src/checks/decisions-protect.ts`.
  - A new check, `decisionSignals`, records the nudge signals and the `remember add` runs.
  - The Stop gate's `done()` adds the nudge and the warning notes.
- **Tests never touch the network or the real home folder.** Git runs only in temporary repos made by the test. Transcripts are fixture files in a temp dir.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml` and `picomatch` (both already dependencies). No new dependency.

**Spec:** `docs/specs/2026-11-03-team-decisions-design.md` (owner-approved 2026-11-03, binding). §1 holds the owner decisions D1 to D11, and §14 the rulings C1 to C13 and O1. Section numbers (§n) refer to the spec.

## Spec drift against `main` 5b38633 (resolved here)

The spec was written on 2026-11-03, on `feature/pe-7-doctor-status`. Since then M3, the preset, PR size, usage, the context budget and the guard work have merged. Checked against `main` 5b38633 on 2026-11-10:

1. **Names that match.**
   - `PERSON_ONLY` and `isPersonOnly` (`src/checks/guard.ts:79`).
   - `readTranscript` (`src/checks/multi-file.ts:36`, private).
   - `unattendedEnv` and `isUnattended` (`src/core/unattended.ts`).
   - `mergeAgents` and `templates/agents-block.md`.
   - `applyChanges`, `removeEmptyDirs` and `Change` (`src/install/apply.ts`).
   - `mergeManifestFiles` and `rawOf` (`src/install/manifest.ts`).
   - `removalChanges` (`src/cli/uninstall.ts:61`).
   - `snapshotHarnessFiles` and `stampHarnessFiles` (`src/core/harness-files.ts`).
   - `matches` (`src/core/paths.ts`, picomatch with `dot: true`).
   - `appendEvent` (`src/core/events.ts`).
   - `insideClaude` (`src/cli/claude-only.ts`).
2. **The guard can't build the ask from a `PERSON_ONLY` entry alone.** An entry's `why` receives only `run`, not the words. And `decideCommand` gets a `GuardCtx` (`config`, `env`, `root`), with no `transcript_path`, no `unattended` and no session. The fix:
   - The `remember` entry's `why` returns a constant, `REMEMBER_WHY`.
   - `guard.run`, which has the full `Ctx`, gains one line: when `decideCommand` returned an ask whose reason holds `REMEMBER_WHY`, it returns `rememberAsk(ctx, cmd)`.
   - So the spec's `rememberAsk(ctx, words)` becomes `rememberAsk(ctx: Ctx, command: string)`. It finds the words itself, with the exported `walkCommands`.
   - Earlier denies, such as the `.env` text rule and `DENY`, still win, because `decideCore` returns them before the person-only check.
3. **PR #141 rewrites the guard and protect.** It touches `src/checks/guard.ts`, `src/checks/protect.ts`, `src/hooks/run-checks.ts`, `src/core/shell-words.ts` and new `guard-*.ts` files.
   - Tasks 9, 10 and 11 keep their edits in those files to one table entry, one call line or one isolated function.
   - They rebase onto #141 before they merge. If #141 merges first, its `PERSON_ONLY` and `PROTECTED_CONCRETE` locations are used, wherever they moved.
4. **The guard reads its arguments before a person-only judgement.** `passes` refuses any argument holding `PREVIEW_EXPANDS` (`$`, a backtick, `{}`, `*`, `?`, `[]`, a leading `~`). So `remember add --dry-run --path "src/**"` asks instead of being allowed. That is safe, and it is kept: `--dry-run` with a glob asks, and without one it is allowed.
5. **The `.env` deny wins.** `decideCore` denies a command whose tokens hit `sensitivePath` before it gets to the person-only check. So `harness remember add --rule "never commit .env files"` is denied as "touching a secrets file", and the agent can't save such a decision. This plan keeps that deny, because the guard's text rules are frozen (PE §3.5) and #141 is open. The person runs that command in their own terminal, and Task 15 lists it under the known limits.
6. **The log copies the reason.** `runChecks` logs every deny and ask with its full `reason` (`src/hooks/run-checks.ts:44`). So the `add` ask would put the title, the rule and the why, and a quote excerpt taken from the transcript, into `events.jsonl`, which breaks C2. Task 9 adds an optional `log?: string` to the deny and ask `Decision` in `src/hooks/types.ts`, and `runChecks` logs `d.log ?? d.reason`. That is one line in `run-checks.ts`, rebased onto #141.
7. **The Stop gate's docs-only return skips `done()`.** It returns `allow` at `gate.ts:126`, before `done` is defined. Task 12 moves the docs-only exit so it goes through `done(allow)`, as §8 requires. A session that changed only `docs/decisions/` then still gets its nudge.
8. **`last_assistant_message` isn't in `HookInput`.** Task 12 adds it as an optional field. When it is missing, the A signals read the last assistant text through `readTranscript`, which already collects that text. Nothing from it is stored except the 120-character excerpt that §8.1 allows.
9. **The budget already handles these rules.**
   - `src/budget/on-demand.ts` (`ruleRows`, `DECISION`) groups `harness-decision-*` rules as `team decisions: <n> rules`, loaded on demand. `ownersFrom` makes a manifest entry with no `item` and no blocks `harness`.
   - So `contextSet` already measures the new rules, and they never count toward the always-loaded total. Task 4 pins that with a test.
   - The AGENTS.md pointer line *is* always loaded. Task 14 raises `HARNESS_FOOTPRINT` (`test/package/package.test.ts:132`, 553 today) to the measured value.
   - `remember` writes only on-demand text, so it calls no budget ask (`budgetGate`). The `Context:` line in `doctor` and `status` doesn't change after `remember add`, and Task 8 pins that.
10. **`mergePresetSettings` isn't used.** C9 adds no permission deny rule, so no settings change is needed. Task 6 pins that `.claude/settings.json` is byte-identical after `remember add`.
11. **`update` and `sync` keep the rule entries.** `mergeManifestFiles` keeps an entry that no change names, and `plan-steps.ts` drops only deselected `item` entries. A rule entry has no `item`, so it survives. Task 4 pins this with an `update` test.
12. **Change detection can't import the manifest reader.** `manifest.ts` imports `stampHarnessFiles` from `harness-files.ts`, so importing back would make a cycle. Task 11 makes `snapshotHarnessFiles` read `.harness/manifest.json` with a plain `JSON.parse`, and take the `rel`s that match `^\.claude/rules/harness-decision-[^/]+\.md$`.
13. **The secret scan.** The vet secret scan (`src/vet/scan.ts` `SECRET_RE`) looks for commands that *read* secrets, such as `.env` and `security find-…`, not for token shapes. `looksLikeKey` (`src/ai/preset-answers.ts`) does flag any run of 32 or more letters and digits that holds a digit. That would flag every `verified_at` sha. So `src/core/secrets.ts` is new, with §7.2's table verbatim, and neither existing scan changes.
14. **`src/cli/doctor.ts` is 298 lines,** against the 300 limit. Task 8 puts the decision lines in `src/cli/doctor-decisions.ts`, the way `doctor-context.ts` does it. Doctor gains one import and one call.
15. **`GATES` moved** to `src/core/gates.ts`, which `status` and the state card both read. Task 1 adds `['decisions', 'decisions']`.
16. **Routing.** The async commands are routed in the process-entry block of `src/cli/index.ts`. Task 6 adds `remember` there, with `readlinePrompt`, and adds its lines to `USAGE`.
17. **How the agent runs the CLI (R6).**
   - The skills run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs"`, and that variable exists only inside a skill.
   - The spec allows no `/harness:remember` skill (§13).
   - So the AGENTS.md line has to name a command the agent can run from Bash. See owner question 1.
18. **C12's catalog item** is `remember` in `catalog/excluded.yaml`. Its reason today is about its license. Task 14 adds the overlap with auto memory and with harness team decisions.
19. **The README's known limits** live in `docs/reference.md#known-limits`. The config table is generated by `scripts/gen-config-docs.mjs --write`, and the example config by `serializeConfig(defaults())`.
20. **The agents-block test cap is 40 lines** (`test/templates/agents.test.ts:68`), not the spec's 60. The block has 31 lines today and gains one.

## Planning checks, run 2026-11-10

- **Read from code on `main` 5b38633.** Everything in the drift list above, plus:
  - the guard dispatch path (`decideCore` → `personOnlyInvocation` → `toDecision`);
  - `resolveAsk`, which turns an unattended ask into a deny;
  - the Stop gate's changed-file list;
  - `mergeManifestFiles`'s keep rule.
- **PR #141** (`fix/guard-glob-command`, open). Its file list was read with `gh pr view 141`. Its `PERSON_ONLY` table is unchanged in shape.
- **Not checked:** whether Claude Code's Stop input carries `last_assistant_message`. The transcript fallback (drift 8) covers both cases. Live check 5 records which one ran.

## Live checks (owner-run; not tasks)

§11's six live checks run as one batch, after Task 15 merges and the offline suite is green, and only with the owner's OK. They run Claude Code sessions and cost money. R2 (cloud sessions) stays the owner's separate call. The results update the spec's §15:
- R1 is checks 1 and 6;
- R3 is check 4;
- R5 is check 6.

## Global constraints

- **One PR per task, off `main`.**
  - Branches are named `feature/td-<n>-<slug>`. Rebase before you start and again before you merge.
  - A PR stays at or under about 400 changed lines and 20 files. If a PR grows past that, flag it in the PR and split it before review.
- **Docs in every PR.** Each task's last step checks `README.md` and `docs/reference.md`. The PR body says either "README: updated (…)" or "README: checked, no change", and the same for "reference.md".
- **Commits.** Use `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit -m "…" -- <explicit paths>`. Add no AI trailer and no footer.
- **TDD.** Write the test first and watch it fail.
  - No test touches the network or the real home folder. Git runs only in a temp repo the test makes. `HOME` and transcripts point into a temp dir.
  - `pnpm test` passes with `claude` off PATH: ``PATH="$(node -p "process.env.PATH.split(require('path').delimiter).filter(d=>!require('fs').existsSync(require('path').join(d,'claude'))).join(require('path').delimiter)")" pnpm test``.
- **Secrets and files.**
  - `ANTHROPIC_API_KEY` is read only in `src/budget/count-api.ts`. No code in this plan reads it.
  - No dotenv file (`.env*`) is ever read.
  - The quote check reads only the current session's `transcript_path`, at most the last 8 MiB, and keeps nothing from it (D1, C2). No other code reads under the home folder.
- **Seams.** Use these as they are named in the code:
  - the manifest and `applyChanges`;
  - `mergeManifestFiles`;
  - `removalChanges`;
  - `contextSet` and the on-demand `team decisions` group;
  - `readTranscript`;
  - the Stop gate's `done()`;
  - `doctor` (through a `doctor-decisions.ts` helper) and `status`, next to the `Context:` line;
  - the `PERSON_ONLY` table;
  - `unattendedEnv`;
  - the `.harness/` protection, whose `PROTECTED` and `PROTECTED_CONCRETE` stay as they are;
  - `stampHarnessFiles`.

  `mergePresetSettings` and the vet secret scan aren't changed (drift 10, drift 13).
- **Guard and protect (PR #141).**
  - Guard work is limited to the `remember` `PERSON_ONLY` entry, one call line in `guard.run`, and the one-line `log` change in `run-checks.ts`.
  - Protect work is limited to `decisionsDeny` and its two call lines.
  - There is no new `DENY` or `ASK` regex and no deny-rule change (PE §3.5, C9).
  - Each of these PRs says "rebases onto #141" in its body.
- **Copy.** Use §4.5, §5, §6.1, §6.2, §8 and §9 verbatim, except where a task gives text adjusted for drift. Events never hold field text (§5) or transcript text (C2).
- **Git calls.** Use `spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS })`, with `GIT_TIMEOUT_MS = 2000` and no shell. Inject them through an `Exec`-style function argument, so tests can fake them.
- **Size rules for every file touched:** `max-lines` 300, `max-lines-per-function` 50, `max-depth` 4, `max-params` 4, `complexity` 20. Thresholds are named constants.
- **Gates.** `pnpm typecheck` and `pnpm test` pass at the end of every task. `pnpm test:perf` also passes after Tasks 9, 10, 11 and 12.

## Review focus

1. **A teammate's `update`, `sync` or `uninstall` after decisions exist.** Expected:
   - `update` and `sync` keep every rule entry;
   - `uninstall` deletes each unedited rule and keeps an edited one with the "you edited them" line;
   - `docs/decisions/` is untouched;
   - `init` → `remember add` ×2 → `retire` → `uninstall` is byte-identical for every harness-written file.

   Tests: Task 4 (`update` keeps the entries) and Task 15 (e2e).
2. **Protect over-reach on ordinary docs work.** These stay allowed:
   - `Edit docs/plans/x.md`;
   - `rm -rf docs/plans`;
   - `mv docs/a.md docs/b.md`;
   - an existing ADR in `docs/decisions/` without the schema line.

   `rm -rf docs` and `rm -rf docs/decisions` are denied only while `checks.decisions` is true. Test: Task 11.
3. **A transcript that is huge, has broken lines, or is a symlink out of place.** Expected:
   - at most the last 8 MiB is read;
   - broken JSON lines are skipped;
   - an unreadable or missing path counts as a quote ("transcript unreadable…");
   - the hook stays inside the perf budget, and nothing from the transcript reaches `events.jsonl`.

   Tests: Task 10, including a perf test.
4. **Two branches each add a decision, and the manifest conflicts.** After taking either side of `.harness/manifest.json`, `harness remember sync` rebuilds exactly the entries for the rule files the decisions want. A foreign `harness-decision-*.md` stops it with the §4.3 line. Test: Task 4.
5. **A decision whose `verified_at` is gone after a squash merge, or a clone where git fails.** Expected:
   - staleness falls back to the decision file's last commit and prints the "Fallback ref" note;
   - a git timeout gives `couldn't check decision staleness (<reason>)`, and `doctor`, `status` and Stop never throw.

   Tests: Task 5 and Task 13.

---

## Dependencies and parallel lanes

| Task | Lane | Depends on (must be on `main`) | Files touched |
|---|---|---|---|
| 1 Config keys and the `decisions` gate | C | none | `src/core/config.ts`, `src/core/config-io.ts`, `src/core/gates.ts`, `scripts/gen-config-docs.mjs`, `templates/config.example.yaml`, `docs/reference.md`, `test/core/config*.test.ts` |
| 2 Secret scan | B | none | `src/core/secrets.ts` (new), `test/core/secrets.test.ts` (new) |
| 3 Decision file and rule rendering | A | none | `src/core/decision-file.ts`, `src/core/decision-rule.ts` (new), `test/core/decision-*.test.ts`, `test/fixtures/decisions/*` (new) |
| 4 Sync, manifest and uninstall | A | 3 | `src/core/decisions.ts` (new), `test/core/decisions-sync.test.ts`, `test/cli/update.test.ts`, `test/cli/uninstall.test.ts`, `test/budget/on-demand.test.ts` |
| 5 Staleness | A2 | 3 | `src/core/decisions-stale.ts` (new), `test/core/decisions-stale.test.ts` (new) |
| 6 `remember add`, `sync`, `list` | A | 1, 2, 4 | `src/cli/remember.ts`, `src/cli/remember-read.ts` (new), `src/cli/index.ts`, `test/cli/remember.test.ts` (new) |
| 7 `remember confirm`, `retire`, `check` | A | 5, 6 | `src/cli/remember.ts`, `src/cli/remember-read.ts`, `test/cli/remember-*.test.ts` |
| 8 `doctor` and `status` | D | 1, 4, 5 | `src/cli/doctor-decisions.ts` (new), `src/cli/doctor.ts`, `src/cli/status.ts`, `test/cli/doctor.test.ts`, `test/cli/status.test.ts` |
| 9 Guard: `remember` entry and `rememberAsk` | B | 2, 3 | `src/checks/guard.ts`, `src/checks/remember.ts` (new), `src/hooks/types.ts`, `src/hooks/run-checks.ts`, `test/checks/remember.test.ts` (new), `test/hooks/dispatch.test.ts` |
| 10 Quote detection | B | 9 | `src/checks/multi-file.ts`, `src/checks/quote.ts` (new), `src/checks/remember.ts`, `test/checks/quote.test.ts` (new), `test/perf/latency.test.ts`, `test/fixtures/transcripts/*` |
| 11 Protect and change detection | E | 1, 3 | `src/checks/decisions-protect.ts` (new), `src/checks/protect.ts`, `src/core/harness-files.ts`, `test/checks/decisions-protect.test.ts` (new), `test/hooks/change-detection.test.ts` |
| 12 Stop signals and nudge | F | 1 | `src/checks/decisions-stop.ts` (new), `src/checks/stop/gate.ts`, `src/core/state.ts`, `src/hooks/types.ts`, `src/hooks/dispatch.ts`, `test/checks/decisions-stop.test.ts` (new), `test/checks/stop/*` |
| 13 Stop warning | F | 12, 4, 5 | `src/checks/decisions-warn.ts` (new), `src/checks/decisions-stop.ts`, `test/checks/decisions-warn.test.ts` (new) |
| 14 AGENTS.md pointer, `harness sync`, footprint, catalog reason | G | 4, 6 | `templates/agents-block.md`, `src/cli/sync.ts`, `catalog/excluded.yaml`, `test/templates/agents.test.ts`, `test/package/package.test.ts`, `test/cli/sync.test.ts` |
| 15 Known limits, README, e2e byte identity | G | all | `README.md`, `docs/reference.md`, `test/e2e/decisions.test.ts` (new), `test/package/readme.test.ts` |

- **Start now, in parallel:** 1, 2 and 3. They share no file.
- **After 3:** 4 and 5 run in parallel (lanes A and A2). After 1 and 3, 11 can run too.
- **After 1:** 12 can run (lane F).
- **After 2 and 3:** 9 can run (lane B), then 10.
- **Lane A is serial:** 4 → 6 → 7.
- **Lane D (8)** needs 1, 4 and 5. It shares no file with lanes A, B, E or F.
- **Shared files:**
  - `src/hooks/types.ts` is edited by 9 (`log`) and 12 (`last_assistant_message`). Each is a one-line addition, and whichever merges second rebases.
  - `src/checks/decisions-stop.ts` is created by 12 and extended by 13.
  - `src/cli/remember*.ts` is shared by 6 and 7.
- **#141:** Tasks 9, 10 and 11 rebase onto it before they merge.
- **Docs:** `docs/reference.md` is shared by most tasks, so each task's docs step is its last step, done after rebasing.

## Plan decisions the spec leaves open (the owner can change them in review)

- **Branches:** `feature/td-<n>-<slug>`.
- **Not installed.** Every `remember` subcommand refuses when `.harness/manifest.json` is missing. It exits 1 with `Harness is not installed here (no .harness/manifest.json). Run /harness:init first.`, because sync needs the manifest.
- **`checks.decisions: false`** turns off protect's decision paths, the nudge and the Stop warning. The CLI, the guard ask, `doctor` and `status` keep working: decisions are the team's records, and the guard ask is what makes a write safe.
- **The `decisions` gate** joins `GATES` with the label `decisions`, so `status` and the state card list it.
- **Glob words in the guard.** A `remember` argument with an unquoted glob or brace character (`*`, `?`, `[`, `{`) is denied with §6.1's not-literal copy. The shell would expand it, so the person wouldn't see the text that gets written. Inside quotes it is fine.
- **The `log` field.** For a `remember` decision it holds the event text:
  - `remember add <id>` for an ask;
  - `remember: quotes tool output` for a quote deny;
  - `remember: not literal` for the not-literal deny;
  - `remember: secret (<kind>)` for a secret deny.
- **The unattended candidate event:** `{ check: 'remember', decision: 'decision-candidate', reason: '<redacted title> | <redacted rule>' }`. From the Stop signals: `reason: '<pattern id>: <redacted excerpt>'`.
- **Adopting matching rule files.** A `harness-decision-*.md` that has no manifest entry but holds exactly the bytes sync would write is adopted into the manifest, not treated as foreign. That is how `remember sync` fixes the manifest after a merge conflict (Task 4, C6).
- **Time is injected.** `today` (UTC `YYYY-MM-DD`) and `now` are function arguments everywhere, so tests pin the clock.
- **`list` with no decisions** prints `No team decisions in docs/decisions/.` and exits 0.
- **The quote check skips `list` and `check`.** It runs only for `add`, and only on `--title`, `--rule` and `--why`. `confirm`, `retire` and `sync` carry no new text.
- **The `PostToolUse` record.** `decisionSignals` sets `rememberAdded: true` when a Bash `tool_input.command` holds the words `remember` and `add` in that order and `tool_response` doesn't show an error exit. If the output can't be read, it still records it, so the session isn't nudged twice.

## Owner questions

1. **How the AGENTS.md line tells the agent to run `harness remember` (R6, drift 17).** **Owner ruling, 2026-11-10: add a `/harness:remember` skill.**
   - The skill runs `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" remember …`, so it works with a plugin-only install.
   - It stays model-invocable, so the agent can call it. That costs about 30 always-loaded tokens.
   - The AGENTS.md pointer names `/harness:remember`.
   - This reverses the spec's §13 line, and the spec records the change as C-R6.
   - Task 14 delivers the skill.

---

### Task 1: Config keys and the `decisions` gate

**Lane C. Depends on:** nothing.

**Files:**
- Modify: `src/core/config.ts` (`checks` type and defaults, `HarnessConfig.decisions`, `RULES`), `src/core/config-io.ts` (`SECTIONS.decisions`), `src/core/gates.ts`, `scripts/gen-config-docs.mjs` (`WHAT`), `templates/config.example.yaml`, `docs/reference.md` (regenerated)
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/checks/state-card.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Produces:
  - `HarnessConfig.checks.decisions: boolean`, default `true`.
  - `HarnessConfig.decisions: { max_lines: number; expiry_days: number; nudge: boolean }`, default `{ max_lines: 20, expiry_days: 90, nudge: true }`.
  - `RULES['decisions.max_lines'] = num(5, 200, true)` and `RULES['decisions.expiry_days'] = num(7, 365, true)`.
  - `SECTIONS.decisions` is §10's comment line: `Team decisions in docs/decisions/ (needs checks.decisions). Each loads as a rule when its paths are touched.`
  - `WHAT` gets §10's three key comments.
  - `GATES` gains `['decisions', 'decisions']` at the end.

- [ ] **Step 1: Write the failing tests.**
  - the defaults are as above;
  - `max_lines: 4` and `201` fail with `num`'s message, and `5` and `200` pass;
  - `expiry_days: 6` and `366` fail;
  - `nudge: 'yes'` fails with `must be a boolean`;
  - a config without a `decisions` section loads with the defaults and no warning;
  - the `status` gate list ends with `decisions: on`;
  - the state card's gate line names `decisions`;
  - the golden `config.example.yaml` and reference tests fail until the files are regenerated.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/config.test.ts test/core/config-io.test.ts test/cli/status.test.ts test/checks/state-card.test.ts`.
- [ ] **Step 3: Implement.** Then regenerate the example with `serializeConfig(defaults())` and run `node scripts/gen-config-docs.mjs --write`.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** The reference config table is regenerated. PR body: "README: checked, no change; reference.md: updated (config keys)".
- [ ] **Step 6: Commit.** `feat(config): checks.decisions and the decisions keys`.

### Task 2: Secret scan

**Lane B. Depends on:** nothing.

**Files:**
- Create: `src/core/secrets.ts`
- Test: `test/core/secrets.test.ts`

**Interfaces:**
- Produces:
  - `export interface SecretHit { kind: string; start: number; end: number }`.
  - `export function scanSecrets(text: string): SecretHit[]`: every match of §7.2's eight patterns, in text order. Each `kind` is the table's name, such as `private key` or `GitHub token`.
  - `export function redactSecrets(text: string): string`: each hit replaced by `[redacted]`.
  - `export const SECRET_PATTERNS: readonly [kind: string, re: RegExp][]`, verbatim from §7.2. The case-insensitive ones get the `i` flag, and every one gets `g`.

- [ ] **Step 1: Write the failing tests.** For each pattern, one positive and one near-miss:
  - `AKIA` followed by 15 characters fails, and by 16 passes;
  - `ghp_` followed by 35 characters fails, and by 36 passes;
  - `sk-ant-` followed by 19 characters fails;
  - a URL with no password, `https://user@host`, fails;
  - `token = short` fails, because it is under 8 characters.

  Also:
  - a 40-hex sha gives no hit;
  - redaction keeps the text around the hit;
  - two hits are both redacted;
  - 1 MB of `a` scans in under 50 ms, so the scan stays linear.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/secrets.test.ts`.
- [ ] **Step 3: Implement.** Use `String.prototype.matchAll` over each pattern, then sort the hits by `start`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Check the docs.** PR body: "README: checked, no change; reference.md: checked, no change" (Task 15 documents it).
- [ ] **Step 6: Commit.** `feat(core): fixed-pattern secret scan`.

### Task 3: Decision file and rule rendering

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/core/decision-file.ts`, `src/core/decision-rule.ts`, `test/fixtures/decisions/2026-11-03-validate-env-with-zod.md`, `test/fixtures/decisions/rule.golden.md`
- Test: `test/core/decision-file.test.ts`, `test/core/decision-rule.test.ts`

**Interfaces:**
- Produces, in `decision-file.ts`:
  - `export const DECISIONS_DIR = 'docs/decisions'` and `export const SCHEMA = 'harness-decision/1'`.
  - `export type DecisionStatus = 'active' | 'superseded' | 'retired'`.
  - `export interface TeamDecision { id: string; title: string; status: DecisionStatus; superseded_by?: string; paths: string[]; verified_at: string; verified_on: string; body: string; rel: string }`.
  - `export const isDecisionText = (text: string): boolean`: the frontmatter holds `schema: harness-decision/1`.
  - `export function parseDecision(rel: string, text: string, today: string): { decision: TeamDecision | null; errors: string[] }`:
    - returns `{ decision: null, errors: [] }` for a non-decision;
    - each error is `docs/decisions/<file>: <key> <must be …>`.
  - `export function globProblem(glob: string): string | null`: §3.2's forbidden forms and O1.
  - `export function slugId(title: string, date: string, taken: (id: string) => boolean): string`: §3.1's id rule with the `-2` suffix.
  - `export function serializeDecision(d: Omit<TeamDecision, 'rel'>): string`: the frontmatter in §3.2's key order, globs double-quoted, LF line ends and a final newline.
  - `export function addBody(rule: string, why: string): string`: `**Rule:** …\n\n**Why:** …`. The why paragraph is left out when `why` is empty.
- Produces, in `decision-rule.ts`:
  - `export const ruleRel = (id: string): string => \`.claude/rules/harness-decision-${id}.md\``.
  - `export const RULE_GLOB = /^\.claude\/rules\/harness-decision-[^/]+\.md$/`.
  - `export function renderRule(d: TeamDecision, cap: number): { text: string; lines: number; oversized: boolean }`:
    - the bytes are those of §4.1;
    - `lines` counts the content lines after the closing `---`;
    - when the rule is oversized, it keeps the first `cap - 1` lines and then adds `Cut to <cap> lines: read docs/decisions/<id>.md for the rest.`

- [ ] **Step 1: Write the failing tests.**
  - **Schema** (§11): one test per key rule, plus:
    - an unknown key;
    - an `id` that differs from the file name;
    - `superseded_by` missing when the status is `superseded`, and present when the status is `active`;
    - each forbidden glob: `/a`, `./a`, `a/../b`, `a\\b`, `*`, `**`, `**/*`;
    - more than 10 paths;
    - a `verified_on` date in the future, with an injected `today`;
    - an 81-character title, and a title with a newline;
    - a file without the schema line, which gives `null` and no errors.
  - **Id:**
    - `slugId('Validate env with Zod!', '2026-11-03', () => false)` is `2026-11-03-validate-env-with-zod`;
    - a 60-character title is cut to 40 slug characters;
    - a taken id gets `-2`, then `-3`.
  - **Render:**
    - the fixture renders byte-equal to `rule.golden.md`;
    - every glob is double-quoted;
    - the output has no `\r`;
    - a rule of exactly 20 content lines isn't oversized, and one of 21 is, cut to 19 lines plus the cut line.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/decision-file.test.ts test/core/decision-rule.test.ts`.
- [ ] **Step 3: Implement.** Parse the frontmatter with `yaml` (`parse`), splitting it off with `splitFrontmatter` from `src/budget/text.ts`. The `sha7` in the `Source:` line is `verified_at.slice(0, 7)`.
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Check the docs.** PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(decisions): decision file schema and rule rendering`.

### Task 4: Sync, manifest and uninstall

**Lane A. Depends on:** 3.

**Files:**
- Create: `src/core/decisions.ts`
- Test: `test/core/decisions-sync.test.ts`, `test/cli/update.test.ts`, `test/cli/uninstall.test.ts`, `test/budget/on-demand.test.ts`

**Interfaces:**
- Consumes: Task 3's `parseDecision`, `renderRule`, `ruleRel`, `RULE_GLOB` and `DECISIONS_DIR`; `applyChanges`, `Change`, `FsLike`, `readManifest`, `mergeManifestFiles` and `rawOf`; `stampHarnessFiles`.
- Produces:
  - `export interface DecisionSet { decisions: TeamDecision[]; errors: string[]; others: string[] }`. `others` holds the non-decision files in the folder.
  - `export function readDecisions(root: string, today: string): DecisionSet`: the files sorted by name, plus a duplicate-id error.
  - `export const isLive = (d: TeamDecision, today: string, expiryDays: number): boolean`: `active` and not expired.
  - `export interface SyncPlan { changes: Change[]; foreign: string[]; wanted: number; leftOut: number }`:
    - `changes` holds only rule files: a create, an update with `rewrite: true`, or a delete;
    - `foreign` holds the `harness-decision-*.md` files that aren't in the manifest and whose bytes differ from what sync wants.
  - `export function planSync(root: string, set: DecisionSet, cfg: HarnessConfig['decisions'], today: string): SyncPlan`.
  - `export const outOfSync = (p: SyncPlan): boolean => p.changes.length > 0`.
  - `export function commitDecisions(root: string, decisionChanges: Change[], plan: SyncPlan, o: { now: () => Date; fs?: FsLike }): void`:
    - throws `harness remember: .claude/rules/<file> is not harness's; rename it` when `plan.foreign` isn't empty;
    - otherwise calls `applyChanges(root, [...decisionChanges, ...plan.changes], m.version, o.now, o.fs, { manifest: { ...m, files: sortByRel(mergeManifestFiles(m, plan.changes)) }, manifestBefore: rawOf(m) })`, then `stampHarnessFiles(root)`.

  `SyncPlan` also has `adopt: string[]`. These are the rule files that are on disk, have no manifest entry (because the manifest was resolved from the other side of a conflict), and whose bytes equal what sync would write. They get no change. `commitDecisions` adds a `{ rel, kind: 'create', hash }` entry for each one to the explicit manifest. If the bytes differ, the file is `foreign`.

- [ ] **Step 1: Write the failing tests** (§11 Sync), in a temp repo made with `init` from the test helpers:
  - add, change, retire, supersede, expire (with an injected `today`) and delete a decision file. Each gives exactly the expected `changes`;
  - after `commitDecisions`, the manifest has one `{ rel, kind: 'create', hash }` entry per rule, sorted by `rel`, and no `docs/decisions/` entry;
  - a foreign `harness-decision-x.md` stops it with the line above, and nothing is written;
  - **Review focus 4:** the manifest is overwritten with a copy that lacks one rule entry, and `planSync` plus `commitDecisions` restore exactly that entry;
  - `.claude/settings.json` is byte-identical before and after;
  - **`update.test.ts` (Review focus 1):** after a decision is synced, `update` keeps the rule entry and the file;
  - **`uninstall.test.ts`:** an unedited rule is deleted, an edited one is kept with the edited line, `--force` removes it, `.claude/rules/` is removed when it's emptied, and `docs/decisions/` stays;
  - **`on-demand.test.ts`:** a synced rule appears in `contextSet(...).onDemand` as `team decisions: 1 rules`, owned by `harness`, and `contextSet(...).total` is unchanged.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/decisions-sync.test.ts test/cli/uninstall.test.ts test/cli/update.test.ts test/budget/on-demand.test.ts`.
- [ ] **Step 3: Implement** `readDecisions`, `planSync` and `commitDecisions` as above. `uninstall.ts` and `update.ts` need no change. If a test shows they do, stop and raise it in the PR.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** reference.md "Uninstall": "Rules generated from team decisions are removed like other created files; `docs/decisions/` is left alone." PR body: "README: checked, no change; reference.md: updated (uninstall)".
- [ ] **Step 6: Commit.** `feat(decisions): rule sync through the manifest`.

### Task 5: Staleness

**Lane A2. Depends on:** 3.

**Files:**
- Create: `src/core/decisions-stale.ts`
- Test: `test/core/decisions-stale.test.ts`

**Interfaces:**
- Consumes: `TeamDecision` and `renderRule`.
- Produces:
  - `export type Git = (args: string[]) => { ok: boolean; out: string; reason?: string }`, defaulting to `spawnSync` with `GIT_TIMEOUT_MS = 2000`.
  - `export interface Staleness { id: string; dead: string[]; changed: string[]; ref: string; fallback: boolean; expired: boolean; oversized: { lines: number } | null }`.
  - `export function staleness(root: string, ds: TeamDecision[], o: { today: string; expiryDays: number; cap: number; git?: Git }): { states: Staleness[]; note: string | null }`:
    - `note` is `couldn't check decision staleness (<reason>)` on a git failure;
    - in that case `dead` and `changed` are empty and the time-based states still compute.
  - `export const isStale = (s: Staleness): boolean => s.dead.length > 0 || s.changed.length > 0`.

  The algorithm is §9's, as written:
  - one `git ls-files -z` for all decisions;
  - per decision, `git log -1 --format=%H -- <rel>`;
  - `<ref>` is chosen with `merge-base --is-ancestor`, and `cat-file -e <sha>^{commit}` says whether the sha is in the clone;
  - one `diff --name-only -z <ref> HEAD` per distinct ref;
  - the decision file is filtered out.

- [ ] **Step 1: Write the failing tests** (§11 Staleness), in temp git repos:
  - a glob matching nothing is `dead`;
  - a linked file changed after `verified_at` is `changed`, listing that file;
  - a decision committed in the same commit as its code isn't changed (C5);
  - a `verified_at` that isn't in the clone falls back to the file's commit, with `fallback: true` (C4);
  - `verified_on` 91 days before `today` is expired, and 90 days isn't;
  - a 21-line rule with a cap of 20 is `oversized: { lines: 21 }`;
  - **Review focus 5:** a fake `Git` returning `{ ok: false, reason: 'timeout' }` gives the note and no throw;
  - a spy `Git` sees one `ls-files` call and one diff per distinct ref.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/core/decisions-stale.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.**
- [ ] **Step 5: Check the docs.** PR body: "README: checked, no change; reference.md: checked, no change".
- [ ] **Step 6: Commit.** `feat(decisions): git staleness and expiry`.

### Task 6: `harness remember add`, `sync` and `list`

**Lane A. Depends on:** 1, 2 and 4.

**Files:**
- Create: `src/cli/remember.ts`, `src/cli/remember-read.ts`
- Modify: `src/cli/index.ts` (the process-entry route and `USAGE`)
- Test: `test/cli/remember.test.ts`

**Interfaces:**
- Consumes: `unattendedEnv`, `insideClaude`, `scanSecrets`, `slugId`, `serializeDecision`, `addBody`, `globProblem`, `readDecisions`, `planSync` and `commitDecisions`.
- Produces:
  - `export type RememberEnv = CliEnv & { prompt: Prompt; now?: () => Date; fs?: FsLike }`.
  - `export async function remember(args: string[], cli: RememberEnv): Promise<number>`, which dispatches the subcommands. Exit codes are 0, 1, and 2 for usage.
  - `export function writeGate(cli: RememberEnv, config: HarnessConfig): string | null` runs §5's write steps 1 and 2. It returns the refusal copy, or `null`.
  - `export function list(root: string, cfg: HarnessConfig, today: string): string[]` (in `remember-read.ts`). Its staleness column is empty until Task 7.
  - `USAGE` gains §5's six lines.

- [ ] **Step 1: Write the failing tests** (§11 CLI):
  - **`add`:**
    - prints §5's three `add` lines and exits 0;
    - the decision has `verified_at` equal to HEAD (set in a temp repo) and `verified_on` equal to today;
    - `--supersedes <id>` sets the other decision to `superseded` with `superseded_by`;
    - a second `add` of the same title on the same day prints `docs/decisions/<id>-2.md`;
    - a rule over the cap prints §4.2's refusal and exits 1;
    - each field limit is enforced;
    - a dead `--path` gives §5's dead-path refusal.
  - **Refusals:**
    - with `CI=true`, the unattended refusal, exit 1, and nothing written;
    - with `CLAUDECODE=1` and `checks.guard: false`, the guard-off refusal;
    - `--why "token=abcdefgh12"` gives the secret refusal naming `--why` and `assignment`;
    - with `tty: true` and the prompt answering no, nothing is written and the exit is 1;
    - `--yes` skips the prompt;
    - `--dry-run` lists the files and writes nothing;
    - with no manifest, the not-installed refusal.
  - **Side effects:**
    - `git status --porcelain` shows the new files untracked and nothing staged;
    - `.claude/settings.json` is unchanged;
    - `events.jsonl` has `remember added` with no field text, and `refused` with only the reason word.
  - **`sync`:**
    - with nothing to do, `Rules in sync: 1 decisions, 1 rules (0 expired or retired, left out).`;
    - after the file is edited by hand, one `Wrote …` line.
  - **`list`:** the sorted lines in §5's format.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/cli/remember.test.ts`.
- [ ] **Step 3: Implement.**
  - Parse the flags by hand, as `items.ts` does.
  - `add` builds one `create` change for the decision file. With `--supersedes`, it also builds an `update` change for the superseded decision. Then it calls `commitDecisions`.
  - Route `remember` in `index.ts` with `readlinePrompt`, as `uninstall` is routed.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** reference.md "Commands in full" gets the six `remember` lines. README "Commands" gets one line, `harness remember` (see Task 15). PR body: "README: updated (commands); reference.md: updated (commands)".
- [ ] **Step 6: Commit.** `feat(cli): harness remember add, sync and list`.

### Task 7: `harness remember confirm`, `retire` and `check`

**Lane A. Depends on:** 5 and 6.

**Files:**
- Modify: `src/cli/remember.ts`, `src/cli/remember-read.ts`
- Test: `test/cli/remember-confirm.test.ts`, `test/cli/remember-check.test.ts`

**Interfaces:**
- Consumes: `staleness`, `isStale`, `outOfSync`, and `writeGate` from Task 6.
- Produces:
  - `export function decisionLines(root: string, cfg: HarnessConfig, today: string, git?: Git): { lines: { level: 'ok' | 'fix' | 'note'; text: string }[]; summary: { n: number; errors: number; stale: number; expired: number; oversized: number; inSync: boolean } }`, in `remember-read.ts`. The texts are §9's doctor copy, verbatim. Task 8 and `check` share it.
  - `list` fills its staleness column from `staleness`.

- [ ] **Step 1: Write the failing tests:**
  - **`confirm`:**
    - prints §5's line with the expiry date (`verified_on` plus `expiry_days`);
    - a dead path refuses with §5's dead-path copy;
    - an unknown id gives §5's unknown-id copy.
  - **`retire`:**
    - without `--by`, prints `Retired <id>. Removed its rule. The decision file stays as a record.`;
    - with `--by`, the superseded form in §5;
    - the rule is deleted, and the file stays with `status: retired`.
  - **`check`:**
    - prints the doctor lines, then `<n> decisions: <e> errors, <s> stale, <x> expired, <o> oversized, rules <in sync|out of sync>`;
    - exits 1 on an invalid file or when out of sync;
    - exits 0 when the only problems are stale, expired or oversized.
  - **Both write subcommands** go through `writeGate`, with the unattended test repeated for each.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** reference.md gets a new section, "Team decisions": the folder, the file format, the subcommands, `check` for CI, and the expiry. PR body: "README: checked, no change; reference.md: updated (team decisions)".
- [ ] **Step 6: Commit.** `feat(cli): harness remember confirm, retire and check`.

### Task 8: `doctor` and `status`

**Lane D. Depends on:** 1, 4 and 5.

**Files:**
- Create: `src/cli/doctor-decisions.ts`
- Modify: `src/cli/doctor.ts` (one import and one call, after `contextChecks`), `src/cli/status.ts` (one line, after the `Context:` line)
- Test: `test/cli/doctor.test.ts`, `test/cli/status.test.ts`

**Interfaces:**
- Consumes: `readDecisions`, `planSync`, `outOfSync` and `staleness`.
- Produces:
  - `export function decisionChecks(root: string, config: HarnessConfig, p: { ok; fix; note }): void`, with the same `p` shape as `contextChecks`. It prints §9's doctor table, verbatim. The "Foreign rule" line comes from `plan.foreign`.
  - `export function decisionsStatusLine(root: string, config: HarnessConfig): string`: `Decisions: <n> active (<s> stale, <x> expired), rules <in sync|out of sync>`, or `Decisions: none`.

  If Task 7 is merged first, both take their texts from `decisionLines`. Otherwise this task holds the copy, and Task 7 imports it from here. Whichever task merges second removes the duplicate.

- [ ] **Step 1: Write the failing tests:**
  - one test per §9 doctor row: summary, invalid, sync, foreign rule, dead, changed, expired, oversized and fallback ref;
  - `fix` rows make `doctor` exit 1, and `note` rows don't;
  - `status` prints its line right after `Context:`;
  - `Decisions: none` in a repo with no folder;
  - the `Context:` total is the same before and after a `remember add` (drift 9);
  - with a fake git timeout, doctor prints the staleness note and doesn't throw.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/cli/doctor.test.ts test/cli/status.test.ts`.
- [ ] **Step 3: Implement.** Check that `doctor.ts` stays at or under 300 lines.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** reference.md "Team decisions" gets the doctor and status lines. PR body: "README: checked, no change; reference.md: updated (team decisions)".
- [ ] **Step 6: Commit.** `feat(doctor): team decision checks and status line`.

### Task 9: Guard: the `remember` entry and `rememberAsk`

**Lane B. Depends on:** 2 and 3. **Rebases onto #141.**

**Files:**
- Create: `src/checks/remember.ts`
- Modify:
  - `src/checks/guard.ts`: one `PERSON_ONLY` entry, and one line in `guard.run`;
  - `src/hooks/types.ts`: `log?: string` on the deny and ask `Decision`;
  - `src/hooks/run-checks.ts`: log `d.log ?? reason`.
- Test: `test/checks/remember.test.ts`, `test/hooks/dispatch.test.ts`

**Interfaces:**
- Consumes: `walkCommands`, which is exported from `guard.ts`; `words` and `unquote` from `shell-words.ts`; `scanSecrets` and `redactSecrets`; `slugId`, `ruleRel` and `readDecisions`; `appendEvent`.
- Produces:
  - `export const REMEMBER_WHY = 'the agent is saving a team decision'`.
  - The entry: `remember: { kind: 'ask', allowed: (a) => ['list', 'check'].includes(a[0]) || a.includes('--dry-run') || a.includes('--help'), why: () => REMEMBER_WHY }`.
  - The `guard.run` line, after `const d = decideCommand(cmd, ctx)`: `if (d.kind === 'ask' && d.reason.includes(REMEMBER_WHY)) return rememberAsk(ctx, cmd);`.
  - `export function rememberAsk(ctx: Ctx, command: string): Exclude<Decision, { kind: 'allow' }>`. It works in §6.1's order:
    1. **not literal:** deny;
    2. **secret:** deny;
    3. **quote:** a hook that always returns `null` until Task 10;
    4. otherwise the subcommand's ask copy.

    Every result carries `check: 'guard'` and the `log` text from "Plan decisions".
  - When `ctx.unattended` and the subcommand is `add`, it appends the `decision-candidate` event with the redacted title and rule.

- [ ] **Step 1: Write the failing tests** (§11 Guard):
  - **Through `guard.run`:**
    - `harness remember add --title "T" --rule "R" --path "src/a.ts"` asks with §6.1's `add` copy, naming `docs/decisions/<id>.md`;
    - `remember list`, `remember check`, and `add --dry-run` without a glob are allowed.
  - **Wrappers:** `npx @khubaibqaiser/harness remember add …`, `bash -c '…'`, `env X=1 harness remember add …` and `node dist/cli.mjs remember add …` all reach `rememberAsk`.
  - **Not literal:**
    - `$HOME`, a backtick, `$(…)` and `<(…)` deny with the not-literal copy;
    - `echo x | harness remember add …` denies;
    - an unquoted `--path src/*` denies;
    - a quoted `--path "src/*"` asks.
  - **Secret:** `--rule "use ghp_<36 chars>"` denies, naming `GitHub token in --rule`.
  - **The other subcommands:** the `confirm` ask names `<sha7>` and `expiry_days`. The `retire` and `sync` asks name their files.
  - **Through dispatch, unattended** (`CI=true`): the ask becomes a deny, and exactly one `decision-candidate` event is logged, with the secret redacted.
  - **The log:** the logged `reason` for an `add` ask is `remember add <id>` and holds no title, rule or why.
  - **Ordering (drift 5):** `--rule "never commit .env"` is still denied by the `.env` rule.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/checks/remember.test.ts test/hooks/dispatch.test.ts`.
- [ ] **Step 3: Implement.** Find the words with `walkCommands`: take the first segment where a token `remember` follows the harness token at `k`. A segment with `prev === '|'`, or with an argument starting with `<` or `@`, is "fed from stdin or a file".
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test` and `pnpm test:perf`.
- [ ] **Step 5: Check the docs.** reference.md "Guard details": `harness remember` asks, and it denies text that isn't literal or that holds a secret. PR body: "README: checked, no change; reference.md: updated (guard details)", plus "rebases onto #141".
- [ ] **Step 6: Commit.** `feat(guard): harness remember asks with the decision text`.

### Task 10: Quote detection

**Lane B. Depends on:** 9. **Rebases onto #141.**

**Files:**
- Create: `src/checks/quote.ts`, `test/fixtures/transcripts/{bash,webfetch,read,agent,prompt-only}.jsonl`
- Modify: `src/checks/multi-file.ts` (export `readTranscript`, read the tail, collect tool text), `src/checks/remember.ts` (fill in the quote hook)
- Test: `test/checks/quote.test.ts`, `test/checks/multi-file.test.ts` (must stay green), `test/perf/latency.test.ts`

**Interfaces:**
- Produces:
  - `export function readTranscript(path: unknown, o?: { tailBytes?: number }): Rec[] | undefined`. `Rec` gains `tool: string[]`, which holds the text of each `tool_result` block (string content and `text` blocks) in a `user` record. Such records still get `prompt: false`, as today.
  - `export const TAIL_BYTES = 8 * 1024 * 1024`.
  - `export const QUOTE_WORDS = 8`.
  - `export const normalise = (s: string): string`: §7.1 step 3.
  - `export function findQuote(fields: Record<string, string>, transcriptPath: unknown): { field: string; excerpt: string } | null`:
    - looks for an 8-word window, a URL (`/\bhttps?:\/\//i`) in `rule` or `why`, or an unreadable transcript, whose excerpt is `transcript unreadable, so harness can't check`;
    - the excerpt is the draft's own words, cut to 80 characters.
  - `rememberAsk`:
    - a quote without `--quoted` denies with §6.1's copy;
    - a quote with `--quoted` puts the §6.1 warning at the start of the `add` ask;
    - `log` is `remember: quotes tool output` for both.

- [ ] **Step 1: Write the failing tests** (§11 Quote detection):
  - **Matching:**
    - an 8-word quote from each of the Bash, WebFetch, Read and Agent fixtures denies;
    - a 7-word quote passes;
    - upper case, punctuation, NFKC (`ﬁ`) and zero-width variants still match;
    - a URL in `--why` counts;
    - text found only in the person's prompt passes.
  - **Unreadable transcripts:** a missing path and a directory each count as quotes.
  - **`--quoted`:** turns the deny into the warning ask.
  - **The tail:** a 9 MiB transcript, with the quote only in its first MiB, passes.
  - **Review focus 3:** a transcript of 50,000 broken lines is read without a throw.
  - **Nothing stored (C2):** after each case, `events.jsonl` holds no excerpt, and no file under the temp root other than `events.jsonl` changed.
  - **Perf:** a PreToolUse with no `remember` reads no transcript; spy on `readFileSync` or `openSync`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/checks/quote.test.ts test/checks/multi-file.test.ts`.
- [ ] **Step 3: Implement.**
  - The tail read opens the file, `fstat`s it, reads the last `tailBytes` with `readSync`, and drops the first partial line.
  - Matching builds a `Set` of the 8-word windows of the normalised tool text, then checks each window of each field. That keeps it linear in the transcript size.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test` and `pnpm test:perf`.
- [ ] **Step 5: Check the docs.** reference.md "Team decisions" gets §7.1's limits. PR body: "README: checked, no change; reference.md: updated (team decisions)", plus "rebases onto #141".
- [ ] **Step 6: Commit.** `feat(guard): decisions that repeat tool output need the person's yes`.

### Task 11: Protect and change detection

**Lane E. Depends on:** 1 and 3. **Rebases onto #141.**

**Files:**
- Create: `src/checks/decisions-protect.ts`
- Modify:
  - `src/checks/protect.ts`: two call lines, one before each of the two `isProtected` exits in `run`;
  - `src/core/harness-files.ts`: `snapshotHarnessFiles` gains the rule files the manifest lists.
- Test: `test/checks/decisions-protect.test.ts`, `test/hooks/change-detection.test.ts`

**Interfaces:**
- Consumes: `isDecisionText`, `DECISIONS_DIR` and `RULE_GLOB`; `toRepoPath`.
- Produces:
  - `export const DECISIONS_REASON` is §6.2's reason, verbatim.
  - `export const DECISION_CONCRETE = ['docs', 'docs/decisions', '.claude/rules']`.
  - `export function decisionsDeny(root: string, config: HarnessConfig, writes: string[], removed: string[]): Decision | null`:
    - returns `null` when `config.checks.decisions` is false;
    - denies a write to a `RULE_GLOB` path, to an existing file in `docs/decisions/` whose text `isDecisionText`, or to a path in `docs/decisions/` that doesn't exist yet;
    - denies a removal of a `DECISION_CONCRETE` path or an ancestor of one;
    - always with `check: 'protect'`.
  - The calls in `protect.run`:
    - for the tool route, `decisionsDeny(root, config, [target], [])`;
    - for the shell route, `decisionsDeny(root, config, paths, removed)`, right after `paths` is computed.

    `PROTECTED` and `PROTECTED_CONCRETE` don't change.
  - `snapshotHarnessFiles` adds each manifest `rel` that matches `RULE_GLOB` and exists (drift 12).

- [ ] **Step 1: Write the failing tests** (§11 Protect and Change detection):
  - **Denied:**
    - Edit, Write and `tee`/`>` to `.claude/rules/harness-decision-x.md`;
    - Edit of an existing decision;
    - Write of a new `docs/decisions/new.md`;
    - `git checkout -- docs/decisions/x.md` for a decision;
    - inline code that names the path;
    - `rm -rf docs`, `rm -rf docs/decisions` and `rm -rf .claude/rules`.
  - **Allowed (Review focus 2):**
    - Edit of an existing non-decision `docs/decisions/README.md`;
    - `Edit docs/plans/x.md`;
    - `rm -rf docs/plans`;
    - Read and `cat` of a decision.
  - **Off:** with `checks.decisions: false`, every case above is allowed except what `.claude` protection already covered.
  - **Unchanged:** the settings fragment has no new deny rule.
  - **Change detection:**
    - a script rewriting a manifest-listed rule is reported at the next prompt;
    - a `commitDecisions` write isn't reported.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/checks/decisions-protect.test.ts test/hooks/change-detection.test.ts`.
- [ ] **Step 3: Implement.** Read a file only when its path is under `docs/decisions/`. Read at most 4 KiB, enough for the frontmatter, so ordinary edits cost nothing.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test` and `pnpm test:perf`.
- [ ] **Step 5: Check the docs.** reference.md "Guard and protection" gets one bullet: decisions and their rules change only through `harness remember`. PR body: "README: checked, no change; reference.md: updated (guard and protection)", plus "rebases onto #141".
- [ ] **Step 6: Commit.** `feat(protect): team decisions change only through harness remember`.

### Task 12: Stop signals and the nudge

**Lane F. Depends on:** 1.

**Files:**
- Create: `src/checks/decisions-stop.ts`
- Modify:
  - `src/checks/stop/gate.ts`: the docs-only exit goes through `done()`, and `done()` appends `decisionNotes(ctx, changed)`;
  - `src/core/state.ts`: `decisionHits?`, `decisionNudged?` and `rememberAdded?`;
  - `src/hooks/types.ts`: `last_assistant_message?: string`;
  - `src/hooks/dispatch.ts`: `decisionSignals` in `registry`.
- Test: `test/checks/decisions-stop.test.ts`, `test/checks/stop/gate.test.ts`

**Interfaces:**
- Produces:
  - `export const PROMPT_SIGNALS: readonly [id: string, re: RegExp][]` is P1 to P5, verbatim and case-insensitive. `ASSISTANT_SIGNALS` is A1 and A2.
  - `export const MAX_HITS = 3`, `PROMPT_SCAN = 4000` and `EXCERPT = 120`.
  - `export const decisionSignals: Check`:
    - its events are `['UserPromptSubmit', 'PostToolUse']`, it isn't pure, and it always returns `allow`;
    - it stores the hits, and sets `rememberAdded` (see "Plan decisions");
    - when unattended, it logs each new hit once as a `decision-candidate` with the redacted excerpt, and stores nothing to show.
  - `export function decisionNotes(ctx: Ctx, changed: string[]): string[]`: the nudge text, or none. Task 13 adds the warnings.
  - The nudge is §8.1's copy, verbatim, with the first hit's excerpt.
  - The gate's `done(d)`:
    - when `d.kind === 'allow'` and `config.checks.decisions`, it joins `decisionNotes` with the tool-missing text into one `context`;
    - it saves `decisionNudged` only when the note is returned.

- [ ] **Step 1: Write the failing tests** (§11 Stop):
  - **The signals:**
    - each P and A pattern, with one negative sample each, such as "always-on" and "never mind";
    - a prompt over 4,000 characters, with the match after character 4,000, gives no hit;
    - at most 3 hits are stored.
  - **When it shows:**
    - only once per session;
    - not after a `remember add` PostToolUse;
    - not with `nudge: false`;
    - not with `checks.decisions: false`;
    - not with `checks.stop: false`.
  - **Unattended:** no note, and one `decision-candidate` per hit.
  - **Blocked Stops:** when a step fails and the gate blocks, there is no note. On the next, passing Stop the note appears (C10).
  - **Docs-only:** a session that changed only `docs/decisions/` still shows the nudge.
  - **The A-signal fallback:** with `last_assistant_message` missing, the signals read the transcript fixture.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/checks/decisions-stop.test.ts test/checks/stop/gate.test.ts`.
- [ ] **Step 3: Implement.** `gate.ts` gains at most about 10 lines. The note logic stays in `decisions-stop.ts`.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test` and `pnpm test:perf`.
- [ ] **Step 5: Check the docs.** reference.md "Stop gate" gets one bullet on the nudge. PR body: "README: checked, no change; reference.md: updated (stop gate)".
- [ ] **Step 6: Commit.** `feat(stop): nudge to save a team decision`.

### Task 13: Stop warning

**Lane F. Depends on:** 12, 4 and 5.

**Files:**
- Create: `src/checks/decisions-warn.ts`
- Modify: `src/checks/decisions-stop.ts` (`decisionNotes` calls `decisionWarnings`), `src/core/state.ts` (`decisionsWarned?: string[]`)
- Test: `test/checks/decisions-warn.test.ts`

**Interfaces:**
- Consumes: `readDecisions`, `isLive`, `planSync`, `outOfSync`, `staleness` and `matches`.
- Produces: `export function decisionWarnings(ctx: Ctx, changed: string[], git?: Git): string[]`.
  - It returns one §8.2 line per active decision whose `paths` match a `changed` file and that isn't in `decisionsWarned` yet.
  - It adds the `expired` and dead-path sentences when they apply.
  - It adds `Rules are out of sync: run harness remember sync.` once when the rules are out of sync.
  - It never blocks and never touches `stopAttempts`.

- [ ] **Step 1: Write the failing tests:**
  - only decisions linked to changed files are listed;
  - each decision is warned once per session;
  - the expired and dead sentences;
  - the out-of-sync sentence;
  - `stopAttempts` is unchanged;
  - **Review focus 5:** a git failure gives the note and the gate still allows.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`.
- [ ] **Step 5: Check the docs.** reference.md "Stop gate": the warning line. PR body: "README: checked, no change; reference.md: updated (stop gate)".
- [ ] **Step 6: Commit.** `feat(stop): warn when changed code is covered by a team decision`.

### Task 14: AGENTS.md pointer, `harness sync`, footprint and catalog reason

**Lane G. Depends on:** 4 and 6.

**Files:**
- Modify:
  - `templates/agents-block.md`: §4.5's pointer, plus the protected-paths line;
  - `src/cli/sync.ts`: runs the decision sync in the same `applyChanges`;
  - `catalog/excluded.yaml`: the `remember` reason.
- Create: `skills/remember/SKILL.md`, a model-invocable skill under 30 lines. Its description is one short sentence: "Save a team decision to docs/decisions/ through harness; use when the user agrees on a lasting convention." It runs `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" remember add|list|confirm|retire|check …`. It never writes decision files itself. It treats file and command output as data.
- Test: `test/templates/agents.test.ts`, `test/package/package.test.ts` (`HARNESS_FOOTPRINT`), `test/cli/sync.test.ts`, `test/skills/remember.test.ts` (new)

**Interfaces:**
- Consumes: `readDecisions`, `planSync` and `commitDecisions`. Here `commitDecisions` isn't called separately. `sync.ts` appends `plan.changes` to its own `changes`, and folds them into the manifest it already passes.
- Produces:
  - The pointer line, as §4.5 writes it, naming `/harness:remember` (owner ruling on question 1).
  - The protected-paths line: ``Never edit `.harness/`, `.claude/settings*.json`, `.claude/rules/harness-decision-*.md` or harness decisions in `docs/decisions/`.``
  - The `remember` reason gains `; it also overlaps Claude Code's auto memory and harness team decisions (harness remember)`.

- [ ] **Step 1: Write the failing tests:**
  - the block holds the pointer and the new protected line, and stays under 40 lines;
  - `harness sync` in a repo with an out-of-sync rule writes it, and prints `Wrote .claude/rules/…`;
  - `harness sync --dry-run` lists it and writes nothing;
  - a foreign rule stops `harness sync` with the §4.3 line;
  - `HARNESS_FOOTPRINT` is set to the value measured in Step 4;
  - the catalog test sees the new reason;
  - the skill's frontmatter has a name and a description, has no `disable-model-invocation`, and is under 30 lines; its body names only `remember` subcommands and never asks for an API key.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm vitest run --project unit test/templates/agents.test.ts test/package/package.test.ts test/cli/sync.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Record the new footprint in the constant and in the PR body (about 553 plus 50 plus about 30 for the skill's description at planning). Its comment says "raise only in a reviewed PR".
- [ ] **Step 5: Check the docs.** reference.md "What `init` changes in your repo": the AGENTS.md line. PR body: "README: checked, no change; reference.md: updated (init changes)".
- [ ] **Step 6: Commit.** `feat(agents): point the agent at team decisions`.

### Task 15: Known limits, README and e2e byte identity

**Lane G. Depends on:** every earlier task.

**Files:**
- Create: `test/e2e/decisions.test.ts`
- Modify: `README.md`, `docs/reference.md` (known limits), `test/package/readme.test.ts`
- Test: `test/e2e/decisions.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - **Review focus 1:** from the built `dist/cli.mjs` in a temp repo with `HOME` set to a temp dir, `init` → `remember add` ×2 → `retire` → `uninstall --yes` restores every harness-written file byte for byte, and leaves `docs/decisions/` with two files;
  - `init` → `uninstall` is unchanged by this feature;
  - `readme.test.ts` checks that the README links `docs/reference.md#team-decisions`.
- [ ] **Step 2: Run them and confirm they fail.** `pnpm build && pnpm vitest run --project e2e test/e2e/decisions.test.ts`.
- [ ] **Step 3: Write the docs.**
  - **README:** one short "Team decisions" paragraph of at most 6 lines, linking to the reference. The README stays user-first, at about 120 lines.
  - **reference.md known limits:** every item in §12, plus:
    - drift 5: a rule that names `.env` is saved from your own terminal;
    - drift 4: `--dry-run` with a glob asks;
    - the English-only nudge;
    - the 8-word quote check;
    - the fixed secret patterns.
- [ ] **Step 4: Run the tests and confirm they pass.** `pnpm test`, then the e2e project.
- [ ] **Step 5: Check the docs.** PR body: "README: updated (team decisions); reference.md: updated (known limits)".
- [ ] **Step 6: Commit.** `docs(decisions): known limits, README and the byte-identity test`.

---

## Self-review (2026-11-10)

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | D1 scope, C2 | 10 (transcript only, nothing stored) |
  | D2, §3 files | 3 |
  | D3, §4.1–4.2 rules and the cap, C1 | 3 |
  | §4.3 sync, C3 | 4, 6, 14 (`harness sync`) |
  | §4.4 manifest and uninstall, C6, C7 | 4, 15 |
  | §4.5 AGENTS.md | 14 |
  | D4, §5 CLI | 6, 7 |
  | §6.1 guard, C11 | 9 |
  | D9, §7.1 quotes | 10 |
  | §7.2 secrets | 2, 6, 9 |
  | §6.2 protect, C8, C9 | 11 |
  | §6.3 change detection | 11 |
  | D5, §8.1 nudge, C10 | 12 |
  | D7, §8.2 warning | 13 |
  | D6, §9 staleness, C4, C5 | 5 |
  | §9 doctor and status | 8 (and 7 for `check`) |
  | D8 unattended | 6 (CLI), 9 (guard), 12 (signals) |
  | §10 config | 1 |
  | §11 tests | spread across their tasks; live checks are the owner's batch |
  | §12 known limits, C13 | 15 |
  | C12 catalog reason | 14 |
  | O1 repo-wide globs | 3 |
  | D10, D11, §13 | nothing builds them |

  - **Gaps:** R2 and R4 need no code (flat names). R6 is owner question 1.
- **Type consistency.** These names are used the same way across tasks: `TeamDecision`, `DecisionSet`, `SyncPlan`, `readDecisions`, `planSync`, `outOfSync`, `commitDecisions`, `isLive`, `ruleRel`, `RULE_GLOB`, `renderRule`, `Staleness`, `staleness`, `Git`, `scanSecrets`, `redactSecrets`, `REMEMBER_WHY`, `rememberAsk`, `findQuote`, `readTranscript`, `decisionsDeny`, `decisionSignals`, `decisionNotes`, `decisionWarnings`, `decisionChecks`, `decisionLines` and `writeGate`. Note that `TeamDecision` is named to avoid a clash with the hooks' `Decision`.
- **Review focus.** Each of the five lines has its test in its owning task:
  - 1 in Tasks 4 and 15;
  - 2 in Task 11;
  - 3 in Task 10;
  - 4 in Task 4;
  - 5 in Tasks 5, 8 and 13.
- **Proportion.** The plan is about 1.5 times the spec's length. It has no function bodies. The only algorithms spelled out are the ones the signatures don't decide:
  - the staleness ref rule, which is the spec's own;
  - the quote window set;
  - the transcript tail read.
