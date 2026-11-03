# Platform enforcement implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harness leans on Claude Code's own enforcement. Hooks fail closed through `onFailure: "block"`, PowerShell and Monitor reach the checks, a `ConfigChange` hook blocks changes to harness's own settings, and unattended runs need Claude Code's sandbox. Test results move to `.harness/results/`, and `harness update` migrates an existing install in one run. Uninstall stays byte-identical.

**Architecture:**
- The settings fragment moves to exec form (`command: "node"`, `args`), with `onFailure: "block"` on PreToolUse, UserPromptSubmit and ConfigChange. `mergeSettings` replaces recorded harness groups in place, so uninstall's deep-equality removal keeps working.
- Two new checks join the registry: `config-change` (ConfigChange) and `sandbox-required` (PreToolUse, shell tools). The regex layer gets only the PowerShell path rule and the `init`/`update` ask (spec 3.5).
- `sandbox: always` adds `sandbox` keys as `{"set":[…],"value":…}` settings blocks, recorded and removed like `{"deny":…}` blocks.
- The results move goes through the existing installer: `testConfigChange` gains a rename branch, `update` rewrites that file's manifest blocks and hunks, and the config gets a one-line edit.
- Every write still goes through `applyChanges` (backup, temp-and-rename, rollback, manifest last).

**Tech stack:** TypeScript, Node ≥ 22.11, esbuild bundle, Vitest, `yaml`, `picomatch` and `magicast` (bundled dev dependencies, already present). No new dependency.

**Spec:** `docs/specs/2026-11-03-platform-enforcement-design.md` (binding; section 15 holds the owner's final rulings). Its research is `docs/research/2026-11-03-platform-enforcement.md` ("R§n"). The spec amends `docs/specs/2026-11-01-harness-beta-design.md` §5.3, §5.4, §7 and §10, and wins where they disagree. Read both before Task 1.

## Plan rulings

Points where the spec is silent, ambiguous or doesn't match the code. Each gives the reading this plan takes and what it costs if the owner reads it otherwise.

1. **No PostToolUse test-run detection exists in `test-lock.ts`.** Spec 3.2 asks `isShell` to replace it, but `test-lock.ts` never looks at `tool_name` (it uses `editTarget`). The plan changes nothing there. Its test only pins that a PowerShell or Monitor input is allowed, as Bash is today (Task 2). *If wrong:* a shell branch is added to `test-lock` later; that's one small task.
2. **Stdin with no readable event exits 1.** Spec 3.1 says unparseable stdin prints a deny on PreToolUse and exits 1 elsewhere, but garbage stdin has no event. The plan prints a deny only when the JSON parses and names `PreToolUse`; everything else unparseable exits 1. The bundle test "exits 0 for empty and garbage stdin" flips to exit 1. *If wrong:* a PreToolUse with truly unreadable stdin is still blocked, because `onFailure` treats exit 1 like exit 2. Only the stderr wording differs.
3. **The guarded view's fingerprint includes `sandbox`.** Without it, an agent change to `sandbox` alone would match the CLI's last fingerprint, so `config-change` would let it through (spec 3.3's CLI exemption). As a result, change detection also reports `sandbox` changes. *If wrong:* the exemption would need its own record. The fingerprint stays narrower, but a `sandbox` change could pass as CLI-made.
4. **The ConfigChange baseline is the files at the session's first hook, not the repo's last-seen record.** Spec 3.3 says it "is taken with the existing session baseline", which today can be a hash-only record from an earlier session. A guarded view needs the parsed parts, so the plan stores those in the session state at the first hook that isn't a ConfigChange. A ConfigChange with no baseline (degraded setup, or the first hook of the session) blocks, as `onFailure` would. *If wrong:* a change made between sessions isn't something ConfigChange can see anyway; change detection still reports it.
5. **An empty `sandbox` object is removed through a parent block.** When `always` creates `sandbox`, `mergeSettings` also records `{"set":["sandbox"],"value":{}}`. Removal runs deepest path first. So both uninstall and "leaving `always`" in `update` drop an object harness created, and keep one that existed before. This replaces spec 6.4's `had()` lookup, which `update` can't use. *If wrong:* only uninstall follows `had()`. Then "leaving `always`" on a repo that had `sandbox: {}` before init isn't byte-identical.
6. **The results rename keeps the user's layout and isn't re-run through Prettier.** Spec 5 says to substitute the path in the file, its blocks and its hunks' `from`. A shorter path can, in theory, let Prettier join lines. The plan does the plain substitution, as the spec says. *If wrong:* a repo whose format-check Stop step flags the migrated config needs one manual format run.
7. **A results path harness didn't record is migrated with recorded hunks.** This covers Jest's config form, where the person followed `init`'s manual lines, and hand-set Vitest paths. The old path is then user text, so no manifest block holds it. `update` records `lineHunks(before, after)` as `replace` hunks (not `formatted`), so uninstall reverts them. *If wrong:* the plan would leave such files as a `manual` line, and doctor's results-path `fix` would point at an `update` that can't fix it.
8. **A `results_dir` inside `.harness/state` is checked by text in `validateConfig`, and with the repo root in `loadConfig`.** `validateConfig` has no root, so an absolute path inside the state folder is caught only by the hooks' `loadConfig`. *If wrong:* `update` and `doctor` also need the root passed to `validateConfig`.
9. **`update` migrates the old `results_dir` before it validates.** The new rule makes the old default invalid. Validating first would make `update` refuse the very install it must migrate. *If wrong:* every existing TDD install would need a hand edit before `update`.
10. **Any `sandbox` change blocks mid-session, `/sandbox` included.** D6 and spec 12 say "any `sandbox` change". If `/sandbox` writes a settings file, turning the sandbox on mid-session is blocked too, and it takes effect in the next session. *If wrong:* `guardedDiff` would allow a change that only turns `sandbox.enabled` on. The README's `/sandbox` advice says "before the session" until live check 8 settles it.
11. **WSL2 means Linux with `WSL_DISTRO_NAME` set** (for `status`). *If wrong:* the status line says "Linux" under WSL2. That's cosmetic, and the sandbox behaves the same.
12. **Managed settings come from one file per platform.** The paths come from R§5 Q8 and the managed-settings page, confirmed in Task 8 step 0. Any other managed source (a drop-in folder, MDM) isn't read. *If wrong:* `sandbox-required` denies an unattended run that only managed settings sandbox, and the person sets `HARNESS_SANDBOX=1`. That's the fail-closed direction.
13. **A results-path change and another test-config change in the same package take two `update` runs.** `testConfigChange` returns one change per package. The rename comes first, and `doctor` names what is left. *If wrong:* the rename would have to merge into the other branches' inserts.

## Global constraints

**From the spec (exact values):**
- `MIN_CLAUDE_CODE` = `2.1.314`. `doctor` prints `fix Claude Code <v> is older than 2.1.314: update Claude Code` below it, and still `ok` when `claude` isn't found (C4).
- The fragment is spec section 2, verbatim: matchers, exec form, `timeout` 10 (Stop 600), `onFailure: "block"` only on PreToolUse, UserPromptSubmit and ConfigChange, and the 30 deny rules. There is no `.harness/results/**` rule.
- The `always` block is `{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false, "autoAllowBashIfSandboxed": false } }`. `failIfUnavailable` is never written to the repo.
- `sandbox` takes `unattended` (default), `always` or `off`. `tdd.results_dir` defaults to `.harness/results` and must not be inside `.harness/state`.
- The dispatcher's failure deny reads `harness dispatcher failed: <message>`. `--self-test` prints `ok <process.version>`.
- `hook-env.json` is `.harness/state/hook-env.json`: `{ ts, node: process.version, execPath: process.execPath, platform: process.platform }`.
- The sandbox-required deny, verbatim: "Unattended run without Claude Code's sandbox. Start it with the command in the README (Unattended runs and CI), or set `sandbox: off` in `.harness/config.yaml`."
- The documented launch, verbatim: `HARNESS_SANDBOX=1 claude -p "…" --settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"autoAllowBashIfSandboxed":false}}'`.
- `doctor` and `status` lines are spec section 8, verbatim where it gives the text.
- The regex layer is frozen except the PowerShell path rule (3.2) and the `init`/`update` ask (3.5).

**Owner rules for this plan:**
- Small stacked PRs, one concern each, under about 800 changed lines where possible (see PR slices). Before each slice's PR, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm test:perf` pass.
- Commit with `git -c user.name=khubaibqaiser -c user.email=khubaib.dev@gmail.com commit`, with explicit `git add` paths. Never add a `Co-Authored-By` trailer or a generated-by PR footer. Never push to `main`. The owner pushes and merges.
- No task except Task 14 runs `claude -p`, a live Claude Code session or any paid API. Reading the public docs pages (Tasks 8, 9, 13) costs nothing and is allowed.
- The Windows perf budget is 250 ms (PR #8). `test/perf/latency.test.ts` keeps `OVERHEAD_MS` as PR #8 leaves it. A task may change only the fixture paths in it.
- Uninstall stays byte-identical. Task 12 proves it on migrated installs.

**Carried from the beta plan:**
- No runtime dependencies. No shell: spawn through `spawnSync(cmd, argv)` or `syncCommand`/`findOnPath` (`src/checks/stop/runner.ts`).
- Repo-relative paths use `/`. Never read or write `.env*`.
- User-facing copy: one short sentence on what happened, then the next step, no "please", paths in backticks.
- Copy this plan fixes where the spec doesn't is marked "(plan copy)". The owner may reword it.

**Existing helpers to reuse (exported, never copied):**
- `settingsFingerprint` and `harnessDenyRules` (`src/core/harness-files.ts`, now private) are exported for Task 9.
- `hasResultsOutput(pkg, root, dir)` (`src/install/test-config.ts`) gives doctor's results-path check with `LEGACY_RESULTS_DIR`.
- `lineHunks`/`revertHunks` (`src/install/diff.ts`) handle the unrecorded rename (ruling 7).
- `findOnPath(cmd, env, platform)` handles the `bwrap`/`socat` checks.
- `withNotice` (`src/hooks/dispatch.ts`) shows the ConfigChange notice.
- `withPrettier` (the fake Prettier in `test/install/format.test.ts`) moves to `test/install/helpers.ts` for Task 12.

## Review focus

1. **An old TDD install runs the new `update`.** Its `config.yaml` has `results_dir: .harness/state/test-results`, which the new rule rejects. Expected: `update` migrates the line before it validates, shows it in the diff, and finishes in one run. Test: Task 5, `update migrates the old results_dir before validating`.
2. **Another tool's `node` exec-form hook sits next to harness's.** For example `{ command: "node", args: ["tools/lint-hook.mjs"] }` in PreToolUse. Expected: `init`, `update` and `uninstall` never touch it. Tests: Task 6, `a foreign node exec hook survives init, update and uninstall`.
3. **A person's `settings.local.json` turns the sandbox off under `always`.** Expected: an unattended shell call is denied, because local wins over project, and managed wins over both. Test: Task 8, `local sandbox.enabled false beats committed always`.
4. **`.claude/settings.json` is deleted, or saved half-written, mid-session.** Expected: both block. A deleted file has lost the harness hooks. A non-JSON file can't be checked, and Claude Code keeps the running settings either way. Tests: Task 9, `deleting the project settings blocks` and `a non-JSON guarded file blocks as unreadable`.
5. **The repo path has a space and a non-ASCII letter.** Expected: the exec-form hook and doctor's `--self-test` spawn both run without quoting. Tests: Task 6, `the exec-form hook runs from a repo path with a space and ü` (e2e), and Task 10, `doctor self-test runs from a path with a space and ü`.

---

## PR slices

Each slice is a branch off the previous one, holds one concern, and passes typecheck, lint, `pnpm test` and `pnpm test:perf` on its own. Line counts are estimates.

| # | Branch | Tasks | Base | Estimate |
|---|---|---|---|---|
| S1 | `fix/pe-1-dispatcher-failure` | 1 | `ci/beta-7-workflows` with #8, #9, #10, #11 and this plan's PR merged | ~200 |
| S2 | `feature/pe-2-shell-tools` | 2, 3 | S1 | ~350 |
| S3 | `feature/pe-3-results-dir` | 4, 5 | S2 | ~700 |
| S4 | `feature/pe-4-settings-fragment` | 6 | S3 | ~450 |
| S5 | `feature/pe-5-sandbox` | 7, 8 | S4 | ~650 |
| S6 | `feature/pe-6-config-change` | 9 | S5 | ~550 |
| S7 | `feature/pe-7-doctor-status` | 10, 11 | S6 | ~600 |
| S8 | `feature/pe-8-upgrade-e2e` | 12 | S7 | ~500 (fixtures are generated JSON) |
| S9 | `docs/pe-9-readme` | 13 | S8 | ~200 |
| — | none (gated) | 14 | runs on S9's tip | findings go to the owning slice |

- PRs #9 (`src/hooks/dispatch.ts`, SessionEnd change detection) and #10 (`src/checks/guard.ts`, wrapper option clusters) merge before S1 starts. Task 1 touches only `main()` and the entry guard in `dispatch.ts`. Task 9 touches the notice join after the change-detection block. Tasks 2 and 3 touch `PERSON_ONLY` and `guard.run`. None of these touch #9's or #10's hunks.
- If S3 goes past 800 lines, Task 5 moves to its own branch `feature/pe-3b-results-migration` off S3.

## Before Task 1

- [ ] Confirm #8, #9, #10, #11 and this plan's PR are merged into `ci/beta-7-workflows`. `pnpm test` and `pnpm test:perf` pass on its tip. Record the test count; every task keeps it passing.
- [ ] Keep the beta build for Task 12: on that tip, `pnpm build`, then copy `dist/` and `templates/` to a scratch folder `beta/` outside the repo. Record the commit sha.

### Task 1: Dispatcher failure handling, self-test and hook environment record

**Files:**
- Create: `src/core/hook-env.ts`
- Modify: `src/hooks/dispatch.ts` (`main()`, the entry guard, the hook-env write)
- Test: `test/hooks/dispatch.test.ts`, `test/core/hook-env.test.ts`

**Interfaces:**
- Produces: `interface HookEnv { ts: string; node: string; execPath: string; platform: string }`, `HOOK_ENV_REL = '.harness/state/hook-env.json'`, `writeHookEnv(root: string, now?: Date): void` (atomic, via `writeAtomic`), `readHookEnv(root: string): HookEnv | null`.
- Produces, in `dispatch.ts`: `runHook(raw: string, run: (raw: string) => Promise<string>): Promise<{ out: string; code: 0 | 1 }>`. `main()` is `runHook(stdin, (r) => dispatch(r, registry, process.env))`, then it writes `out` and sets `process.exitCode = code`.
- Consumed by Tasks 10 and 11 (`readHookEnv`).

- [ ] **Step 1: Write the failing tests**
  - `a throw on PreToolUse prints a deny`: `runHook(<PreToolUse JSON>, throwing)` gives code 0 and `permissionDecision: 'deny'` with reason `harness dispatcher failed: bad`.
  - `a throw on UserPromptSubmit or ConfigChange exits 1 with no output`.
  - `unparseable stdin`: `''` and `garbage{` give code 1. `{"hook_event_name":"PreToolUse"}` (fields missing) gives the deny. A valid input with an unknown event still gives `''` and code 0.
  - The bundle test is renamed `bundle exits 1 with empty stdout for empty and garbage stdin` and expects status 1.
  - `--self-test prints ok and the Node version without reading stdin`: spawn `dist/hooks/dispatch.mjs --self-test` with stdin left open and a 5 s timeout. Stdout matches `/^ok v\d+\.\d+\.\d+\n?$/` and status is 0.
  - `UserPromptSubmit writes hook-env.json`: after `dispatch(<UserPromptSubmit>)`, `readHookEnv(root)` has `node === process.version`, `execPath === process.execPath`, `platform === process.platform` and an ISO `ts`. A PreToolUse alone writes nothing.
  - `readHookEnv` returns null for a missing file and for non-JSON.
- [ ] **Step 2: Run `pnpm vitest run test/hooks/dispatch.test.ts test/core/hook-env.test.ts` and confirm the new tests fail.**
- [ ] **Step 3: Implement.**
  - `--self-test` is checked before stdin is read.
  - An entry path `realpathSync` can't resolve sets `process.exitCode = 1`. This one-line change has no test.
  - The hook-env write sits in `dispatchLocked` after setup, only when `!fallback`, inside its own try/`warn('hook env', e)`.
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/core/hook-env.ts src/hooks/dispatch.ts test/hooks/dispatch.test.ts test/core/hook-env.test.ts`: `fix(hooks): the dispatcher fails closed, adds --self-test and records the hook environment`.

### Task 2: PowerShell and Monitor reach the checks

**Files:**
- Modify: `src/hooks/edit-target.ts`, `src/checks/guard.ts` (`guard.run` only), `src/checks/protect.ts:239`, `src/checks/tdd/spec-gate.ts:31`, `src/hooks/dispatch.ts:224`
- Test: `test/checks/guard.test.ts`, `test/checks/protect.test.ts`, `test/checks/tdd/spec-gate.test.ts`, `test/checks/tdd/test-lock.test.ts`, `test/hooks/dispatch.test.ts`

**Interfaces:**
- Produces: `isShell(tool: string | undefined): boolean` in `edit-target.ts`. It is true for `Bash`, `PowerShell` and `Monitor`. Every `tool_name === 'Bash'` test listed above uses it. The command is still `tool_input.command`.
- Produces the PowerShell path rule in `guard.run`. When `tool_name === 'PowerShell'`, `decideCommand` runs first. If it allows and the command matches `/\.harness|\.claude|\.env/i`, the guard returns `{ kind: 'ask', reason: 'Harness does not parse PowerShell, so a PowerShell command that names .harness, .claude or .env needs your approval.', check: 'guard' }` (plan copy). The dispatcher already turns an ask into a deny when unattended.

- [ ] **Step 1: Write the failing tests**
  - Guard:
    - `git push --force origin x` as PowerShell and as Monitor is denied.
    - `cat .env` as PowerShell is denied (the existing word rule).
  - Path rule:
    - `Get-Content .harness/config.yaml` and `Set-Content .CLAUDE/settings.json x` ask.
    - `$env:PATH` and `Write-Output hi` are allowed.
    - `[System.Environment]::GetEnvironmentVariable('X')` asks: spec 3.2 matches `.env` case-insensitively, and this test pins that choice.
    - The same `Get-Content` with `permission_mode: 'bypassPermissions'` through `dispatch` is denied with reason prefix `Unattended run: `.
  - Protect: `echo x > .harness/state/a.json` as PowerShell, and `tail -f log > .claude/settings.json` as Monitor, are denied.
  - Spec gate: `echo {} > features.json` as PowerShell is denied, with the Bash message.
  - Test lock: a PowerShell input that names a locked test file is allowed (ruling 1).
  - Dispatcher: with an invalid config, a PowerShell `echo x > src/a.ts` is denied by `config`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test`.**
- [ ] **Step 5: Commit** `src/hooks/edit-target.ts src/checks/guard.ts src/checks/protect.ts src/checks/tdd/spec-gate.ts src/hooks/dispatch.ts test/checks/ test/hooks/dispatch.test.ts`: `feat(checks): PowerShell and Monitor commands go through the shell checks`.

### Task 3: Guard asks before the agent runs `harness init` or `update`

**Files:**
- Modify: `src/checks/guard.ts` (`PERSON_ONLY`)
- Test: `test/checks/guard.test.ts`

**Interfaces:**
- Produces two `PERSON_ONLY` entries, both `kind: 'ask'`, with `allowed: (a) => a.length > 0 && a.every((t) => t === '--dry-run' || t === '--check')`:
  - `init`: why `'the agent is installing the harness, which writes its hooks, rules and settings'` (plan copy);
  - `update`: why `'the agent is updating the harness, which rewrites its hooks, rules and settings'` (plan copy).

- [ ] **Step 1: Write the failing tests**
  - `init --yes` and `update --yes` ask. Each is tested as `node "/x/dist/cli.mjs" <sub> --yes`, `pnpm harness <sub>`, and `npx @khubaibqaiser/harness <sub>`.
  - `update --check`, `update --dry-run` and `init --dry-run` are allowed.
  - Bare `harness update` asks, because empty args aren't allowed.
  - With `permission_mode: 'dontAsk'`, `update --yes` through `dispatch` is denied with the `Unattended run: ` prefix.
  - `H=update; harness $H --yes` is denied with the hidden-subcommand reason.
  - The existing `tdd` and `uninstall` tests still pass.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.** This is the last task of S2.
- [ ] **Step 5: Commit** `src/checks/guard.ts test/checks/guard.test.ts`: `feat(guard): the agent asks before harness init and update`.

### Task 4: Results default moves to `.harness/results`

**Files:**
- Modify:
  - `src/core/config.ts`: the default, a `tdd.results_dir` rule, the `loadConfig` check and its warning;
  - `src/checks/protect.ts`: `PROTECTED` and `PROTECTED_CONCRETE`;
  - `src/install/merge.ts`: `mergeGitignore`;
  - `templates/hooks/jest-results.cjs` (comment only), `templates/config.example.yaml`;
  - `scripts/gen-config-docs.mjs` (`tdd.results_dir` text), `README.md` (regenerated config table only).
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/checks/protect.test.ts`, `test/install/merge.test.ts`. Path-only changes in `test/checks/tdd/*.test.ts`, `test/cli/init.test.ts`, `test/cli/update.test.ts`, `test/cli/doctor.test.ts`, `test/install/test-config*.test.ts`, `test/e2e/*.e2e.test.ts` and `test/perf/latency.test.ts` (fixture paths, never `OVERHEAD_MS`).

**Interfaces:**
- Produces, in `config.ts`: `DEFAULT_RESULTS_DIR = '.harness/results'` and `LEGACY_RESULTS_DIR = '.harness/state/test-results'`.
- Produces the rule `'tdd.results_dir'`. It is null for a string that, after `\`→`/`, `posix.normalize` and lower-casing, isn't `.harness/state` and doesn't start with `.harness/state/`. Otherwise it returns `must not be inside .harness/state (the sandbox denies it there)`; that text is also its README rule, since `undefined` returns it too.
- Produces, in `loadConfig`: an absolute `results_dir` that resolves inside `<root>/.harness/state` adds the same error (ruling 8). A value outside `.harness/results` warns `tdd.results_dir is outside .harness/results: protect doesn't cover it; the agent can write test results there with its file tools`.
- Produces: `mergeGitignore` lines become `.harness/state/`, `.harness/logs/`, `.harness/backup/`, `.harness/results/`.
- Produces: `.harness/results/**` in `PROTECTED`, and `.harness/results` in `PROTECTED_CONCRETE`.

- [ ] **Step 1: Write the failing tests**
  - `defaults use .harness/results`.
  - `results_dir inside .harness/state is an error`:
    - `.harness/state/x` and `./.harness/STATE/x` give the loadConfig error `"tdd.results_dir" must not be inside .harness/state (the sandbox denies it there)`;
    - they give the validateConfig error `tdd.results_dir: must not be inside .harness/state (the sandbox denies it there)`;
    - `<root>/.harness/state/x` (absolute) gives the loadConfig error.
  - `results_dir outside .harness/results warns`: `/tmp/x` and `build/results` give the warning above. `.harness/results/sub` gives none.
  - `configReference lists the results_dir rule`.
  - Protect:
    - Write to `.harness/results/x.json` is denied;
    - `echo {} > .harness/results/x.json` is denied;
    - `rm -rf .harness/results` is denied;
    - `pnpm test` is allowed.
  - `mergeGitignore adds .harness/results/`: a beta `.gitignore` with the three old lines gets one block, `.harness/results/\n`.
  - `config.example.yaml equals serializeConfig(defaults)` (existing; regenerate the file).
  - `config reference equals the generator output` (existing; regenerate with `node scripts/gen-config-docs.mjs --write`).
- [ ] **Step 2: Run `pnpm vitest run test/core test/checks/protect.test.ts test/install/merge.test.ts` and confirm the new tests fail.**
- [ ] **Step 3: Implement, then move the test fixtures' results paths to `.harness/results`.** Red-first, test-lock and spec-gate need no code change, since they read `resultsDir(config)`. The README text is `Where the test reporters write JSON results. Keep it inside \`.harness/results\`, which protect covers.` (plan copy).
- [ ] **Step 4: Run `pnpm typecheck && pnpm test`.**
- [ ] **Step 5: Commit** `src/core/config.ts src/checks/protect.ts src/install/merge.ts templates/ scripts/gen-config-docs.mjs README.md test/`: `feat(tdd): test results move to .harness/results`.

### Task 5: `update` migrates the results path

**Files:**
- Modify: `src/install/test-config.ts` (`testConfigChange`), `src/install/apply.ts` (`Change`), `src/install/manifest.ts`, `src/install/plan.ts`, `src/core/config-io.ts`, `src/cli/update.ts`
- Test: `test/install/test-config.test.ts`, `test/install/manifest.test.ts` (new), `test/core/config-io.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Consumes: `LEGACY_RESULTS_DIR`, `DEFAULT_RESULTS_DIR` (Task 4).
- Produces: `testConfigChange(pkg, root, resultsDir, legacyDir?: string): TestConfigResult`. It acts when `legacyDir` is given, resolves to a different folder than `resultsDir`, and the package's results file holds `resultPath(pkg, root, legacyDir)` exactly once. The results file is the Vitest config, or `package.json` for Jest. It then returns `{ change: { kind: 'update', rel, before, after, blocks: [], rename: { from, to } } }` with that string replaced. Otherwise it runs the existing branches unchanged.
- Produces: the `update` variant of `Change` gains `rename?: { from: string; to: string }`.
- Produces: `planChanges` passes `LEGACY_RESULTS_DIR` as `legacyDir`, and `formatEdits` skips changes with `rename` (ruling 6). `doctor` keeps calling `testConfigChange` without it.
- Produces: `renameRecorded(entry: Manifest['files'][number], from: string, to: string): { entry: Manifest['files'][number]; found: boolean }` in `manifest.ts`. It rewrites `from` to `to` in every block and every hunk's `from`. `found` is true when any of them held `from`.
- Produces: `migrateResultsDir(text: string): string | null` in `config-io.ts`. It matches one line `^(\s*results_dir:\s*)(['"]?)\.harness/state/test-results\2(\s*(#.*)?)$` and swaps the value for `.harness/results`, keeping the indent, quotes and comment. Zero or two matches give null.
- `update.ts` changes:
  1. It reads the config text and applies `migrateResultsDir` before parsing and validating (ruling 9).
  2. The config change is the one-line edit, not `serializeConfig`; every other config change is still dropped.
  3. The config's manifest hash is replaced only if the old hash matched.
  4. For a change with `rename`: when `renameRecorded` finds it, the entry's rewritten blocks and hunks are kept. Otherwise `lineHunks(c.before, c.after)` is added as `replace`, without `formatted` (ruling 7).
  5. A new manifest entry gets `formatted` only from `c.formatted`.

- [ ] **Step 1: Write the failing tests**
  - `testConfigChange`:
    - Vitest inline, root package: `'.harness/state/test-results/root.json'` becomes `'.harness/results/root.json'`, with `rename` set and `blocks` empty.
    - Monorepo `packages/a`: `../../.harness/state/test-results/a.json` becomes `../../.harness/results/a.json`.
    - Jest script `--outputFile=.harness/state/test-results/root.json` is substituted in `package.json`.
    - The old path twice, or `legacyDir === resultsDir`, gives the existing result.
  - `renameRecorded`:
    - a block holding `from` is rewritten (`found: true`);
    - a hunk `from` holding it is rewritten, and its `to` is untouched;
    - an entry without it is unchanged (`found: false`).
  - `migrateResultsDir`:
    - `  results_dir: .harness/state/test-results  # x` keeps the indent and the comment;
    - the `'…'` and `"…"` forms work;
    - `build/results` gives null;
    - two matching lines give null.
  - CLI, each through `init` on the current tree followed by rewriting the config, the Vitest path and the manifest blocks to the old path:
    - `update migrates the old results_dir before validating`:
      - one run exits 0;
      - the diff shows the config line;
      - the Vitest config and the manifest blocks hold `.harness/results`;
      - `.harness/state/test-results/` is left in place;
      - `uninstall --yes` then gives the pre-init bytes.
    - `an edited config keeps its old manifest hash`.
    - `a hand-set Jest path is migrated with recorded hunks and uninstall restores it`: the hand-applied manual lines are reverted, byte-identical.
    - `a custom results_dir is left alone`: `build/results` stays, and the config isn't in the change list.
    - `a custom results_dir inside .harness/state stops update with the config error`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Add one comment, `// ponytail: one change per package; a rename and another config edit take two update runs` (ruling 13).
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.** This is the last task of S3.
- [ ] **Step 5: Commit** `src/install/ src/core/config-io.ts src/cli/update.ts test/install/ test/core/config-io.test.ts test/cli/update.test.ts`: `feat(update): migrate test results to .harness/results in one run`.

### Task 6: Settings fragment, exec form and replace in place

**Files:**
- Modify: `templates/settings.fragment.json` (spec section 2, verbatim), `src/install/merge.ts` (`mergeSettings`), `src/install/plan.ts`, `src/install/apply.ts` (`Change`), `src/cli/update.ts` (manifest merge), `src/cli/doctor.ts` (`EVENTS`, `wired`)
- Test: `test/templates/settings.test.ts`, `test/install/merge.test.ts`, `test/cli/update.test.ts`, `test/cli/uninstall.test.ts`, `test/cli/doctor.test.ts`, `test/e2e/install.e2e.test.ts`

**Interfaces:**
- Produces: `isHarnessHook(h: unknown): boolean`, exported from `merge.ts`. It is true when `command`, or any string in `args`, contains `.harness/hooks/dispatch.mjs`. Task 10 uses it.
- Produces: `mergeSettings(before: string | null, opts: { sandbox: SandboxMode; recorded?: string[] }): { after: string; blocks: string[]; dropped: string[]; notes: string[] }`.
  - Per event, a group that deep-equals a recorded `{event, group}` block but not the fragment's group is replaced at the same index. Its old block goes in `dropped`, the new one in `blocks`.
  - A harness group that matches no recorded block is left as is, with the note `.claude/settings.json: hooks.<event>[<i>] is a harness hook you edited; left as is. harness doctor checks it.` (plan copy).
  - An event that already holds a harness hook gets no new group.
  - `have` keys on `JSON.stringify([command, args ?? null])`.
  - This task declares `type SandboxMode = 'unattended' | 'always' | 'off'` in `config.ts`.
- Produces: `planChanges` ctx gains `recorded?: string[]`, and it passes `sandbox: 'unattended'` until Task 7 passes `config.sandbox`. Settings are written when `blocks.length || dropped.length`. The `update` variant of `Change` gains `dropped?: string[]`.
- Produces: in `update.ts`, `update` passes the settings entry's blocks as `recorded`. A settings block is kept unless it is in `c.dropped`, replacing "always kept".
- Produces: doctor's `EVENTS` adds `ConfigChange`, and `wired` uses `isHarnessHook`. The ok line becomes `settings run the dispatcher for all 6 hook events`.

- [ ] **Step 1: Write the failing tests**
  - `settings.test.ts`:
    - the events are the six in spec section 2;
    - the matchers are verbatim;
    - every hook is `{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.harness/hooks/dispatch.mjs'], timeout }`;
    - `onFailure: 'block'` is on exactly PreToolUse, UserPromptSubmit and ConfigChange;
    - `permissions.deny` `toEqual`s the spec's 30 rules in order.
  - `mergeSettings`:
    - A fresh file gets 6 group blocks, 30 deny blocks and nothing in `dropped`.
    - `a foreign node exec hook survives init, update and uninstall`: a `{ command: 'node', args: ['tools/lint-hook.mjs'] }` PreToolUse group stays at index 0, and the harness group is added after it. It is also kept through the CLI `update` and `uninstall` below.
    - `beta groups are replaced in place`: given the beta fragment's groups and their recorded blocks, each group is replaced at its index, `dropped` holds the five beta blocks, and a user group before PreToolUse keeps index 0.
    - `an edited harness group is left with a note`: a recorded group whose timeout was changed by hand gets the note, no second harness group, and that event's block isn't in `blocks`.
  - CLI:
    - `update replaces the beta hook groups and uninstall is byte-identical`. Init on the current tree, then rewrite `settings.json` and its manifest blocks to the beta fragment, then `update --yes`. The manifest has no beta blocks and has the new ones, and `uninstall --yes` gives the pre-init bytes.
    - `doctor: healthy install` expects `all 6 hook events`.
    - `bad config and unwired event named` still names a missing event.
  - e2e: `the exec-form hook runs from a repo path with a space and ü`. It replaces the shell-form test: `spawnSync(command, args.map((a) => a.replace('${CLAUDE_PROJECT_DIR}', root)))` with no shell gives the protect deny.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.**
- [ ] **Step 5: Commit** `templates/settings.fragment.json src/install/ src/core/config.ts src/cli/update.ts src/cli/doctor.ts test/templates/settings.test.ts test/install/merge.test.ts test/cli/ test/e2e/install.e2e.test.ts`: `feat(install): exec-form hooks with onFailure block, ConfigChange and push deny rules, replaced in place on update`.

### Task 7: `sandbox` config key and the `always` settings blocks

**Files:**
- Modify: `src/core/config.ts` (`sandbox`, rule), `src/core/config-io.ts` (`SECTIONS`), `src/install/plan.ts` (passes `config.sandbox`), `templates/config.example.yaml`, `scripts/gen-config-docs.mjs`, `README.md` (regenerated table), `src/install/merge.ts`, `src/cli/uninstall.ts` (`removeFromSettings`)
- Test: `test/core/config.test.ts`, `test/core/config-io.test.ts`, `test/install/merge.test.ts`, `test/cli/uninstall.test.ts`, `test/cli/update.test.ts`

**Interfaces:**
- Produces: `HarnessConfig.sandbox: SandboxMode`, default `'unattended'`, with rule `oneOf('unattended', 'always', 'off')`.
  - `SECTIONS.sandbox` is `Claude Code's sandbox: required for unattended runs (unattended), on for everyone (always), or not used (off).` (plan copy), placed after `checks`.
  - The README key text is `\`unattended\`: required when nobody watches; \`always\`: on in every session; \`off\`: text checks only.` (plan copy).
- Produces, in `mergeSettings` with `sandbox: 'always'`:
  - When `sandbox` is absent, the object is created and `{"set":["sandbox"],"value":{}}` is recorded (ruling 5).
  - Each of the three keys is added only when absent and recorded as `{"set":["sandbox","<key>"],"value":<v>}`.
  - A key already present with another value is left, with the note `.claude/settings.json: sandbox.<key> is already <v>; left as is (harness would set <w>).` (plan copy).
  - A non-object `sandbox` is a `MergeError`: `"sandbox" must be an object`.
- Produces, with any other mode: each recorded `set` block goes in `dropped`. Its key is deleted when its value deep-equals the recorded one; a changed value is kept, with a note. Blocks are handled deepest path first, so the parent block deletes an object left empty.
- Produces, in `removeFromSettings`: `set` blocks are removed deepest first by deep equality. A changed value gets the note `` `.claude/settings.json`: `sandbox.<key>` was changed; left as is. `` A parent block whose object still holds keys is left without a note.

- [ ] **Step 1: Write the failing tests**
  - Config:
    - `sandbox defaults to unattended`.
    - `sandbox: sometimes` gives `"sandbox" must be one of unattended, always, off`.
    - The example file and the README table are regenerated, and their tests pass.
  - `mergeSettings`:
    - `always adds the sandbox block and records each key`: a file without `sandbox` gets the three keys and four `set` blocks.
    - `always leaves a key the person set, with a note`: `{ sandbox: { autoAllowBashIfSandboxed: true } }` keeps `true`, gets the note and two `set` blocks, and no parent block.
    - `unattended and off add no sandbox key`.
    - `failIfUnavailable is never written`, in all three modes.
    - `leaving always removes the recorded keys`: recorded blocks with mode `unattended` remove the keys and the created parent, and every `set` block is in `dropped`. A changed `enabled: false` stays, with a note, and is still dropped.
  - Uninstall:
    - `init with always then uninstall is byte-identical`, with and without a pre-existing `sandbox: { network: { allowedDomains: ['x'] } }`.
    - `an edited settings file keeps the person's sandbox keys`: after init with `always`, the person adds `sandbox.network`. The `set` blocks are removed, and `sandbox.network` stays.
  - Update:
    - `switching to always and back leaves the settings as before`: init, then `sandbox: always` with `update --yes`, then `sandbox: unattended` with `update --yes`, gives the settings bytes from after init.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test`.**
- [ ] **Step 5: Commit** `src/core/ src/install/merge.ts src/install/plan.ts src/cli/uninstall.ts templates/config.example.yaml scripts/gen-config-docs.mjs README.md test/`: `feat(install): sandbox mode, and the always block recorded as settings blocks`.

### Task 8: `sandbox-required` check

**Files:**
- Create: `src/core/settings-layers.ts`, `src/checks/sandbox-required.ts`
- Modify: `src/hooks/dispatch.ts` (registry, `Ctx`, `dispatch` options), `src/core/state.ts` (`sandboxUnavailableLogged?: true`)
- Test: `test/core/settings-layers.test.ts`, `test/checks/sandbox-required.test.ts`

**Interfaces:**
- Produces: `Ctx` gains `home: string` and `platform: NodeJS.Platform`. `dispatch(raw, checks, env, opts: { home?: string; platform?: NodeJS.Platform } = {})` defaults them to `homedir()` and `process.platform`. Task 9 uses `home`.
- Produces: `type Layer = { name: 'managed' | 'local' | 'project' | 'user'; json: unknown }`.
  - `managedSettingsPath(platform)`, confirmed in step 0:
    - `darwin`: `/Library/Application Support/ClaudeCode/managed-settings.json`;
    - `win32`: `C:\Program Files\ClaudeCode\managed-settings.json`;
    - otherwise `/etc/claude-code/managed-settings.json`.
  - `readSettingsLayers(root, home, platform): Layer[]`, in precedence order managed, local, project, user. A missing or non-JSON file gives `json: null`.
  - `effective(layers: Layer[], path: string[]): unknown`: the first layer that defines the path.
- Produces: `sandboxVerdict(i: { mode: SandboxMode; unattended: boolean; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; layers: Layer[] }): 'allow' | 'unavailable' | 'deny'`. The allow conditions are spec 3.4's, in its order:
  - `win32` gives `'unavailable'`;
  - "confirmed" means `effective(['sandbox','enabled']) === true` and `effective(['sandbox','allowUnsandboxedCommands']) === false`, and on `linux` also `findOnPath('bwrap')` and `findOnPath('socat')`;
  - `HARNESS_SANDBOX === '1'` allows.
- Produces: `sandboxRequired: Check`, with `name: 'sandbox-required'`, `events: ['PreToolUse']` and `failClosed: true`. It isn't `pure`. It sits in the registry after `protect`.
  - It runs only when `isShell(tool_name)`.
  - `'deny'` returns the spec's message with `check: 'sandbox-required'`.
  - `'unavailable'` logs `sandbox-unavailable` once per session through `appendEvent` and the state flag, then allows.

- [ ] **Step 0: Read the docs (free).**
  - Read https://code.claude.com/docs/en/hooks (PreToolUse input) for any field that reports the sandbox or `--settings` (R2). If one exists, stop and report to the controller before writing code; the tests below assume none.
  - Read https://code.claude.com/docs/en/managed-settings and correct the three paths above if they differ.
- [ ] **Step 1: Write the failing tests**
  - `sandboxVerdict`, one test per condition:
    - attended gives allow;
    - `off` gives allow;
    - `win32` gives unavailable;
    - `HARNESS_SANDBOX=1` gives allow, and `HARNESS_SANDBOX=true` doesn't;
    - project `{enabled:true, allowUnsandboxedCommands:false}` on darwin gives allow;
    - the same on linux without `bwrap` on PATH gives deny, and with fake `bwrap` and `socat` executables on PATH gives allow;
    - `enabled: true` without `allowUnsandboxedCommands` gives deny.
  - Precedence:
    - `local sandbox.enabled false beats committed always`: project true, local false, unattended, darwin gives deny;
    - managed true beats local false (allow);
    - user-only true gives allow.
  - The check:
    - unattended Bash, PowerShell and Monitor are each denied with the exact message;
    - an unattended Edit is allowed;
    - two unattended `win32` calls in one session log one `sandbox-unavailable` event.
  - `readSettingsLayers` reads `home/.claude/settings.json` from the injected home and returns null for non-JSON.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.** This is the last task of S5. The perf input is an attended Edit, so the check costs nothing there.
- [ ] **Step 5: Commit** `src/core/settings-layers.ts src/checks/sandbox-required.ts src/hooks/dispatch.ts src/core/state.ts test/core/settings-layers.test.ts test/checks/sandbox-required.test.ts`: `feat(checks): unattended shell commands need Claude Code's sandbox`.

### Task 9: `ConfigChange` blocks changes to harness's own settings

**Files:**
- Create: `src/checks/config-change.ts`, `test/fixtures/hooks/config-change.json`
- Modify: `src/core/harness-files.ts`, `src/core/state.ts`, `src/core/events.ts`, `src/hooks/dispatch.ts` (baseline, notice, registry)
- Test: `test/checks/config-change.test.ts`, `test/hooks/harness-files.test.ts`, `test/hooks/dispatch.test.ts`

**Interfaces:**
- Produces, in `harness-files.ts`:
  - `type GuardedPart = 'hooks' | 'deny' | 'disableAllHooks' | 'sandbox' | 'unreadable'`.
  - `type GuardedView = { hooks: [string, unknown[]][]; deny: string[]; disableAllHooks: unknown; sandbox: unknown } | null`. `hooks` holds the dispatcher groups per event, sorted. `deny` holds the harness rules present, sorted. `null` means the file isn't JSON.
  - `guardedView(text: string | null, deny: Set<string> | null): GuardedView`. An absent file is the empty view.
  - `GUARDED = { user: (home) => join(home, '.claude/settings.json'), project: '.claude/settings.json', local: '.claude/settings.local.json' }`.
  - `guardedViews(root: string, home: string): Record<'user' | 'project' | 'local', GuardedView>`.
  - `guardedDiff(base: GuardedView, cur: GuardedView): GuardedPart[]`. A `null` side gives `['unreadable']`. For `deny`, a part is reported only when a base rule is missing from `cur`. The other parts compare by deep equality.
  - `settingsFingerprint` adds `sandbox` (ruling 3) and is exported with `harnessDenyRules`.
- Produces, in `state.ts`: `guardedBase?: Record<string, GuardedView>` and `pendingNotice?: string`.
- Produces, in `events.ts`: `lastConfigChangeBlocked(root): { ts: string; reason: string } | null`.
- Produces: `configChange: Check`, with `name: 'config-change'`, `events: ['ConfigChange']` and `failClosed: true`.
  - Sources map to files: `user_settings` → user, `project_settings` → project, `local_settings` → local (names confirmed in step 0). Any other source allows.
  - No `guardedBase` blocks (ruling 4).
  - When the parts are empty, it allows.
  - When the file's `settingsFingerprint` equals `readRepoSnapshot(root).cli?.files[rel]`, it allows and the baseline entry is refreshed. This never applies to the user file.
  - Otherwise it blocks:
    - reason `Harness keeps its hooks, its deny rules, disableAllHooks and the sandbox settings as they were when this session started, so this change to \`<file>\` (<parts>) is not applied to the session.` (plan copy);
    - it logs `config-change-blocked` with reason `<file>: <parts joined by ", ">`;
    - it sets `pendingNotice` to `Harness blocked a change to \`<file>\` (<parts>) in this session. The file is still changed on disk, so the next session loads it: review it first.` (plan copy).
- Produces, in `dispatch.ts`:
  - When `!ctx.state.guardedBase` and the event isn't ConfigChange, the dispatcher saves `guardedViews(root, ctx.home)`.
  - On UserPromptSubmit, `pendingNotice` is cleared and joined before the change-detection notice into the one `withNotice` call (`[pending, notice].filter(Boolean).join('\n')`).

- [ ] **Step 0: Read the docs (free).** Read the ConfigChange section of https://code.claude.com/docs/en/hooks (R9). Write `test/fixtures/hooks/config-change.json` with one input per source, using the documented field names and source values. If they aren't `source` and `file_path`, or the values above, use the documented ones in `config-change.ts` and say so in the commit body.
- [ ] **Step 1: Write the failing tests**
  - `guardedView` and `guardedDiff`:
    - a removed dispatcher group gives `['hooks']`;
    - `onFailure` removed from a group gives `['hooks']`;
    - a harness deny rule removed gives `['deny']`;
    - a harness deny rule rewritten narrower (for example `Bash(git push *--force*)` to `Bash(git push --force)`) gives `['deny']`;
    - an added deny rule gives `[]`;
    - a removed deny rule harness didn't install gives `[]`;
    - `disableAllHooks: true` gives `['disableAllHooks']`;
    - any `sandbox` change gives `['sandbox']`;
    - a `permissions.allow` change gives `[]`.
  - The check, through `dispatch` with an injected `home`, from the fixture inputs:
    - A project hook removed is blocked; the event is logged with `.claude/settings.json: hooks` and `pendingNotice` is set.
    - The next UserPromptSubmit's `systemMessage` and `additionalContext` contain the notice, and the prompt after that doesn't.
    - `disableAllHooks` in the user file is blocked.
    - An "Always allow" click in the local file is allowed.
    - Another source (for example `policy_settings`) is allowed.
    - A CLI-recorded change (`stampHarnessFiles` after the write) is allowed, and a later allow-only change to the same file is allowed too.
  - Review Focus tests:
    - `deleting the project settings blocks`, with parts `hooks, deny`;
    - `a non-JSON guarded file blocks as unreadable`;
    - `no baseline blocks`.
  - `the ConfigChange notice and the change-detection notice share one message`.
  - `change detection reports a sandbox change` (fingerprint).
  - The existing harness-files tests pass.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.**
- [ ] **Step 5: Commit** `src/checks/config-change.ts src/core/harness-files.ts src/core/state.ts src/core/events.ts src/hooks/dispatch.ts test/checks/config-change.test.ts test/fixtures/hooks/ test/hooks/`: `feat(hooks): a ConfigChange hook blocks changes to harness's hooks, deny rules, disableAllHooks and sandbox`.

### Task 10: Version floor and the new `doctor` lines

**Files:**
- Modify: `src/core/min-claude.ts`, `.github/workflows/ci.yml:83` (pin `@anthropic-ai/claude-code@2.1.314`), `src/cli/doctor.ts`
- Test: `test/cli/doctor.test.ts`, `test/package/workflows.test.ts` (existing pin test)

**Interfaces:**
- Consumes: `readHookEnv` (Task 1), `isHarnessHook` (Task 6), `readSettingsLayers`/`effective` (Task 8), `lastConfigChangeBlocked` (Task 9), `LEGACY_RESULTS_DIR` and `hasResultsOutput`.
- Produces: `MIN_CLAUDE_CODE = '2.1.314'`, with the comment `// onFailure (2.1.295), Monitor in Bash hooks and the sandbox glob fixes (2.1.314): spec D5.`
- Produces: `DoctorDeps` gains `platform?: NodeJS.Platform`.
- Produces these lines, in order after the wiring line:
  - **Hook-side Node:**
    - `ok hooks run Node <v>`;
    - `fix hooks run Node <v>, older than 22.11: install Node 22.11 or newer where Claude Code finds it` (next step is plan copy);
    - `note no hook has run here yet: start a Claude Code session, send a prompt, then run harness doctor again`.
  - **Dispatcher runs:**
    - The PreToolUse harness hook is spawned as written: `command` plus `args`, with `${CLAUDE_PROJECT_DIR}` replaced by the root, plus `--self-test`, with no shell and a 5 s timeout.
    - Success prints `ok dispatcher runs`. Failure prints `fix the dispatcher does not run (<first stderr line>): check that node is on the PATH Claude Code gives its hooks, then run harness doctor again` (next step is plan copy).
    - An entry with no `args` (shell form) is run with `shell: true`, and also gets `fix \`.claude/settings.json\` runs the dispatcher through a shell: run harness update`.
  - **Hook shape:** `fix <Event> hook has no onFailure "block": run harness update`, for each of PreToolUse, UserPromptSubmit and ConfigChange whose harness hook lacks it.
  - **Sandbox:**
    - `ok sandbox: unattended (required for unattended runs)`;
    - `ok sandbox: always (on in every session)` and `ok sandbox: off (text checks only)` (both plan copy);
    - on `win32`, `note no sandbox on native Windows: hooks, permission rules and text checks only`;
    - on `linux` without `bwrap` or `socat`, `the Linux sandbox needs bwrap and socat (missing: <names>): install them` (plan copy) as a `note` under `unattended` and a `fix` under `always`.
  - **Results path:** `fix <where> writes test results under .harness/state, which the sandbox denies: run harness update`, for each package where `hasResultsOutput(p, root, LEGACY_RESULTS_DIR)`.
  - **ConfigChange:** `note harness blocked a settings change at <ts> (<reason>): review the file before the next session` (plan copy).

- [ ] **Step 1: Write the failing tests** (doctor tests default PATH to `dirname(process.execPath)`, so `node` is found):
  - `claude 2.1.313 is a fix and exit 1; 2.1.314 is ok`.
  - Hook-side Node:
    - a `hook-env.json` with `v22.10.0` gives the fix;
    - `process.version` gives ok;
    - a missing file gives the note and still exits 0 on an otherwise healthy install.
  - `doctor self-test runs from a path with a space and ü`: ok on a healthy install built under `PREFIX`.
  - `a dispatcher that cannot run is a fix`: with `dispatch.mjs` replaced by `process.exit(3)` (and its manifest hash updated), the fix line shows.
  - `a shell-form entry is a fix`.
  - `a hook without onFailure is a fix`: delete it from UserPromptSubmit.
  - Sandbox:
    - with `platform: 'win32'`, the note shows;
    - with `platform: 'linux'` and no `bwrap` on PATH, it is a note under `unattended`, and a fix with exit 1 under `always`.
  - `a package still writing under .harness/state is a fix`.
  - `the last blocked settings change is a note`.
  - The workflows pin test passes with `2.1.314`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** The doctor test helper gives every healthy-install test a `hook-env.json` unless the test removes it.
- [ ] **Step 4: Run `pnpm typecheck && pnpm test`.**
- [ ] **Step 5: Commit** `src/core/min-claude.ts .github/workflows/ci.yml src/cli/doctor.ts test/cli/doctor.test.ts test/package/workflows.test.ts`: `feat(doctor): Claude Code 2.1.314 floor, hook Node, dispatcher self-test, hook shape, sandbox and results path checks`.

### Task 11: `status` enforcement lines

**Files:**
- Modify: `src/cli/status.ts`
- Test: `test/cli/status.test.ts`

**Interfaces:**
- Consumes: `readHookEnv`, `lastConfigChangeBlocked`, `config.sandbox`.
- Produces `status(args, cli, deps: { platform?: NodeJS.Platform } = {})`, which prints after the gates:
  - `Enforcement: sandbox <mode> (<macOS: available | Linux: available | WSL2: available | native Windows: not available>)`. WSL2 is `linux` with `cli.env.WSL_DISTRO_NAME` set (ruling 11).
  - `Hook failure: blocks tool calls and prompts; the Stop gate fails open`.
  - `Hooks run Node <v> (<ts>)`, or `Hooks run Node: not recorded yet`.
  - `Last blocked settings change: <ts> (<reason>)`, only when there is one (plan copy).

- [ ] **Step 1: Write the failing tests**
  - `status shows the sandbox mode per platform`: darwin `unattended`, linux with `WSL_DISTRO_NAME` and `always`, and win32.
  - `status shows the hook failure line`.
  - `status shows the hook Node or not recorded yet`.
  - `status shows the last blocked settings change`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.** This is the last task of S7.
- [ ] **Step 5: Commit** `src/cli/status.ts test/cli/status.test.ts`: `feat(status): enforcement, hook failure and hook Node lines`.

### Task 12: Upgrade e2e: an old install through update and uninstall

**Files:**
- Create: `scripts/old-install-fixtures.mjs`, `test/fixtures/old-install/*.json`, `test/e2e/upgrade.e2e.test.ts`
- Modify: `test/install/helpers.ts` (`withPrettier` moved here), `test/install/format.test.ts` (imports it)

**Interfaces:**
- Produces: `node scripts/old-install-fixtures.mjs --beta <scratch>/beta --sha <sha>`.
  - It builds each fixture repo with `makeRepo` and runs `node <beta>/dist/cli.mjs init --yes` in it, with `CI`, `HARNESS_UNATTENDED`, `CLAUDE_CODE_REMOTE` and `CLAUDECODE` unset.
  - For the Jest config form, it then applies the printed manual lines, as a person would.
  - It writes `{ beta: <sha>, before: {rel: text}, installed: {rel: text} }` per fixture, skipping `.git`.
  - `.harness/hooks/dispatch.mjs` is replaced by `// beta dispatcher (placeholder)\n`, and the generator updates its manifest hash with the `hashText` algorithm.
- Fixtures (spec 12):
  1. `vitest-inline`: `defineConfig({ test: {} })`.
  2. `vitest-multiline`: a multi-line `test` object.
  3. `vitest-prettier`: the fake Prettier, so the beta recorded `formatted` hunks.
  4. `jest-script`: `"test": "jest"`.
  5. `jest-config`: a `jest.config.js` that sets `reporters`, so init printed manual lines.
  6. `existing-sandbox`: settings with `sandbox: { network: { allowedDomains: ['registry.npmjs.org'] } }`.
- The test runs each fixture in this order:
  1. Write `before`, commit. Write `installed`, commit.
  2. Run `update --yes` (the current CLI), then commit.
  3. Assertions:
     - the exit code is 0;
     - the settings hold the six exec-form groups and no beta group;
     - `.gitignore` has `.harness/results/`;
     - the config says `results_dir: .harness/results`;
     - every results path in a test config is under `.harness/results`;
     - `.harness/state/test-results/` is untouched when present.
  4. Pipe a UserPromptSubmit and an Edit into the installed dispatcher: it writes `hook-env.json`, and protect denies the Edit on `.harness/config.yaml`.
  5. `doctor` with a fake `claude` on PATH printing `2.1.313 (Claude Code)` (a shell script on POSIX, `claude.cmd` on Windows) prints `fix Claude Code 2.1.313 is older than 2.1.314: update Claude Code` and exits 1. With `2.1.314` that line is `ok`.
  6. Repeat with `sandbox: always` set in the config, then `update --yes`.
  7. `uninstall --yes`. `walk(root)` equals `before` byte for byte, for both modes.

- [ ] **Step 1: Generate the fixtures** from the beta build kept in "Before Task 1", then read each JSON. Its `installed` must hold the beta fragment and the old results path. Commit nothing yet.
- [ ] **Step 2: Write `test/e2e/upgrade.e2e.test.ts`** with one `test.each` over the fixtures and the two modes.
- [ ] **Step 3: Run `pnpm vitest run --project e2e test/e2e/upgrade.e2e.test.ts`.** A failure is a bug in the owning task (5, 6, 7 or 10). Fix it there, on that slice's branch, and restack.
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.** This is the last task of S8.
- [ ] **Step 5: Commit** `scripts/old-install-fixtures.mjs test/fixtures/old-install/ test/e2e/upgrade.e2e.test.ts test/install/helpers.ts test/install/format.test.ts`: `test(e2e): beta installs migrate through update and uninstall byte-identical`.

### Task 13: README

**Files:**
- Modify: `README.md`, `test/package/readme.test.ts`

**Interfaces:**
- README changes (spec section 9):
  - The top line, verbatim from spec 9.
  - "Unattended runs and CI" gains the launch command and what `HARNESS_SANDBOX=1` asserts.
  - New sections "Windows", "Force push" and "Managed settings (optional)". The managed snippet has `sandbox.enabled: true` and `allowUnsandboxedCommands: false`, gives the three paths from Task 8, and says why harness hooks are left out.
  - The "fails closed" wording (CON-1) says the Stop gate fails open if its process can't run.
  - "Known limits" gains spec section 11's seven lines, verbatim.
  - Until live check 7 passes, a line says the PowerShell rules are unverified (R6).
  - Until live check 8 passes, a line says to turn on `/sandbox` before the session (ruling 10).
- `readme.test.ts` gains:
  - `README carries the platform enforcement known limits, verbatim` (spec section 11 lines);
  - `README carries the unattended launch command` (the spec 3.4 command, verbatim);
  - `README carries the enforcement line` (spec 9, first bullet's quote).

- [ ] **Step 0: Read the changelog (free)** for what Claude Code before 2.1.295 does with `onFailure` (R8). If old versions drop the hook entry, the README says so in "Requirements".
- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run `pnpm vitest run test/package/readme.test.ts` and confirm they fail.**
- [ ] **Step 3: Write the README changes.**
- [ ] **Step 4: Run `pnpm typecheck && pnpm test && pnpm test:perf`.**
- [ ] **Step 5: Commit** `README.md test/package/readme.test.ts`: `docs: platform enforcement in the README: sandbox, Windows, force push, managed settings and known limits`.

### Task 14: Live checks (needs owner approval before running)

**Paid: it runs real Claude Code sessions.** No step here runs until the owner approves this batch in chat. It runs once, after S1 to S9 pass offline, in a scratch repo under the scratchpad that is never pushed. It runs the spec's section 12 list as one batch. Results go to the controller; this task commits nothing.

- [ ] **Step 1: Ask the owner for approval.** Name the seven checks, the optional eighth, and the machine. Wait for a clear yes.
- [ ] **Step 2: Run the spec's live checks 1 to 7** as written in spec section 12. Record for each: the command, Claude Code's version, the observed result, and the risk it settles (R1, R3, R4, R5, R6, R7, R10).
- [ ] **Step 3: Optional check 8, only if the owner approves it with the batch.** In an interactive session under `unattended`, run `/sandbox` and record whether it writes a settings file and whether `config-change` blocks it (ruling 10).
- [ ] **Step 4: Report** each result against spec section 13's "How the build confirms it" column. Apply each fallback there in the owning slice:
  - R3: explicit `denyRead`/`denyWrite` in the launch JSON and the `always` block;
  - R4: `chmod` stays a known limit;
  - R5: `isShell` already takes both names;
  - R7: the shell form with `onFailure`.
  - Then re-run the offline suite.

## Owner actions this plan depends on

- Merge #8, #9, #10, #11 and this plan's PR before S1.
- Push each slice's branch after its gate passes, and merge them in order S1 to S9.
- Approve Task 14's batch (and say whether check 8 is in it).
- Rule on any plan ruling above you read differently, before the task that owns it.
