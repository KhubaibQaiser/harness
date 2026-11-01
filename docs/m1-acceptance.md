# M1 acceptance: fitness-app

Install target: worktree `fitness-app-harness`, branch `chore/harness-m1` from `main` at `1abeef7`. Harness at `91f4780`.

## Install (2026-11-01)

- `scripts/install-local.mjs --dry-run`: shown to the owner and approved, then run for real.
- Config: owner-approved `tdd.paths` (the plan list plus `packages/contracts/src/**` and `apps/web/src/**/*.ts`), `unattended.multi_file_gate: allow-log`, `require_reason: true`. Stop steps match the old `stop-check.mjs`.
- Test results: every Vitest config writes JSON to `.harness/state/test-results/`. Jest in `apps/mobile` does the same through `--json --outputFile`. The test scripts in TDD paths run with `--coverage`.
- `.harness/` was added to the ESLint ignores and `.prettierignore`, because the bundled hook and config are owned by the installer.
- Stop steps on the worktree: `format:check`, `lint`, `typecheck` and `test` all pass. A cold `pnpm test` took about 55 s, against a 540 s budget.

## Gate checks: simulated hook inputs

These were run by piping hook JSON into the installed `.harness/hooks/dispatch.mjs`, using real repo files. **This is not a live Claude Code session yet.**

| # | Action | Expected | Result |
|---|--------|----------|--------|
| 1 | Edit `packages/core/src/money/money.ts`, no failing test | deny | deny, "Write a failing test first" |
| 2 | Add a failing case to `money.test.ts`, run vitest, edit `money.ts` | allow | allow |
| 3 | Edit `docs/roadmap.md` as the second file in the turn | ask once | ask, lists the touched file and the next one |
| 4 | Unattended: second file, unreadable transcript | allow (fail open) | allow, logged |
| 5 | Unattended: second file, transcript with no reason | deny once | deny, "State why each extra file is necessary" |
| 6 | Unattended: second file, transcript has "docs/c.md because …" | allow | allow, logged with the reason |
| 7 | Agent runs `env -u CLAUDECODE pnpm exec harness tdd off` | deny | deny, "Only a person can pause TDD" |
| 8 | `harness stats --days 1` | counts the above | red-first deny 1, multi-file ask 1, reason-required 1, allow-log 2, guard deny 1 |

The temporary failing test was reverted. The simulation events were moved out of `.harness/logs` so the week starts from zero.

## Still to do

- [ ] One live attended Claude Code session in the worktree that repeats checks 1–3 and 7.
- [ ] One live unattended run (`HARNESS_UNATTENDED=1 claude -p …`) to check that the transcript has the agent's reason before PreToolUse fires (the flush-timing question).
- [ ] A week of real work (Task 19): gates fire correctly, `harness stats` shows blocks and overrides, and every false block gets fixed.

## Observed

- The red-first message says "No test for money.ts" even though `money.test.ts` exists. It means there is no fresh failing result. The wording could mislead, so it is a candidate fix.
