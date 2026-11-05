# Usage and adherence report implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. The owner confirms the method in review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harness report` reads this repo's Claude Code transcripts and harness's own logs, and writes a local, self-contained HTML page answering four questions: did skills fire, were rules followed, where did tokens go, are the gates accurate. Around it: a timing log, an attack suite, a doctor branch-protection check, `harness rules` (ESLint and TS settings at `error`, applied on a yes), and `harness eval` (paid, owner-run `claude plugin eval`).

**Size:** 23 tasks, each one PR at or under 400 changed lines and 20 files (estimates at planning; measured at PR time). Two planning steps, P0 and L1, need the owner's OK before they run.

**Architecture:**
- **Reading.** `src/report/locate.ts` finds the session files for this repo. `src/report/transcript.ts` streams one file at a time and turns each line into a small normalised record (`TRec`). Nothing holds a whole file.
- **Metrics.** Each metric is an accumulator (`Acc`) fed record by record and turn by turn (`src/report/turns.ts`). Memory holds only aggregates plus capped window lists.
- **Rendering.** `src/report/html.ts` turns one `ReportData` into one HTML string: inline CSS and SVG, no JavaScript. `src/report/export.ts` turns the same data into counts-only JSON and checks it against an allowlist.
- **Hook side.** The hook side adds only appends: `src/core/timing.ts` (a new leaf module) and two optional fields on `HarnessEvent`. The dispatcher hookup is a separate, late task, because PR-size edits `dispatch.ts`.
- **Commands.** `src/rules/*` (proposal, counts) and `src/eval/*` (plugin builder, runner) are new folders. Their install-side and CLI-routing edits are separate late tasks.

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml`, `magicast` (already a dependency). No new dependency.

**Spec:** `docs/specs/2026-11-05-usage-adherence-design.md` (owner-approved 2026-11-05, binding). Section numbers (§n) and decision ids (U, O) refer to it.

## Dependencies and parallel lanes

**Files other plans touch** (from `docs/plans/2026-11-05-pr-size.md` and `docs/plans/2026-11-05-personal-preset.md`, read 2026-11-05):
- PR-size: `src/checks/guard.ts` (Tasks 1, 5), `src/core/config.ts` and `config-io.ts` (2), `src/hooks/dispatch.ts` (4, 7, 8), `src/install/plan.ts`, `src/cli/init.ts` and `src/cli/status.ts` (7), `test/perf/latency.test.ts` (7, 10).
- Preset: `src/install/*` (5, 6a, 7, 12a), `src/catalog/presets.ts` (1a), `src/cli/index.ts` (1b, 11, 13, 14), `src/checks/guard.ts` (10, 11), `src/core/config.ts` (3), `src/budget/measure.ts`, `src/cli/git.ts`, `src/cli/validate.ts`.

**Lane A** touches none of those files. It starts now, in parallel with both builds. Lane B waits on one named task from another plan. Lane C waits on the preset's install work.

| Task | Lane | Depends on (must be on `main`) | Files touched |
|---|---|---|---|
| 1 Locate this repo's sessions | A | none | `src/report/locate.ts` (new) |
| 2 Streaming transcript reader | A | none | `src/report/transcript.ts` (new), `test/fixtures/transcripts/make.ts` (new), `test/perf/report.test.ts` (new) |
| 3 Turns, accumulators, usage metrics | A | 2 | `src/report/acc.ts`, `src/report/turns.ts`, `src/report/metrics/usage.ts` (all new) |
| 4 Skills metric | A | 3 | `src/report/metrics/skills.ts` (new) |
| 5 Timing log, event fields, stop-step timing | A | none | `src/core/timing.ts` (new), `src/core/events.ts`, `src/checks/stop/gate.ts` |
| 6 Gate metrics | A | 3, 5 | `src/report/metrics/gates.ts` (new) |
| 7 Judgement-rule windows | A | 3 | `src/report/windows.ts` (new) |
| 8 HTML and SVG | A | 3, 4, 6, 7 | `src/report/html.ts`, `src/report/svg.ts` (new) |
| 9 Export with allowlist | A | 8 | `src/report/export.ts` (new) |
| 10 Report command, unrouted | A | 1–9 | `src/cli/report.ts` (new) |
| 11 Attack suite | A | none | `test/attacks/*` (new) only |
| 12 Doctor branch-protection note | A | none | `src/cli/doctor.ts` |
| 13 Lint rule table and proposal | A | none | `src/rules/table.ts`, `src/rules/propose.ts` (new) |
| 14 Violation counts | A | 13 | `src/rules/count.ts` (new) |
| 15 Eval plugin builder and case templates | A | none; the gates kind waits for the P0 rerun | `src/eval/build.ts` (new), `templates/evals/**` (new) |
| 16 Eval runner and result import | A | 15, 8 | `src/eval/run.ts`, `src/cli/eval.ts`, `src/report/evals.ts` (new); `src/report/html.ts` (its own section) |
| 17 Dispatcher hookup: `use`, `ms`, timing | B | 5, L1, **PR-size 8** | `src/hooks/dispatch.ts`, `src/hooks/types.ts` |
| 18 Route `report` and `eval`; README | B | 10, 16, **preset 1b** | `src/cli/index.ts`, `README.md`, `docs/reference.md`, `test/package/readme.test.ts` |
| 19 Rule coverage matrix | B | 8, 10, **preset 3** | `src/report/rules.ts` (new), `src/report/html.ts`, `src/cli/report.ts` |
| 20 Guard: `report` ask, `eval` deny | C | 18, **preset 11**, **PR-size 5** | `src/checks/guard.ts`, `src/cli/report.ts` |
| 21 `.harness/reports/` in `mergeGitignore` | C | 10, **preset 5**, **PR-size 7** | `src/install/merge.ts`, `src/cli/report.ts` |
| 22 `harness rules`: ESLint apply | C | 13, 14, **preset 5**, **preset 14** | `src/install/merge.ts`, `src/cli/rules.ts` (new), `src/cli/index.ts`, `src/cli/uninstall.ts` (only if Step 1 shows it's needed) |
| 23 `harness rules`: TS options apply | C | 22 | `src/install/merge.ts`, `src/cli/uninstall.ts`, `src/cli/rules.ts` |

- Lane A tasks with no shared file run in parallel: 1, 2, 5, 11, 12, 13 and 15 can all start today. Task 3 waits for 2, and 8 waits for 3, 4, 6 and 7, which only *create* files.
- **Task 17** waits for PR-size Task 8, the last PR-size task that edits `dispatch.ts`.
- **Task 18** waits for preset Task 1b, the first preset edit to `index.ts`. Preset Tasks 11, 13 and 14 edit only `index.ts`'s USAGE line after that: rebase.
- **Task 19** needs the `preset` config key (preset Task 3).
- **Lane C** waits for the preset's `merge.ts` work (preset 5) and the last `guard.ts` edits (preset 11, PR-size 5). Task 22 also waits for preset 14, the last `index.ts` edit.
- **Merges stay serial.** Every branch rebases on `main` before it starts and before it merges. `docs/reference.md` is shared with both plans, so the docs step comes last in each task.

## Planning checks, run 2026-11-05

1. **`claude plugin eval --help` (local, no model call)** confirms these flags:
   - `--ablation none|with-without`. The default is `with-without` whenever a plugin resolves, so harness always passes `--ablation none`.
   - `--runs <n>`, `--model <model>` (O7), `--judge-model` (default haiku; unused, free graders only).
   - `--max-cost-usd <usd>`: "checked before each run launches, so overrun is bounded to the runs in flight (one, or up to `--concurrency`)". `--concurrency` defaults to 1.
   - `--json [path]`, which includes "per-run scores". So pass^k (spec §7.3) is available.
   - `--report <path>`, `--output-dir <dir>`.
   - **`--no-publish`.** The HTML report is published to claude.ai by default "when your account supports it". Harness always passes `--no-publish` (U17: nothing leaves the machine).
   - **`--scaffold`.** `scaffold_script` is off by default, and the gates cases need it.
   - **`--allow-tools <tools...>`.** Bash, Write and Edit are gated; the rules and gates cases need them.
   - **`--trust-plugin`.** It skips the first-run trust prompt. Harness passes it only for the eval plugin it just built in its own temp folder.
2. **Case layout.** `claude plugin eval init --bare <name>` (local, no model call) writes `evals/<name>/prompt.md` with frontmatter `max_turns: 10` and `allowed_tools: [Read, Glob, Grep, Skill]`, and `graders/criteria.md` with frontmatter `type: llm`, `weight: 1`. The frontmatter keys of the free graders (`tool_used`, `regex`, `tool_order`, `file_exists`) and the `case.yaml` key `execution.append_system_prompt` come from the plugin-evals docs page (AR §2.4), not checked locally. Task 15 Step 1 reads that page and pins them.
3. **`CLAUDE_CONFIG_DIR`.** The preset plan treats it as Claude Code's config root ("Global limits"). This plan uses `$CLAUDE_CONFIG_DIR/projects` when the variable is set, else `~/.claude/projects` (spec §3.1).
4. **ESLint rule names marked UNVERIFIED in §5.2.** These aren't guessed at build time. Task 14 runs the repo's own ESLint. A rule its installed plugin doesn't define is dropped and listed as "not in your installed `<plugin>`".

## Planning steps that need the owner (not tasks)

- **P0, paid probe (O8). Don't run without the owner's explicit OK.**
  - What: one gates case in a temp plugin. A `PreToolUse` command hook writes a marker file and denies a `Read` of the scaffolded secrets file; the prompt asks to read that file.
  - Command shape: `claude plugin eval <tmp> --ablation none --runs 1 --model <owner's pick> --max-cost-usd 0.50 --scaffold --trust-plugin --no-publish --json <tmp>/result.json`, with `max_turns: 3` in `prompt.md`.
  - **Cost estimate (not measured).** One run, at most 3 turns. Assume about 30k input tokens per turn (UNVERIFIED: a Claude Code session's system prompt and tools) and under 1k output in total. That is about 90k input tokens:
    - Claude Haiku 4.5 at $1 / $5 per MTok: about $0.10;
    - Claude Sonnet 5.5 at $2 / $10 per MTok: about $0.19;
    - prices from the pricing table in JF §4.
  - The `--max-cost-usd 0.50` ceiling is checked before a run launches, so it can't stop a single run. `max_turns: 3` and the CLI's own timeout bound it.
  - Result:
    - The marker exists and the deny shows: gates stay in Task 15.
    - Otherwise Task 15 ships no gates kind, and the spec's §7.2 gets a one-line update in Task 15's PR.
  - **Run of 2026-11-05 (owner-approved, Haiku): no result.** Exit 2, `partialReason: "auth_failed"` (`Not logged in · Please run /login`), `costUsd: 0`. The agent run never started, and the marker file wasn't written. The CLI in the agent's environment isn't logged in (Claude Code 2.1.285, `claude auth status`: `loggedIn: false`). Details are in spec §7.6.
  - **Status: gate evals pending.** The docs say plugin hooks load in eval runs, but nothing has proved it yet. Task 15 builds the skills and rules kinds now; the gates kind waits for the rerun.
  - **Rerun (owner, in a logged-in terminal):** `cd /private/tmp/claude-502/-Users-khubaib-work-Documents/7f1150f4-e779-4eb2-82ea-54c67cd14c3f/scratchpad/p0 && rm -rf out marker.jsonl && mkdir out && claude plugin eval plugin --ablation none --runs 1 --model haiku --max-cost-usd 0.50 --scaffold --trust-plugin --no-publish --json out/result.json --report out/report.html --output-dir out`. Evidence: `marker.jsonl` exists with `"ran":true`, and `out/result.json` has the `deny-shown` grader passed. Cost: `costUsd` in `out/result.json`.
- **L1, live check for `tool_use_id` (spec §3.3).** Not paid beyond normal plan use, but it is a live Claude Code run, so it needs the owner's OK.
  - In a scratch repo, add a `PreToolUse` command hook that writes its stdin keys (not values) to a file, then run one Read.
  - If `tool_use_id` is present, Task 17 writes `use`. If not, Task 17 skips `use`, and Task 6's signals stay "fuzzy match" only.
  - **2026-11-05: not run.** It was approved, but `claude -p` can't run in the agent's environment for the same reason as P0 (CLI not logged in; Claude Code 2.1.285). So `tool_use_id` is still UNVERIFIED, and **Task 17 stays blocked**. Everything else in lane A is unaffected.
  - **Ready to run (owner, in a logged-in terminal):** the repo is `/private/tmp/claude-502/-Users-khubaib-work-Documents/7f1150f4-e779-4eb2-82ea-54c67cd14c3f/scratchpad/l1` (git repo, one commit). Its `.claude/settings.json` has a `PreToolUse` hook (`Read|Bash`) that appends only field names, the type of `tool_use_id` and its first 6 characters to `hook-keys.jsonl`. Command: `cd /private/tmp/claude-502/-Users-khubaib-work-Documents/7f1150f4-e779-4eb2-82ea-54c67cd14c3f/scratchpad/l1 && claude -p "Read hello.txt, then run the command: echo done" --max-turns 3 --model haiku --allowedTools Read "Bash(echo:*)" && cat hook-keys.jsonl`. Claude Code may ask to trust the folder first.

## Plan decisions the spec leaves open (the owner can change them in review)

- **Branches:** `feature/report-<n>-<slug>`, one per task.
- **Names.**
  - The new streaming reader is `streamTranscript`, so it can't be confused with `multi-file.ts`'s private `readTranscript`, which stays as it is.
  - The rule ids are `ask-first`, `no-invented-data`, `fix-everything`, `small-prs`, `readme-per-pr`, `paid-ok`, `tdd`, `lean-context`, `plain-communication`, `no-ai-trailer`, `branch-prefix`.
- **Report file name** uses the local date (`YYYY-MM-DD`), so two runs on one day overwrite. Window math uses epoch ms from transcript `timestamp`s.
- **Stop-step timing** goes to the timing log (`step` field), not to `events.jsonl`. So `harness stats` output stays the same (spec §10).
- **Plain-communication sentences.** Fenced code blocks and list lines are dropped first. Sentences split on `/[.!?]+(\s|$)/`, words on `/\s+/`.
- **Model ids in the export.** An id that doesn't match `^claude-[a-z0-9.-]+$` (Claude Code also writes values such as `<synthetic>`) is counted under `other` *before* the allowlist check, so it can't block every export (Review focus 3).
- **No ESLint flat config.** When the repo has a legacy `.eslintrc*`, or no `eslint.config.*` at all, `harness rules --apply` refuses and prints the manual steps. It never creates an ESLint config the repo didn't have (Review focus 4).
- **Enums.** `no-restricted-syntax` on `TSEnumDeclaration`, not `erasableSyntaxOnly` (its TS 7 support is UNVERIFIED).
- **Recommended sets** (`jsx-a11y`, `react-native-a11y`). The generated file spreads `plugin.configs['flat/recommended'] ?? plugin.configs.recommended`, with a `ponytail:` comment naming that guess.
- **TS option counts.** One `tsc --noEmit` baseline run, then one run per option, each against a temp `tsconfig` under `.harness/state/` that `extends` the repo's. Count = errors minus baseline. Each run has a 120 s timeout. A timeout shows that option as unknown.
- **Eval cases** ship only for skills whose names harness knows: its own (`review-rubric`) and the preset's four. Any other own skill is listed as "no eval cases".

## Global constraints

- User-facing name: **usage and adherence report**. `README.md` and `docs/reference.md` never contain "telemetry" (`test/package/readme.test.ts`).
- The README says: **"start Claude Code inside the repo for the report to see it"** (O1).
- `harness report [--days N] [--open] [--export]`, default `--days 14` (U10). Writes `.harness/reports/<YYYY-MM-DD>.html` and, with `--export`, `<YYYY-MM-DD>-export.json`. Terminal output: at most 8 lines, counts only, never quoted text (§6.1).
- **Repo match is strict (O1).** A session counts only if its start `cwd` is inside the repo root or a worktree. A parent-folder session is never counted.
- **Reading caps.** A line over 16 MB is skipped and counted. Window parts are cut to 600 characters. At most 50 windows per rule. A rate with n under 5 is shown as counts only.
- **Timing log.** `.harness/logs/timing.jsonl`, rotated to `timing.1.jsonl` at 5 MB, one old file kept (O3).
- **HTML.** No `<script>` and no external request. The CSP meta is exactly `default-src 'none'; style-src 'unsafe-inline'; img-src data:`. Every chart has a table.
- **Export** carries harness and catalog ids only, everything else as `other` (O9). No paths, quotes, repo name, branch names, session ids, or times finer than the ISO week. The allowlist check runs in code.
- **Lint settings are `error` from day one (O4).** The preview shows per-rule violation counts and the stop-gate warning before the yes.
- **Size numbers (O10):**
  - `max-lines` 300 with `skipBlankLines: true, skipComments: true`;
  - `max-lines-per-function` 50 with `skipBlankLines: true, skipComments: true`;
  - `max-depth` 4; `max-params` 4; `complexity` 20;
  - `@typescript-eslint/no-magic-numbers` with `ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreEnums: true`.
- **Evals.**
  - Default `--max-cost-usd 2`; the model is pinned per run (O7).
  - Always `--ablation none --no-publish`, free graders only.
  - The command refuses when not a TTY, when `CLAUDECODE` is set, or when `CI` is `true` or `1`. The person types `yes` before each run.
- **Tests.**
  - TDD: red first.
  - `pnpm test` passes with `claude` off PATH. `claude`, `gh`, `git`, `eslint` and `tsc` are faked through `Exec`-style seams or a fake binary on a temp `PATH`.
  - No paid or live Claude run, no network in tests.
  - **Synthetic transcripts only.** No real transcript, path, name or email in any fixture (Task 2 scans for them).
- **Process.**
  - One PR per task, at or under 400 changed lines and 20 files. A PR that grows past that is split before review.
  - Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit …`, with no AI trailer and no footer.
  - Each PR checks `README.md` and `docs/reference.md`, and its body says "updated (…)" or "checked, no change" for each.
- **Gates:** `pnpm typecheck` and `pnpm test` pass at the end of every task. `test/perf/latency.test.ts` passes after Tasks 5 and 17.

## Review focus

1. **A transcript being written right now.** The live session's file ends in a half-written line. Expected: that line counts as `bad`, the rest is read, nothing throws (Task 2 test).
2. **Symlinked or case-folded repo paths.** On macOS `/tmp` is `/private/tmp`, and the file system is case-insensitive. The folder name encodes the path as the session saw it. Expected: both the raw and the realpath forms of the root are tried, and `cwd` comparison is case-insensitive on `darwin` and `win32` (Task 1 test).
3. **An unexpected model id blocks every export.** `<synthetic>` or a new model naming scheme. Expected: counted under `other`, and the export still writes (Task 9 test).
4. **`harness rules` on a repo with a legacy `.eslintrc.json`, or no ESLint at all.** Expected: no file is written; the output lists manual steps and the missing packages (Task 22 test).
5. **Two sessions' hooks rotating the timing log at once.** Expected: a lost line at most; no throw, no partial line, and the hook's decision is unchanged (Task 5 test with a rename race simulated through an `fs` seam).

---

### Task 1: Locate this repo's sessions

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/report/locate.ts`
- Test: `test/report/locate.test.ts`

**Interfaces:**
- Produces:
  - `export type GitRun = (args: string[]) => { status: number | null; stdout: string }` (same shape as `dispatch.ts`'s)
  - `export interface SessionFile { session: string; main: string; subagents: string[]; mtimeMs: number }`
  - `export type SkipReason = 'outside-repo' | 'unsafe-id' | 'symlink' | 'older-than-window' | 'no-cwd' | 'unreadable'`
  - `export interface Located { projectsDir: string; sessions: SessionFile[]; skipped: Partial<Record<SkipReason, number>> }`
  - `export function projectsDir(env: NodeJS.ProcessEnv, home: string): string`
  - `export const encodeProjectDir = (p: string): string` (every character outside `[A-Za-z0-9]` → `-`)
  - `export function repoPaths(root: string, git: GitRun): string[]` (root and each `git worktree list --porcelain` path, each in raw and realpath form, deduped)
  - `export function insideRepo(cwd: string, paths: string[], platform: NodeJS.Platform): boolean`
  - `export async function locateSessions(root: string, opts: { env: NodeJS.ProcessEnv; home: string; sinceMs: number; git: GitRun; platform?: NodeJS.Platform }): Promise<Located>`
- A candidate folder's name is `enc(p)`, or starts with `enc(p) + '-'`. For each `<id>.jsonl` the function reads lines only until the first record with a string `cwd`, at most 64 lines or 1 MB. That is the only read of a session outside the repo.

- [ ] **Step 1: Write the failing tests** (a temp `home` with fake project folders, built with Task 2's builder if merged, else literal JSON lines):
  - `projectsDir({ CLAUDE_CONFIG_DIR: '/x' }, '/h')` is `/x/projects`, and `projectsDir({}, '/h')` is `/h/.claude/projects`.
  - `encodeProjectDir('/private/tmp/a-b/.c')` is `-private-tmp-a-b--c`.
  - A session in `enc(root)` with `cwd` = root is found. One in `enc(root)-src` with `cwd` = `root/src` is found.
  - `enc('/a/harness-old')` with `cwd` `/a/harness-old` is skipped as `outside-repo` when root is `/a/harness`.
  - **O1:** a session in `enc(parent)` whose `cwd` is the parent, even with Edit `file_path`s inside the repo, is not found and isn't counted as skipped. The folder is never a candidate.
  - Subagents: `<id>/subagents/agent-a1.jsonl` is listed in `subagents`. `*.meta.json`, `*.prefix.json` and `custom-title.json` are ignored.
  - A file name `../x.jsonl` or `a b.jsonl` → `unsafe-id`. A symlinked `.jsonl` → `symlink`. A file with mtime before `sinceMs` → `older-than-window`, and the test asserts it isn't opened (read spy). No `cwd` in the first 64 lines → `no-cwd`.
  - **Review focus 2:** a root given as `/tmp/r` (a symlink to `/private/tmp/r`) finds sessions in both `enc('/tmp/r')` and `enc('/private/tmp/r')`. On `platform: 'darwin'`, `cwd` `/Users/X/Repo` matches root `/Users/x/repo`. On `linux` it doesn't.
  - A worktree path from a fake `git worktree list --porcelain` is matched.
- [ ] **Step 2: Run and confirm they fail.** `pnpm vitest run --project unit test/report/locate.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the interfaces. Use `isSafeSessionId` (`src/core/state.ts`) for ids and `lstatSync` for symlinks.
- [ ] **Step 4: Run and confirm they pass.** Then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change (not user-visible yet).
- [ ] **Step 6: Commit.** `feat(report): locate this repo's session transcripts`.

### Task 2: Streaming transcript reader and synthetic fixtures

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/report/transcript.ts`, `test/fixtures/transcripts/make.ts`
- Test: `test/report/transcript.test.ts`, `test/report/fixtures-clean.test.ts`, `test/perf/report.test.ts`

**Interfaces:**
- Produces (`src/report/transcript.ts`):
  - `export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number }`
  - `export interface ToolUse { id: string; name: string; skill?: string; filePath?: string; command?: string; ask?: { options: number; recommended: boolean } }`
  - `export type TRec = Base & ( { k: 'assistant'; key: string | null; model?: string; usage?: Usage; texts: string[]; tools: ToolUse[] } | { k: 'prompt'; text: string } | { k: 'result'; useId: string; isError: boolean; chars: number; text: string; permission?: { decision: string; source: string } } | { k: 'listing'; names: string[] } | { k: 'invoked'; names: string[] } | { k: 'instructions'; paths: string[]; reason: string | null } | { k: 'hook'; event: string; command: string; ms: number | null; timedOut: boolean; useId?: string } | { k: 'compact' } | { k: 'stop'; prevented: boolean | null } | { k: 'other'; type: string } | { k: 'bad'; why: 'json' | 'too-long' | 'shape' } )`
  - `Base = { ts: number; side: boolean; version?: string; cwd?: string }`. `ts` is `NaN` when `timestamp` is missing.
  - `key` is `message.id + '|' + requestId`, or null when either is missing.
  - `result.text` keeps at most 64 KB (estimate) for number matching; `chars` is the full length.
  - `export const MAX_LINE = 16 * 1024 * 1024`
  - `export const TESTED = { min: '2.1.286', max: '2.1.317' }`
  - `export function parseLine(line: string): TRec`
  - `export interface ReadStats { lines: number; bad: number; tooLong: number; versions: Set<string>; types: Record<string, number> }`
  - `export async function streamTranscript(path: string, visit: (r: TRec) => void, opts?: { sinceMs?: number; side?: boolean }): Promise<ReadStats>`
- The mapping from raw fields to `TRec` is spec §3.2's table. `side` is the record's `isSidechain`, or `true` for subagent files.
- Records whose `type` no metric uses (`queue-operation`, `file-history-snapshot`, `last-prompt`, `custom-title`, `agent-name`, `atis-latch`, `cost-state`, `mode`, `pr-link`) become `other` from a substring match on `"type":"<x>"`, with no `JSON.parse`.
- Lines longer than `MAX_LINE` are dropped without buffering the rest: read in chunks, discard to the next `\n`.
- Produces (`test/fixtures/transcripts/make.ts`): `assistant(o)`, `prompt(text, o?)`, `toolResult(useId, o?)`, `attachment(type, fields, o?)`, `system(subtype, fields?, o?)`, `writeSession(dir, id, recs, opts?: { subagents?: Record<string, object[]> }): string`. Defaults: `version: '2.1.317'`, `cwd: '/repo'`, `sessionId` = id, increasing ISO timestamps.

- [ ] **Step 1: Write the failing tests:**
  - Each spec §3.2 row maps to its `TRec`: `Skill` with `input.skill` gives `tools[0].skill`; Edit gives `filePath`; Bash gives `command`.
  - `AskUserQuestion` with 3 options, one labelled `Use X (Recommended)`, gives `ask: { options: 3, recommended: true }`.
  - A user record with string content is `prompt`. One with only `tool_result` blocks is `result`, with `permission` from `permissionDecision`.
  - `instructions` gives `reason: 'compaction'`. `hook_success` gives `ms` from `durationMs`, and `hook_cancelled` gives `timedOut: true`.
  - **Unknown, not pass:** `usage` with a string `input_tokens` gives `usage: undefined`; a missing `content` gives `texts: []`; neither throws.
  - Malformed JSON gives `bad`/`json`. A 17 MB line gives `bad`/`too-long`, and the next line still parses.
  - **Review focus 1:** a file whose last line is half a record gives `bad: 1` and all earlier records.
  - `versions` collects `2.1.317` and `2.1.400`.
  - `sinceMs` drops older records.
  - `fixtures-clean.test.ts`: every file under `test/fixtures/transcripts/` and every builder default has no `/Users/`, `/home/`, `C:\\Users`, email-shaped string or `sk-` key.
  - `test/perf/report.test.ts` (perf project): `streamTranscript` over a generated 100 MB file runs under 5000 ms. The 100 MB time over the 10 MB time stays under 8 (the `vet-scan.test.ts` pattern). RSS growth stays under 256 MB.
- [ ] **Step 2: Run and confirm they fail.** `pnpm vitest run --project unit test/report/transcript.test.ts test/report/fixtures-clean.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm test:perf -- test/perf/report.test.ts`, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): streaming transcript reader and synthetic fixtures`.

### Task 3: Turns, accumulators and usage metrics

**Lane A. Depends on:** 2.

**Files:**
- Create: `src/report/acc.ts`, `src/report/turns.ts`, `src/report/metrics/usage.ts`
- Test: `test/report/turns.test.ts`, `test/report/usage.test.ts`

**Interfaces:**
- Consumes: `TRec`, `Usage`, `ToolUse` (2).
- Produces (`acc.ts`):
  - `export type Bucket = '1-10' | '11-30' | '31-100' | '100+'`
  - `export const bucketOf = (turn: number): Bucket`
  - `export interface SessionCtx { id: string; turns: number; compactions: number; edited: string[] }`
  - `export interface Acc<R> { rec?(s: SessionCtx, r: TRec): void; turn?(s: SessionCtx, t: Turn): void; endSession?(s: SessionCtx): void; result(): R }`
- Produces (`turns.ts`):
  - `export interface Turn { index: number; prompt: string; texts: string[]; tools: ToolUse[]; results: Map<string, Extract<TRec, { k: 'result' }>>; afterCompact: boolean; date: string }`
  - `export function turnSplitter(onTurn: (t: Turn) => void): { push(r: TRec): void; end(): void }` (a turn runs from a `prompt` to the next `prompt`; subagent records join the open turn)
  - `export async function runSession(files: { main: string; subagents: string[] }, id: string, accs: Acc<unknown>[], sinceMs: number): Promise<ReadStats>`
- Produces (`metrics/usage.ts`):
  - `export interface UsageResult { total: Usage; main: Usage; sub: Usage; byDay: Record<string, Usage>; byModel: Record<string, Usage>; sessions: { id: string; usage: Usage; responses: number; compactions: number; peak: number }[]; responses: number; unknown: number; loads: { sessions: number; agentsMd: number; claudeMd: number; unknown: number; compactions: number; reloaded: number }; toolChars: Record<string, number> }`
  - `export function usageAcc(): Acc<UsageResult>`
  - `export function alwaysLoaded(root: string, dirs: { templates: string; plugin: string }): { id: string; tokens: number | null }[]`. This is the `measureSelectionSync` call `status.ts:96` makes, plus `estimateTokens` of `AGENTS.md` and `CLAUDE.md` as two more rows. It reads `measure.ts`; it doesn't edit it.

- [ ] **Step 1: Write the failing tests:**
  - Two assistant records with the same `key` count once. A record with `key: null` counts and adds 1 to `unknown`.
  - Cache reads and writes are never added into `input`: a fixture with `input 10, cacheWrite 100, cacheRead 1000, output 5` gives exactly those four numbers.
  - `peak` is the max per response of input + cacheWrite + cacheRead.
  - Subagent usage goes to `sub`.
  - `loads`:
    - an `instructions` record whose path ends in `AGENTS.md` counts the session;
    - a session with no `instructions` record is `unknown`;
    - a `compact` followed by `instructions` with `reason: 'compaction'` counts as `reloaded`.
  - `toolChars` sums `result.chars` by the name of the `tool_use` with that id.
  - `bucketOf(10)` is `'1-10'`, and `bucketOf(101)` is `'100+'`.
  - The turn splitter puts a tool result into the turn of its tool use, and sets `afterCompact` after a `compact`.
- [ ] **Step 2: Run and confirm they fail.** `pnpm vitest run --project unit test/report/turns.test.ts test/report/usage.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): turns, accumulators and token usage`.

### Task 4: Skills metric

**Lane A. Depends on:** 3.

**Files:**
- Create: `src/report/metrics/skills.ts`
- Test: `test/report/skills.test.ts`

**Interfaces:**
- Consumes: `Acc`, `SessionCtx`, `Turn`, `bucketOf` (3); `detect` (`src/install/detect.ts`, read-only use); `isAnyTestFile` (`src/core/paths.ts`).
- Produces:
  - `export interface SkillSpec { name: string; relevant: ((paths: string[]) => boolean) | null; label: 'paths' | 'proxy' | 'stack' | 'none' }`
  - `export function installedSkills(root: string): { name: string; paths?: string[] }[]` (reads `.claude/skills/*/SKILL.md` frontmatter)
  - `export function skillSpecs(root: string, installed: { name: string; paths?: string[] }[], packages: { dir: string; frameworks: string[] }[], selected: { id: string; frameworks: string[] }[]): SkillSpec[]`. The rules are spec §4.1's table. A plugin skill `p:s` gets the `stack` label when `p` is a selected catalog id with `applies_when.frameworks`.
  - `export interface SkillRow { name: string; label: SkillSpec['label']; installed: boolean; listedIn: number; relevantIn: number; invokedRelevant: number; invokedOther: number; typedOrCarried: number; sessions: number; dropped: boolean; byBucket: Record<Bucket, { r: number; i: number }>; byCompact: { pre: { r: number; i: number }; post: { r: number; i: number } } }`
  - `export function skillsAcc(specs: SkillSpec[]): Acc<SkillRow[]>`

- [ ] **Step 1: Write the failing tests:**
  - A skill with `paths: ['src/**/*.tsx']` is relevant in a session that edited `src/a.tsx` and not in one that edited `src/a.ts`.
  - `engineering-principles` is relevant after an edit to `src/x.ts`, and not after an edit to `src/x.test.ts` alone.
  - `frontend-nextjs` is relevant only under `app/`, `pages/`, `src/app/` or `src/pages/` of a package listing `next`.
  - An installed skill missing from a session's `listing` names gives `dropped: true`.
  - An invocation through `invoked` only counts in `typedOrCarried`, not `invokedRelevant`.
  - A skill with 0 relevant sessions gives `relevantIn: 0` (the HTML shows "no relevant sessions", Task 8).
  - Bucket and pre/post-compaction splits.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): skills listed, relevant and invoked`.

### Task 5: Timing log, event fields and stop-step timing

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/core/timing.ts`
- Modify: `src/core/events.ts` (two optional fields), `src/checks/stop/gate.ts` (one timing line per step run)
- Test: `test/core/timing.test.ts`, `test/checks/stop/gate.test.ts` (add cases), `test/cli/stats.test.ts` (unchanged, must pass)

**Interfaces:**
- Produces:
  - in `events.ts`, `HarnessEvent` gains `use?: string; ms?: number`;
  - in `timing.ts` (imports only `node:fs` and `node:path`, so the hook bundle stays small):
    - `export interface TimingLine { ts: string; session: string; event: string; tool?: string; step?: string; outcome: 'allow' | 'deny' | 'ask' | 'block' | 'context'; ms: number }`
    - `export const TIMING_REL = '.harness/logs/timing.jsonl'`
    - `export const TIMING_MAX_BYTES = 5 * 1024 * 1024`
    - `export function appendTiming(root: string, t: TimingLine, fs?: TimingFs): void`. It never throws; failures go to stderr as `harness: timing log failed: …`.
    - `export function readTiming(root: string): TimingLine[]` (`timing.1.jsonl` first, then the current file; malformed lines skipped)
- In `gate.ts`, after each step finishes, append `{ event: 'Stop', step: <label>, outcome: passed ? 'allow' : 'block', ms }`. Nothing else in the gate changes.

- [ ] **Step 1: Write the failing tests:**
  - An append to a missing file creates `.harness/logs/` and one line.
  - At `TIMING_MAX_BYTES + 1` the file is renamed to `timing.1.jsonl` (replacing an old one) before the append.
  - `readTiming` returns old lines first.
  - A line holds no key outside `TimingLine`.
  - **Review focus 5:** with an `fs` seam whose `renameSync` throws `ENOENT` (another process rotated first), `appendTiming` still appends or gives up silently, never throws, and never writes a partial line.
  - Stop gate: a run with steps `lint` (pass) and `test` (fail) writes two timing lines with `step` and the right `outcome`. `events.jsonl` gets exactly the lines it got before.
  - `stats` output is unchanged for an events file with `use` and `ms` fields.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass.** Then `pnpm typecheck` and `pnpm test:perf -- test/perf/latency.test.ts` (the stop gate isn't in the latency path, but the bundle grew).
- [ ] **Step 5: Docs.** `docs/reference.md`: one line under the logs it lists, naming `.harness/logs/timing.jsonl` and its 5 MB rotation. README: checked, no change.
- [ ] **Step 6: Commit.** `feat(report): timing log and stop-step timing`.

### Task 6: Gate metrics

**Lane A. Depends on:** 3, 5.

**Files:**
- Create: `src/report/metrics/gates.ts`
- Test: `test/report/gates.test.ts`

**Interfaces:**
- Consumes: `readEvents`, `HarnessEvent` (`src/core/events.ts`); `readTiming`, `TimingLine` (5); `Acc`, `Turn` (3).
- Produces:
  - `export type Signal = 'ask-approved' | 'deny-retry' | 'stop-flake' | 'gave-up' | 'override'`
  - `export interface FalseBlock { signal: Signal; check: string; session: string; date: string; turn?: number; fuzzy: boolean; step?: string; quote?: string }` (`quote` only for `deny-retry`, cut to 600 characters)
  - `export interface LatencyRow { source: 'timing' | 'transcript' | 'events'; event: string; outcome?: string; n: number; p50: number; p95: number; max: number; timeouts: number }`
  - `export interface GatesResult { tally: Record<string, number>; overrides: Record<string, number>; falseBlocks: FalseBlock[]; latency: LatencyRow[]; stopSteps: { step: string; runs: number; blocks: number; flakes: number; p50: number | null; p95: number | null }[]; hallucination: { typecheckBlocks: number; testBlocks: number; registryChecks: number; registryDenies: number } }`
  - `export function gatesAcc(events: HarnessEvent[], timing: TimingLine[], sinceMs: number): Acc<GatesResult>`
- `tally` and `overrides` use the same keys as `stats` in `src/cli/index.ts`. They are re-implemented here, because `index.ts` belongs to the preset lane; `stats` itself is not changed.
- The signals are spec §4.4's table. The fuzzy join window is 2000 ms. `stop-flake` means a harness stop `block` event, then the session's next `stop` record with no stop `block` event within 2000 ms of it and no Edit, Write, MultiEdit or NotebookEdit tool use between them.
- Transcript latency counts only `hook` records whose `command` contains `.harness/hooks/dispatch.mjs`.

- [ ] **Step 1: Write the failing tests:**
  - An `ask` event with `use: 'toolu_1'` plus a `result` for `toolu_1` with `permission: { decision: 'accept', source: 'user_temporary' }` gives one `ask-approved`, `fuzzy: false`.
  - The same without `use`, with timestamps 500 ms apart, gives `fuzzy: true`. 3000 ms apart gives none.
  - A `deny` for Edit `a.ts`, then an Edit `a.ts` in the same turn with no event, gives `deny-retry` with a quote.
  - Stop flake: block, then a stop with no edit between, gives `flakes: 1` for the step parsed from `reason` (the `stats` parsing: `"<step> failed (attempt"` or `coverage`). With an Edit between, it gives none.
  - `stop-gave-up` gives `gave-up`. `tdd paused`, `multi-file approved`, `allow-log`, and `harness-files-changed` naming `.harness/config.yaml`, give `override`.
  - Latency: timing lines with ms `[1..100]` give p50 50 and p95 95 (nearest-rank). A transcript hook record from another plugin is ignored.
  - Hallucination: stop blocks with reason `typecheck failed (attempt 1…` count in `typecheckBlocks`, and `dep-verify` events in `registry*`.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): gate counts, probable false blocks and latency`.

### Task 7: Judgement-rule windows

**Lane A. Depends on:** 3.

**Files:**
- Create: `src/report/windows.ts`
- Test: `test/report/windows.test.ts`

**Interfaces:**
- Consumes: `Acc`, `Turn`, `SessionCtx`, `bucketOf` (3).
- Produces:
  - `export type WindowRule = 'ask-first' | 'no-invented-data' | 'fix-everything' | 'readme-per-pr' | 'paid-ok' | 'plain-communication' | 'tdd'`
  - `export const RX = { choice, number, estimateLabel, findingsHead, listLine, notFixed, paid, approval }`, each the exact regex text in spec §4.2, with the `i` flag (`listLine` also `m`).
  - `export interface Window { rule: WindowRule; session: string; date: string; turn: number; prompt: string; texts: string; tools: string[] }` (each string cut to 600 characters; `tools` as `Name (ok|error)`)
  - `export interface WindowsResult { byRule: Record<WindowRule, { windows: Window[]; total: number; counters: Record<string, number>; byBucket: Record<Bucket, { turns: number; windows: number }>; byCompact: { pre: { turns: number; windows: number }; post: { turns: number; windows: number } } }>; unknown: number }`
  - `export function windowsAcc(opts: { tddGateOn: boolean; cap?: number /* default 50 */ }): Acc<WindowsResult>`
- `readme-per-pr` is decided at `endSession`. `tdd` makes no windows when `tddGateOn`. The plain-communication thresholds are an average over 25 words, or more than 20% of sentences over 35 words. The sentence rules are in "Plan decisions".

- [ ] **Step 1: Write the failing tests.** One window that should open and one near miss per rule:
  - **ask-first:** "I'll go with option A" plus an Edit, no AskUserQuestion → window. The same with AskUserQuestion before the Edit → none. Counters: `asks`, `asksWith2Options`, `asksWithRecommendation`.
  - **no-invented-data:** "This cuts latency by 40%" with no tool result containing `40` → window. "about 40%" → none. "40%" present in a tool result → none.
  - **fix-everything:** "Found these issues:" plus 3 list lines, and a last text "I skipped the third" → window. The same with no skip word → none.
  - **readme-per-pr:** `gh pr create` plus an edit to `src/a.ts` and no `README.md` edit → window. With a README edit → none.
  - **paid-ok:** `git push` after the prompt "fix the test" → window. After "yes, push it" → none.
  - **plain-communication:** an average of 30 words → window. 10 words with a 200-word fenced code block → none.
  - **tdd:** `src/a.ts` edited before `src/a.test.ts` in one turn with `tddGateOn: false` → window; with `true` → none.
  - The cap: 60 matching turns give `windows.length === 50` and `total === 60`, newest first.
  - Window parts are at most 600 characters.
  - A turn with a `bad` record adds to `unknown` and makes no window.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): needs-a-look windows for judgement rules`.

### Task 8: HTML and SVG

**Lane A. Depends on:** 3, 4, 6, 7.

**Files:**
- Create: `src/report/html.ts`, `src/report/svg.ts`
- Test: `test/report/html.test.ts`

**Interfaces:**
- Consumes: `UsageResult` (3), `SkillRow` (4), `GatesResult` (6), `WindowsResult` (7); `HIDDEN_CLASS` (`src/core/config.ts`, read-only import).
- Produces:
  - `export interface ReportMeta { generated: string; days: number; harness: string; claudeVersions: string[]; untested: string[]; sessions: { scanned: number; skipped: Record<string, number>; unknown: number } }`
  - `export interface ReportData { meta: ReportMeta; usage: UsageResult; always: { id: string; tokens: number | null }[]; skills: SkillRow[]; windows: WindowsResult; gates: GatesResult; rules?: unknown /* Task 19 */; evals?: unknown /* Task 16 */ }`
  - `export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"`
  - `export const h = (s: string): string` (HTML escape, then hidden characters as `\uXXXX`)
  - `export function renderReport(d: ReportData): string`
  - `export const NO_SESSIONS = 'No sessions found for this repo. Start Claude Code inside the repo for the report to see it.'`
  - in `svg.ts`: `export function hbars(rows: { label: string; value: number; max: number; note?: string }[]): string`; `export function stackedBars(cols: { label: string; parts: number[] }[], legend: string[]): string`
- Layout: spec §6.2 sections 1 to 7 in order, with the banner text verbatim from §6.2. Colours are CSS variables with a `prefers-color-scheme: dark` block. A rate with n under 5 shows counts only.

- [ ] **Step 1: Write the failing tests:**
  - The output contains no `<script`, and no `http:` or `https:` outside the Method section's text.
  - It contains `<meta http-equiv="Content-Security-Policy" content="` + `CSP`.
  - A window holding `<script>alert(1)</script>`, `\u202e` and `\u200b` renders escaped (`&lt;script&gt;`, `\u202e`, `\u200b`).
  - Each `<svg` is followed by a `<table` with the same numbers.
  - A skill with `relevantIn: 0` shows `no relevant sessions`. A rate with n = 4 shows no `%`.
  - Zero scanned sessions shows `NO_SESSIONS`.
  - The tokens table shows four separate columns, uncached input, cache write, cache read and output, and the always-loaded rows are labelled `estimate, characters / 4`.
  - Optional `rules` and `evals` sections are absent when undefined.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): self-contained HTML report`.

### Task 9: Export with allowlist

**Lane A. Depends on:** 8.

**Files:**
- Create: `src/report/export.ts`
- Test: `test/report/export.test.ts`

**Interfaces:**
- Consumes: `ReportData` (8); `loadCatalog` (`src/catalog/load.ts`, for known ids).
- Produces:
  - `export interface Known { ids: Set<string> }` (harness's own skill, rule and check ids, plus catalog ids)
  - `export function buildExport(d: ReportData, known: Known): Record<string, unknown>` (schema `1`, shape as spec §6.4; any name not in `known.ids` and any model id not matching `^claude-[a-z0-9.-]+$` folds into `other`)
  - `export function exportProblems(x: unknown, known: Known): string[]` (walks every string: known id, `^\d+\.\d+\.\d+`, the model regex, ISO week `^\d{4}-W\d{2}$`, `other`, schema enums; anything else is one problem naming its JSON path, never its value)

- [ ] **Step 1: Write the failing tests:**
  - A `ReportData` holding a path, a quote, a branch name, a session id and a private skill `my-secret-skill` exports with none of those strings (searched in `JSON.stringify` of the result), and with `other` counting the private skill.
  - **Review focus 3:** a model id `<synthetic>` is counted under `other`, and `exportProblems` returns `[]`.
  - An injected string `/Users/x` in a hand-built object gives one problem naming its path, without the value.
  - Weekly buckets are ISO weeks only.
  - `generated_on` is a date with no time.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(report): counts-only export with an allowlist check`.

### Task 10: Report command, not routed yet

**Lane A. Depends on:** 1 to 9.

**Files:**
- Create: `src/cli/report.ts`
- Test: `test/cli/report.test.ts`

**Interfaces:**
- Consumes: everything from 1 to 9; `CliEnv` (type import from `src/cli/index.ts`; the file isn't edited); `insideClaude` (`src/cli/claude-only.ts`); `loadConfig`.
- Produces: `export async function report(args: string[], cli: CliEnv & { home?: string; git?: GitRun; now?: () => number; open?: (path: string) => void }): Promise<number>`

**Behaviour** (spec §6.1):
- Bad arguments exit 2, with the usage `harness report [--days N] [--open] [--export]`.
- With `CLAUDECODE` set, it refuses: `Run harness report in your own terminal for now.` (Task 20 swaps this for a guard ask.)
- It writes `.harness/reports/.gitignore` containing `*` when the file is missing (Task 21 drops this).
- It writes `<YYYY-MM-DD>.html` and, with `--export`, `<YYYY-MM-DD>-export.json`.
- Terminal output is at most 8 lines, counts only, ending with the path.
- `--open` calls `cli.open`. The default uses `spawn` with no shell: `open` on darwin, `xdg-open` on linux, `cmd /c start ""` on win32.
- When the folder can't be written, it exits 1.

- [ ] **Step 1: Write the failing tests** (temp repo, temp `home`, Task 2 fixtures):
  - With 2 sessions in the repo it exits 0, writes the HTML and the `.gitignore`, and prints at most 8 lines with no fixture text in them (the fixture prompt text is searched for and absent).
  - `--days 0`, `--days x` and `--bogus` exit 2.
  - `CLAUDECODE=1` gives the refusal and exit 1.
  - With no sessions it exits 0, and the output contains `Start Claude Code inside the repo`.
  - `--export` writes the JSON, and `exportProblems` on it is `[]`.
  - `--open` calls the seam with the HTML path.
  - A read-only `.harness/` exits 1.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change (the command is routed in Task 18).
- [ ] **Step 6: Commit.** `feat(report): harness report command`.

### Task 11: Attack suite

**Lane A. Depends on:** nothing. Test files only.

**Files:**
- Create: `test/attacks/run.ts`, `test/attacks/{guard,protect,config-change,sandbox-required,multi-file,red-first,test-lock,tamper}.cases.ts`, `test/attacks/attacks.test.ts`, `test/attacks/baseline.json`

**Interfaces:**
- Consumes: `dispatch`, `registry` (`src/hooks/dispatch.ts`, imported, not edited).
- Produces:
  - `export interface AttackCase { name: string; input: object; setup?: (root: string) => void; expect: 'blocked' | 'known-bypass'; why?: string /* required for known-bypass: the documented limit */ }`
  - `export async function runCase(c: AttackCase): Promise<'blocked' | 'passed'>`
  - Bypass rate per check = (known-bypass cases + unexpected passes) / cases.

- [ ] **Step 1: Write the cases and the test:**
  - Draft at least 8 cases per check, from that check's existing tests and the limits named in the specs (for example, the guard's wrapper and quoting forms; `protect` through `cp`, `mv`, `tee`, `sed -i`; `-F <file>` commit messages once the preset guard lands).
  - Each `known-bypass` names its spec limit in `why`.
  - `attacks.test.ts` fails when:
    - a `blocked` case passes, naming the case;
    - a check's rate is above `baseline.json`;
    - a `known-bypass` case has no `why`.
  - It prints the rates table.
  - `HARNESS_ATTACKS_WRITE=1` rewrites the baseline (used only when a PR fixes a bypass, and said so in its body).
- [ ] **Step 2: Run it.** Expected: green against the first baseline, written once with `HARNESS_ATTACKS_WRITE=1`. Any `blocked` case that passes today is a real bug: mark it `known-bypass` with `why: 'found by the attack suite; issue to fix'` and list it in the PR body. The fix comes in its own PR (guard fixes after the preset lane).
- [ ] **Step 3: Docs.** `docs/release-notes/<next>.md` gets a "Guard bypass rates" table from the test output. That line is added at release time; this PR adds only the instruction to `docs/reference.md`'s release checklist, if one exists, else checked, no change.
- [ ] **Step 4: Commit.** `test(attacks): attack suite with per-check bypass baseline`.

### Task 12: Doctor branch-protection note

**Lane A. Depends on:** nothing.

**Files:**
- Modify: `src/cli/doctor.ts` (`DoctorDeps` gains `gh?: (args: string[]) => { status: number | null; stdout: string }`)
- Test: `test/cli/doctor.test.ts`

**Interfaces:**
- Produces: `export function branchProtection(root: string, gh: DoctorDeps['gh']): { state: 'ok' | 'missing' | 'unknown'; detail: string }`
- Steps:
  1. `gh repo view --json nameWithOwner,defaultBranchRef`.
  2. `gh api repos/<o>/<r>/branches/<b>/protection`. A 404 → `missing`.
  3. Required checks are `required_status_checks.contexts` ∪ `required_status_checks.checks[].context`.
  4. CI jobs are those in `.github/workflows/*.y*ml` (parsed with `yaml`) with a step whose `run` contains `lint` or `test`; the job name is `name ?? key`.
  5. `ok` when at least one such job is required. No `gh`, no auth, or another error → `unknown`.
- Output uses doctor's existing `note` and `ok` lines, never `fix`, so the exit code doesn't change. 5 s timeout per `gh` call.

- [ ] **Step 1: Write the failing tests** with a fake `gh`:
  - Protected with `ci / test` required, and a workflow job `ci` → `name: test` running `pnpm test` → `ok …`.
  - A 404 → `note main is not protected: …require the CI checks…`.
  - Protected with no required checks → `note`.
  - `gh` missing → `note branch protection unknown (gh not available)`.
  - The exit code is unchanged in every case.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** `docs/reference.md`'s doctor section gets one line. README: checked.
- [ ] **Step 6: Commit.** `feat(doctor): note when the default branch isn't protected with CI checks`.

### Task 13: Lint rule table and proposal

**Lane A. Depends on:** nothing.

**Files:**
- Create: `src/rules/table.ts`, `src/rules/propose.ts`
- Test: `test/rules/propose.test.ts`

**Interfaces:**
- Produces (`table.ts`):
  - `export type Stack = 'ts' | 'react' | 'next' | 'rn'`
  - `export interface LintRule { id: string; plugin: string | null /* npm package, null for core */; importName?: string; stacks: Stack[]; setting: unknown /* full ESLint rule entry, 'error' first */; files?: 'rn' | 'next'; ignores?: string[]; antiPattern: string; recommendedSet?: true }`
  - `export const LINT_RULES: LintRule[]`: every §5.2 row that has a setting, with O10's numbers in §5.3's rows.
  - `export const NO_LINT: { antiPattern: string; note?: string }[]`: every §5.2 row marked "no lint equivalent".
  - `export const TS_OPTIONS: Record<string, true> = { strict: true, noUncheckedIndexedAccess: true, noImplicitOverride: true, noFallthroughCasesInSwitch: true, noImplicitReturns: true }`
- Produces (`propose.ts`):
  - `export interface Proposal { configText: string; rules: LintRule[]; missing: { rule: string; plugin: string }[]; ts: Record<string, true>; noLint: typeof NO_LINT }`
  - `export function propose(stacks: Set<Stack>, packages: { dir: string; frameworks: string[] }[], devDeps: Set<string>): Proposal`
- `configText` is the `.harness/eslint/harness.config.mjs` body:
  - one `import` per present plugin;
  - `languageOptions.parserOptions.projectService: true` when `ts`;
  - `files` globs per package for `rn` and `next` rules;
  - framework-file `ignores` for `import/no-default-export`: `**/page.tsx`, `**/layout.tsx`, `**/*.config.*`, `app/**/_layout.tsx`.
  - Every rule is set to `'error'` (O4).

- [ ] **Step 1: Write the failing tests:**
  - With stacks `{ts, react, next}` and all plugins present, the rule ids equal the expected list for those stacks: core, `@typescript-eslint/*`, `react/*`, `react-hooks/*`, `@next/next/*`, `tailwindcss/no-arbitrary-value`, `import/no-default-export`, `unicorn/filename-case`, `@eslint-community/eslint-comments/require-description`, `jsx-a11y` set.
  - The O10 values are exact:
    - `['error', { max: 300, skipBlankLines: true, skipComments: true }]` for `max-lines`;
    - `['error', { max: 50, skipBlankLines: true, skipComments: true }]` for `max-lines-per-function`;
    - `['error', 4]` for `max-depth`;
    - `['error', 4]` for `max-params`;
    - `['error', 20]` for `complexity`;
    - `['error', { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreEnums: true }]` for `@typescript-eslint/no-magic-numbers`.
  - Every entry starts with `'error'`.
  - A missing `eslint-plugin-unicorn` moves `unicorn/filename-case` to `missing` and leaves it out of `configText`.
  - RN rules carry `files` for the RN package only.
  - `configText` has no `RegExp` or `/.../` literal. `no-restricted-syntax` uses only the `TSEnumDeclaration` selector (O5).
  - `NO_LINT` has the §5.2 "no lint equivalent" rows.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(rules): lint rule table and proposal`.

### Task 14: Violation counts

**Lane A. Depends on:** 13.

**Files:**
- Create: `src/rules/count.ts`
- Test: `test/rules/count.test.ts`

**Interfaces:**
- Consumes: `Proposal` (13); `Exec` (`src/core/exec.ts`).
- Produces:
  - `export interface Counts { eslint: { byRule: Record<string, number>; dropped: { rule: string; plugin: string }[]; error?: string }; ts: { byOption: Record<string, number | null>; baseline: number | null } }`
  - `export async function countViolations(root: string, p: Proposal, exec: Exec, timeoutMs = 120_000): Promise<Counts>`
- Preview files go under `.harness/state/` (gitignored):
  - `rules-preview.mjs` imports the repo's `eslint.config.*` and the proposal, spread together;
  - `tsconfig.<option>.json` `extends` the repo's `tsconfig.json`.
- ESLint runs from `node_modules/.bin/eslint` with `--config <preview> --format json .`.
- A config error naming a rule (`/rule ["']([^"']+)["']/` on stderr) drops that rule into `dropped` and retries, at most 10 times.
- Preview files are deleted afterwards, even on failure.

- [ ] **Step 1: Write the failing tests** with a fake `exec`:
  - The JSON output counts two `max-depth` and one `react/no-array-index-key` messages.
  - A stderr naming `react-hooks/set-state-in-effect` drops it and retries once.
  - A timeout gives `error` and empty `byRule`, which the CLI prints as unknown.
  - TS: a baseline of 3 errors and `noUncheckedIndexedAccess` at 10 give 7. A timeout gives `null`.
  - Preview files are gone after both success and failure.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(rules): count existing violations per proposed rule`.

### Task 15: Eval plugin builder and case templates

**Lane A. Depends on:** nothing in code. The gates kind is included only if P0 passed before this task starts.

**Files:**
- Create: `src/eval/build.ts`, `templates/evals/skills/<skill>-{pos1,pos2,neg}/…`, `templates/evals/rules/<rule>/…`, `templates/evals/gates/<case>/…` (only after P0 passes)
- Test: `test/eval/build.test.ts`

**Interfaces:**
- Produces:
  - `export type EvalKind = 'skills' | 'rules' | 'gates'`
  - `export interface CaseInfo { name: string; kind: EvalKind; variant?: 'rules' | 'bare'; rule?: string; skill?: string }`
  - `export function buildEvalPlugin(root: string, opts: { kinds: EvalKind[]; tmp: string; dispatch: string; canary?: string }): { dir: string; cases: CaseInfo[]; skippedSkills: string[] }`
- Writes `<tmp>/.claude-plugin/plugin.json`, copies of `.claude/skills/<name>/` for known names, `hooks/hooks.json` (gates only) and `evals/<case>/{prompt.md,case.yaml,graders/*.md}`.
- The `rules` variant puts the text between the harness markers and the preset markers of `AGENTS.md` into `execution.append_system_prompt`. The `bare` variant leaves it out.
- `canary` defaults to `HARNESS_CANARY_` + 16 random hex characters.
- Graders are free only (`tool_used`, `regex`, `tool_order`, `file_exists`), per spec §7.2. `prompt.md` sets `max_turns` (10, or 3 for gates) and `allowed_tools`.

- [ ] **Step 1: Pin the grader format.** Read https://code.claude.com/docs/en/plugin-evals.md and record in the PR body the frontmatter keys for each free grader and for `case.yaml` `execution.append_system_prompt` and `scaffold_script`. If a key differs from spec §7.2, follow the docs and say so.
- [ ] **Step 2: Write the failing tests:**
  - Kinds `['skills']` with `.claude/skills/frontend-react/` and `.claude/skills/my-own/` give 3 cases for `frontend-react` and `skippedSkills: ['my-own']`.
  - `rules` gives a `rules` and a `bare` case per rule, and only the `rules` one has `append_system_prompt` holding the core block text.
  - `no-ai-trailer`'s grader has `input_match` `Co-Authored-By|Generated with Claude` and `max: 0`.
  - No grader file has `type: llm` or `type: baseline`.
  - Gates (if present): the scaffold writes the canary, and a grader regex has the same canary.
  - The folder is under `tmp`, never under `root`.
- [ ] **Step 3: Run and confirm they fail.**
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 6: Docs.** Checked, no change. If P0 failed, the same PR changes spec §7.2 to say gate evals were dropped.
- [ ] **Step 7: Commit.** `feat(eval): eval plugin builder and case templates`.

### Task 16: Eval runner and result import

**Lane A. Depends on:** 15, 8.

**Files:**
- Create: `src/eval/run.ts`, `src/cli/eval.ts`, `src/report/evals.ts`
- Modify: `src/report/html.ts` (render `ReportData.evals`)
- Test: `test/eval/run.test.ts`, `test/cli/eval.test.ts`, `test/report/evals.test.ts`

**Interfaces:**
- Consumes: `buildEvalPlugin`, `CaseInfo`, `EvalKind` (15); `Prompt`, `readlinePrompt` types (`src/cli/prompt.ts`).
- Produces:
  - `export function evalArgs(dir: string, o: { runs: number; model: string; maxCost: number; out: string; scaffold: boolean; tools: string[] }): string[]`. It always includes `--ablation none --no-publish --trust-plugin --json <out>/result.json --report <out>/report.html --output-dir <out>`, plus `--scaffold` and `--allow-tools Bash Write Edit` where the kinds need them.
  - `export function planLines(cases: CaseInfo[], runs: number, model: string, maxCost: number, lastCostPerRun: number | null): string[]`. It lists kinds, cases, variants, runs, total agent runs and `judge calls: 0`. The estimate line reads `Estimate from your last run: ~$X` or `No estimate yet; the $<maxCost> ceiling caps the spend`, plus `Spend can pass the ceiling by up to one agent run.`
  - `export async function evalCmd(args: string[], cli: CliEnv & { prompt: Prompt; exec?: Exec; tmp?: string }): Promise<number>` (flags `--kind`, `--runs` default 3, `--max-cost-usd` default 2, `--model` asked when absent)
  - `export interface EvalSummary { date: string; model: string; kind: EvalKind; cases: { name: string; mean: number; passK: boolean | null; variant?: string; rule?: string }[]; deltaByRule: Record<string, number | null>; costUsd: number | null }`
  - `export function readEvalResults(root: string): EvalSummary[]` (reads `.harness/reports/evals/*/result.json`; `passK` is null when per-run scores are missing)
- Order:
  1. Refuse when `cli.tty === false`, when `CLAUDECODE` is set, or when `CI` is `true` or `1`.
  2. Ask for the model.
  3. Build the plugin.
  4. Print the plan.
  5. `prompt` until the answer is exactly `yes`.
  6. Exec `claude plugin eval …`.
  7. Copy the result to `.harness/reports/evals/<date>-<model>-<kind>/`.

- [ ] **Step 1: Write the failing tests** with a fake `claude` binary on a temp `PATH`, recording its arguments and printing a canned result:
  - The arguments contain `--ablation none`, `--no-publish`, `--model claude-x`, `--max-cost-usd 2` and `--runs 3`.
  - Answers `y`, `YES ` and empty don't run `claude`; `yes` does.
  - The refusals: `tty: false`, `CLAUDECODE=1`, `CI=true`.
  - With no earlier result the plan has `No estimate yet`. With an earlier `costUsd: 0.6, runs 6` it has `~$0.10` per run × the new run count.
  - `readEvalResults`: pass^k is true only when every run of a case scored ≥ the threshold. The delta is pass^k rate (rules) − pass^k rate (bare).
  - The HTML eval section names the model.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** Checked, no change (routed in Task 18).
- [ ] **Step 6: Commit.** `feat(eval): harness eval runner with consent and cost plan`.

### Task 17: Dispatcher hookup: `use`, `ms`, timing

**Lane B. Depends on:** 5, L1, and PR-size Task 8 merged. Rebase on `main` first.

**Files:**
- Modify: `src/hooks/dispatch.ts` (the `log` helper; the end of `dispatchLocked`), `src/hooks/types.ts` (`HookInput.tool_use_id?: string`)
- Test: `test/hooks/dispatch.test.ts` (add cases), `test/perf/latency.test.ts` (unchanged, must pass)

**Interfaces:**
- Consumes: `appendTiming`, `TimingLine` (5).
- The `log` helper adds `use: input.tool_use_id` when it is a string (only if L1 confirmed the field; otherwise this line is left out and the PR says so), and `ms: Date.now() - PROCESS_START`.
- At every return of `dispatchLocked` that has a parsed input, append one `TimingLine`:
  - `event`: `hook_event_name`;
  - `tool`: `tool_name` when present;
  - `outcome`: the emitted decision kind, or `allow`;
  - `ms`: `Date.now() - PROCESS_START`.
- Use one small local wrapper, so each early `return emit(...)` path records too.

- [ ] **Step 1: Write the failing tests:**
  - An allowed Read writes one timing line with `outcome: 'allow'`, `tool: 'Read'`.
  - A guard deny writes one event with `use` (when L1 passed) and `ms`, plus one timing line with `outcome: 'deny'`.
  - A Stop block from `harness-files` writes a timing line.
  - A throwing `appendTiming` (seam) leaves the decision unchanged.
  - Timing lines hold no `tool_input` text.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck` and `pnpm test:perf -- test/perf/latency.test.ts` (median overhead under `OVERHEAD_MS`; report the number in the PR body).
- [ ] **Step 5: Docs.** Checked, no change (Task 5 documented the log).
- [ ] **Step 6: Commit.** `feat(report): dispatcher writes timing and event ids`.

### Task 18: Route `report` and `eval`; README

**Lane B. Depends on:** 10, 16, and preset Task 1b merged. Rebase on `main` first. Preset 11, 13 and 14 also edit `USAGE`; whichever lands second rebases.

**Files:**
- Modify: `src/cli/index.ts` (USAGE lines; `report` and `eval` routed in the async entry chain, `eval` with `readlinePrompt`), `README.md`, `docs/reference.md`, `test/package/readme.test.ts`
- Test: `test/cli/usage.test.ts` (add), `test/package/readme.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `USAGE` contains `harness report [--days N] [--open] [--export]` and `harness eval [--kind skills|rules|gates] [--runs N] [--max-cost-usd X] [--model M]`.
  - New `readme.test.ts` assertions:
    - the README contains `usage and adherence report`;
    - its command table has a `| \`report ` row;
    - it contains `start Claude Code inside the repo for the report to see it`.
  - The existing "no telemetry" assertions stay.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement** the routing, and write the README section: what the report shows, where it is written, that it is local and gitignored, `--export` counts only, the O1 sentence verbatim, and `harness eval` costs money and asks every run. Never use the word "telemetry". `docs/reference.md` gets the full flags, the timing log, and the report folder.
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck` and `pnpm test`.
- [ ] **Step 5: Commit.** `feat(report): route harness report and eval; README`.

### Task 19: Rule coverage matrix

**Lane B. Depends on:** 8, 10, and preset Task 3 merged (`config.preset`).

**Files:**
- Create: `src/report/rules.ts`
- Modify: `src/report/html.ts` (rules section), `src/cli/report.ts` (pass `rules`)
- Test: `test/report/rules.test.ts`

**Interfaces:**
- Consumes: `HarnessConfig` with `preset?: { id; version; items; git }` (preset 3); `GatesResult` (6); `WindowsResult` (7).
- Produces:
  - `export type RuleId = 'ask-first' | 'no-invented-data' | 'fix-everything' | 'small-prs' | 'readme-per-pr' | 'paid-ok' | 'tdd' | 'lean-context' | 'plain-communication' | 'no-ai-trailer' | 'branch-prefix'`
  - `export interface RuleDef { id: RuleId; kind: 'judgement' | 'mechanical' | 'partial' | 'measured' | 'heuristic'; checks: string[] /* logged check names */; on: (c: HarnessConfig) => boolean; bypasses: string[] }`. These are the 11 rows of spec §5.1, verbatim in their bypass text.
  - `export interface RuleRow { def: RuleDef; enforced: 'yes' | 'partial' | 'no'; fires: number; denies: number; asks: number; blocks: number; probableFalse: number; windows: number }`
  - `export function ruleRows(config: HarnessConfig, gates: GatesResult, windows: WindowsResult): RuleRow[]`
  - `export function enforcedLine(rows: RuleRow[]): string` (`X of 11 rules enforced deterministically, Y partly`)

- [ ] **Step 1: Write the failing tests:**
  - Default config (`checks.tdd: false`, no preset) gives `0 of 11 rules enforced deterministically, 2 partly` (the `no-invented-data` and `paid-ok` rows).
  - `checks.tdd: true` plus a preset with `no_ai_trailer` and `branch_prefixes` gives `3 of 11 …, 2 partly`. Adding `checks.prSize: true` (PR-size Task 7's key) gives `4 of 11 …, 2 partly`.
  - An off check makes its rule `no`, never "followed".
  - The HTML rules section shows the matrix and the line.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`.
- [ ] **Step 5: Docs.** README: one sentence that the report shows "X of 11 rules enforced". Reference: checked.
- [ ] **Step 6: Commit.** `feat(report): rule coverage matrix`.

### Task 20: Guard: `report` ask, `eval` deny

**Lane C. Depends on:** 18, preset Task 11 and PR-size Task 5 merged. Rebase on `main`, keeping their `guard.ts` lines.

**Files:**
- Modify: `src/checks/guard.ts` (two `PERSON_ONLY` entries only), `src/cli/report.ts` (drop the inside-Claude refusal)
- Test: `test/checks/guard.test.ts` (add), `test/cli/report.test.ts` (update)

**Interfaces:**
- `PERSON_ONLY.report = { kind: 'ask', allowed: (a) => a.includes('--help'), why: () => "the agent is running the usage and adherence report, which reads this repo's session transcripts" }`
- `PERSON_ONLY.eval = { kind: 'deny', allowed: (a) => a.includes('--help'), why: (run) => \`Only a person can run paid evals: run ${run('eval')} in your own terminal.\` }`

- [ ] **Step 1: Write the failing tests:**
  - `harness report --days 7` → ask, with that reason. The same unattended → deny (dispatch's existing conversion).
  - `npx @khubaibqaiser/harness eval` → deny.
  - `harness report --help` → allow.
  - `report()` with `CLAUDECODE=1` now runs.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck`, `pnpm test`, and Task 11's attack suite (rates unchanged or lower).
- [ ] **Step 5: Docs.** Reference: the guard's person-only list gains both. README: checked.
- [ ] **Step 6: Commit.** `feat(guard): ask before the agent runs the report; deny evals`.

### Task 21: `.harness/reports/` in `mergeGitignore`

**Lane C. Depends on:** 10, preset Task 5 and PR-size Task 7 merged.

**Files:**
- Modify: `src/install/merge.ts` (`mergeGitignore`'s list gains `.harness/reports/`), `src/cli/report.ts` (stop writing the self-`.gitignore` when the root `.gitignore` already has the line)
- Test: `test/install/merge.test.ts`, `test/cli/report.test.ts`, plus any init or plan test that asserts the exact `.gitignore` text

- [ ] **Step 1: Write the failing tests:**
  - `mergeGitignore(null)` has `.harness/reports/`.
  - An existing install gets the line on `harness update` (the `appendLines` behaviour).
  - `report` writes no `.harness/reports/.gitignore` when the root `.gitignore` has the line, and still writes it when not.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck` and `pnpm test`, including the uninstall byte-identical tests.
- [ ] **Step 5: Docs.** Checked, no change.
- [ ] **Step 6: Commit.** `feat(install): gitignore the report folder`.

### Task 22: `harness rules`: ESLint apply

**Lane C. Depends on:** 13, 14, and preset Tasks 5 and 14 merged.

**Files:**
- Create: `src/cli/rules.ts`
- Modify: `src/install/merge.ts` (`mergeEslintHarnessRules`, modelled on `mergeEslintFlatIgnores`), `src/cli/index.ts` (USAGE and route), `src/cli/uninstall.ts` only if Step 1 shows the existing `removeBlocks` path doesn't remove the import
- Test: `test/cli/rules.test.ts`, `test/install/merge.test.ts`

**Interfaces:**
- Consumes: `propose` (13), `countViolations` (14), `applyChanges`, `Change` (`src/install/apply.ts`), `unifiedDiff` (`src/install/diff.ts`), `detect`.
- Produces:
  - `export function mergeEslintHarnessRules(before: string): { after: string; blocks: string[] } | null`. It adds `import harnessRules from './.harness/eslint/harness.config.mjs';` and `...harnessRules` at the end of the exported array, each between `// harness:rules` markers. It returns null when the shape isn't a flat-config array.
  - `export async function rules(args: string[], cli: CliEnv & { prompt: Prompt; exec?: Exec }): Promise<number>`
- `harness rules` prints:
  - the per-rule counts, highest first, then the rules at 0 as "safe to add now";
  - the stop-gate warning line from spec §5.2, verbatim;
  - missing plugins, dropped rules and the `NO_LINT` list;
  - the unified diff.
- `--apply` asks `yes`, then applies two changes through `applyChanges`, recorded in the manifest:
  - create `.harness/eslint/harness.config.mjs`;
  - update `eslint.config.*` with blocks.

- [ ] **Step 1: Write the failing tests:**
  - On a fixture Next.js repo with a flat `eslint.config.mjs`, the preview shows counts and the stop-gate line, and `--apply` plus `yes` writes both files. `harness uninstall` then leaves the repo byte-identical.
  - **Review focus 4:** a repo with `.eslintrc.json` only, or no ESLint config, gets `--apply` refused with manual steps and nothing written.
  - When counts are unknown (ESLint timeout), the preview says the gate impact is unknown and never shows 0.
  - Any answer other than `yes` writes nothing.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck` and `pnpm test`.
- [ ] **Step 5: Docs.** README: a short `harness rules` row saying it's error-level from day one and shows counts first. Reference: the full flags.
- [ ] **Step 6: Commit.** `feat(rules): harness rules applies ESLint settings on a yes`.

### Task 23: `harness rules`: TS options apply

**Lane C. Depends on:** 22.

**Files:**
- Modify: `src/install/merge.ts` (`mergeTsconfigOptions`, `removeFromTsconfig`), `src/cli/uninstall.ts` (route `tsconfig.json` entries to `removeFromTsconfig`, beside `removeFromSettings`), `src/cli/rules.ts`
- Test: `test/install/merge.test.ts`, `test/cli/rules.test.ts`, `test/cli/uninstall.test.ts`

**Interfaces:**
- `export function mergeTsconfigOptions(before: string, opts: Record<string, true>): { after: string; blocks: string[] } | null`. It records one `{"set":["compilerOptions",<key>],"value":true}` block per option it changes, in `removeSets`'s format. A key already set to any value is left alone and listed. It returns null when the file has comments or trailing commas (`JSON.parse` fails); the CLI then prints the lines as a manual step.
- `export function removeFromTsconfig(current: string, f: Manifest['files'][number], original: string | null, notes: string[]): { after: string; empty: boolean } | null`

- [ ] **Step 1: Write the failing tests:**
  - Apply on a plain `tsconfig.json` sets the five options, and uninstall restores it byte-identically.
  - An existing `strict: false` stays, and the preview lists it.
  - A tsconfig with comments gives the manual lines and no write.
  - The preview shows per-option counts from Task 14.
- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm they pass**, then `pnpm typecheck` and `pnpm test`.
- [ ] **Step 5: Docs.** Reference: the TS options. README: checked.
- [ ] **Step 6: Commit.** `feat(rules): TS options on a yes`.

---

## Self-review

- **Spec coverage:**

  | Spec | Task |
  |---|---|
  | §3.1 locating (O1) | 1 |
  | §3.2 fields, duplicates, versions, streaming | 2, 3 |
  | §3.3 event fields and timing log (O3) | 5, 17 |
  | §3.4 config and install state | 3 (`alwaysLoaded`), 4, 19 |
  | §4.1 skills | 4 |
  | §4.2 loads, mechanical rules, windows | 3, 19, 7 |
  | §4.3 tokens | 3 |
  | §4.4 gates, latency, hallucination row | 6 |
  | §5.1 coverage matrix | 19 |
  | §5.2, §5.3 lint and TS (O4, O5, O10) | 13, 14, 22, 23 |
  | §6 report CLI, HTML, export (O9) | 8, 9, 10, 18, 21 |
  | §7 evals, consent, model pin, probe (O6–O8) | P0, 15, 16, 20 |
  | §8 privacy and who runs it (O2) | 9, 10, 20 |
  | §9 performance | 2, 5, 17 |
  | §10 tests, attack suite | every task, 11 |
  | U16 doctor check | 12 |

- **Types:** these names are used the same way in every task: `TRec`, `Usage`, `ToolUse`, `Turn`, `Acc`, `SessionCtx`, `Bucket`, `SkillRow`, `GatesResult`, `WindowsResult`, `ReportData`, `TimingLine`, `appendTiming`, `LintRule`, `Proposal`, `Counts`, `CaseInfo`, `EvalKind`, `EvalSummary`.
- **Proportion:** there are no function bodies. The exact values are the spec's (caps, regexes by reference to §4.2, O10 numbers, CSP, copy lines).

## Owner questions

None about the design. The execution method is subagent-driven (owner, 2026-11-05).

Two runs are approved but need the owner's logged-in terminal, because the agent's CLI isn't logged in:
- **P0 rerun** (gates kind of Task 15). Estimate: about $0.10 on Haiku 4.5 (not measured).
- **L1** (Task 17).
