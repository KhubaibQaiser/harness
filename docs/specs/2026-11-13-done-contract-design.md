# Done contract: design

Status: draft for the owner's review, 2026-11-13.

Research behind it:
- [Anthropic docs](../research/2026-11-13-done-contract-anthropic.md)
- [industry practice](../research/2026-11-13-done-contract-industry.md)
- [where the verdict lives](../research/2026-11-13-done-contract-verdict.md)

The owner interview log is at `.superpowers/sdd/done-contract/decisions.md` (local, not committed).

## 1. Goal

When an agent says a task is done, that claim must be true, in attended sessions and in unattended and cloud runs alike. "Done" is a verdict that harness computes from evidence the agent can't fake, bound to the exact commit. It is never the agent's own word.

Success:
- A false done claim is caught in the session.
- An unattended run with a false done fails visibly in CI.
- The false-done rate is a number in `harness report`.

## 2. What the research settled

Each point is cited in the research files.

1. **The one who did the work doesn't certify it.** Sources: NIST SP 800-53r5 CA-2(1), AC-5 and CM-5(4); SLSA "not by a tenant"; Copilot's coding agent "cannot approve or merge"; Claude Code Review "never approves or blocks".
2. **Agents game any grader they can reach.** METR, OpenAI's chain-of-thought monitoring paper, ImpossibleBench, and Anthropic system cards from 3.7 to Opus 5.5 all report it: special-cased tests, edited tests, hidden changes. Evidence and criteria must be out of the agent's reach, and fixed before work starts.
3. **Claude Code's Stop hook fails open.** A crash, a timeout or an unexpected exit lets the agent stop, and `onFailure: "block"` has no effect on Stop. After 8 consecutive blocks with no tool call between them, Claude Code ends the turn anyway (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). So Stop can catch problems early, but it can never be the verdict.
4. **The transcript format is internal and can change.** Evidence comes from harness's own PostToolUse and PostToolUseFailure records; failure records carry `Exit code N`. The Stop input carries `last_assistant_message`.
5. **"Success" from the Agent SDK or `-p` means the run ended without an error, not that the task is done.**
6. **Cloud and multi-repo sessions skip some hooks,** so the unattended verdict can't depend on in-session hooks.
7. **Fail-closed has to be configured.** A skipped GitHub job reports "Success". A verdict is valid for one commit only.
8. **An honest "can't finish" exit reduces cheating** (ImpossibleBench).

## 3. Owner decisions

1. Done covers four things, all enforced:
   - checks green and fresh;
   - acceptance criteria met;
   - claims backed by evidence;
   - independent review passed.
2. The verdict is layered:
   - Stop never decides.
   - `harness verify` decides attended runs.
   - CI decides unattended and cloud runs, as a required check that fails on skip and that the agent can't edit.
   - A person merges.
3. Criteria are written before work starts, then locked. The agent may draft them and the person approves. Unattended runs need approved criteria in advance.
4. The independent review is a fresh-context subagent, backed by code-based evidence checks. It runs on Sonnet by default. A review that can't run fails the run.
5. There is a sanctioned blocked status: `harness done --blocked "<reason>"`.
6. A false claim in an attended session blocks Stop and names the gap.
7. On by default for new installs. Existing installs get it through `/harness:update`. Unattended runs without criteria fail.
8. Approach C, hybrid: CI and cloud runs re-run everything; attended verify reuses fresh evidence that hooks recorded and re-runs the rest.
9. No skip hatch. Every task that edits files needs an approved contract.

## 4. Components

### 4.1 Task contract: `.harness/tasks/<id>.json`

Fields:
- `id`, `title`
- `base`: the base commit sha at approval
- `approved_by`: `person`
- `approved_at`
- `criteria[]`: each one is `{ id, text, check }`, where `check` is one of:
  - `{ test: "<test id or file::name>" }`, which must pass;
  - `{ run: "<command>", expect_exit: 0 }`;
  - `{ person: "<what to check by hand>" }`, which never passes automatically and lists as a human step.
- `checks[]`: the required checks. The default comes from `stop.steps`: test, type check, lint, build.
- `review`: `{ model: "sonnet" }`, configurable per contract.
- `sha256`: the contract's own hash, recorded in `.harness/state/task-hashes.json` at approval.

It extends today's `features.json` spec gate. Existing `features.json` criteria are read as criteria with a `test` check.

Rules:
- **Agent draft:** `harness task draft` writes `.harness/tmp/<w>/task.json`, a work folder the agent can write, with `approved_by: null`.
- **Approval:** `! harness task approve <file>` is person-only (the guard denies it from the agent, as `tdd off` is). It validates the file, shows the criteria, and asks for a yes. It then copies the file into `.harness/tasks/` and records the hash.
- **Lock:** after approval, `.harness/tasks/**` is protected three ways: protect's deny tables, the `Edit(./.harness/tasks/**)` deny rule, and the sandbox's `denyWrite`. Only `! harness task edit|approve|close` change a contract, and each needs a person's yes.
- **Committed:** contracts are committed, so CI can read them from the base branch.
- **Active task:** one active task per session, kept in `.harness/state/active-task`. A session's first edit is denied while no approved contract is active, with the message "Draft criteria: run harness task draft, then ask the person to approve".

### 4.2 Evidence ledger: `.harness/state/evidence.jsonl`

- Written only by harness's PostToolUse and PostToolUseFailure hooks, for each Bash call whose command matches a check or criterion `run`, or a known test runner.
- A row: `{ ts, session, command, exit, tree, contract, criteria: [ids] }`.
- `tree` is the working-tree hash at that moment: `git write-tree` over a temp index that includes untracked, non-ignored files. Agent-controlled environment variables are ignored, as in the secret scan.
- Protected like state: protect, the Edit deny rule and the sandbox's `denyWrite`.
- Freshness: a row counts only if its `tree` equals the current tree hash.

### 4.3 Claim checker (inside the Stop gate)

- Reads `last_assistant_message` from the Stop input.
- Done-type claims are a fixed phrase list: done, finished, complete, fixed, resolved, all tests pass, tests are green, verified, works now, ready to merge.
- It ignores negations and future tense: "not done", "will be done", "isn't fixed yet", "once tests pass".
- If a claim matches and some criterion or check has no fresh passing ledger row, Stop blocks, naming each gap: `You said "<claim>", but <check> has not passed since your last edit (criterion C2). Run it, or end with harness done --blocked "<reason>".`
- It respects `stop_hook_active` and harness's own `stop.max_attempts`.
- It never decides done, because Stop can fail open. Every block is logged as a `false-done-claim` event.

### 4.4 `harness verify [--ci] [--task <id>]`: the verdict

- Runs as a separate process.
- Attended: run by the person, or by the `/harness:verify` skill.
- CI: run by the `harness-verify` workflow. The `--ci` flag is set automatically when unattended.

Steps, all fail-closed:
1. **Load the contract.**
   - `--ci` reads it from the base branch (`git show <base>:.harness/tasks/<id>.json`), never from the PR. Its hash must match.
   - Attended reads the active contract, and its hash must match the recorded one.
2. **Tamper check over the diff from `base`.** It runs the existing TDD tamper rules: skips, removed assertions, lowered thresholds, test selection changes. It also checks that the contract and protected files are unchanged. Any finding is not done.
3. **Evidence.** For each criterion and check:
   - Attended: reuse a fresh ledger row that the hooks recorded, and re-run anything missing or stale.
   - `--ci`: always re-run everything.

   Commands run through the existing stop-step runner, with time limits. `person` criteria are listed, never auto-passed.
4. **Review.**
   - Inputs: staff-reviewer in task mode gets the contract, the diff, and an evidence summary, fenced as data, as in M2a.
   - Questions it answers:
     - Does each criterion's evidence really test it?
     - Is there unrequested scope?
     - Was anything weakened?
   - Checks on its findings: code checks verify each finding's quote, as M2a's `verify.ts` does, and a judge then drops findings without evidence.
   - Outcome: a surviving critical finding means not done. A review that can't run (no key, timeout, malformed output) means not done, never skipped.
5. **Verdict.** It writes `.harness/verdicts/<commit>.json`, holding the commit, tree, contract hash, each criterion with its evidence (command, exit code, time, reused or re-run), the review findings, the person items, and the outcome.
   - Exit codes: 0 is done, 1 is not done, 3 is blocked, 2 is a usage error.
   - The verdict is valid only for that commit and tree.
   - In CI it is also uploaded as a build artifact, with a job summary.

### 4.5 Blocked: `harness done --blocked "<reason>"`

- The agent may run it.
- It records `{ task, reason, failing_criteria }` in the ledger.
- Verify then exits 3, blocked, with the reason, instead of 1.
- Blocked counts as an honest not-done in the metrics and is never a pass.
- It can't be used to skip the tamper check: tamper findings still make the outcome not done.

### 4.6 Shipping gates (existing checks extended)

- **`gh pr create` / `gh pr new`:**
  - denied unless `.harness/verdicts/<HEAD>.json` exists with outcome done, or blocked with the `needs-human` label;
  - the pr-ship body's "How to verify" section is filled from the verdict.
- **Merge:** `gh pr merge --auto` stays denied.

### 4.7 `harness-verify` CI item (kind: ci)

- Writes `.github/workflows/harness-verify.yml`.
- Runs on every `pull_request`, with no path filters.
- The job checks out the PR head with full history, installs harness at the pinned version, and runs `harness verify --ci`.
- Its permissions are `contents: read` only, and actions are pinned by sha, as in the existing CI items.
- The review uses the repo's `ANTHROPIC_API_KEY` secret. A missing key fails the job.
- The workflow file is protected: protect, Edit deny and `denyWrite`.
- The docs give the branch-protection steps: require the check, and require an up-to-date branch. A skipped job counts as passing on GitHub, so the workflow has no `if:` or path filters that could skip it.

## 5. Flows

**Attended:**
1. The first edit is denied while no contract is active.
2. The agent drafts a contract, and the person approves it with `!`.
3. The agent works. Hooks fill the ledger.
4. A done claim with gaps blocks Stop.
5. The agent or the person runs `harness verify` and gets a verdict.
6. `gh pr create` needs a done or blocked verdict.
7. The person merges.

**Unattended and cloud:**
1. An approved contract must already be on the base branch, or the first edit is denied and the run ends not-done.
2. Work and Stop behave as in attended runs.
3. The CI check re-runs everything from the base contract.
4. A person merges.

The run's success is the CI check, never the agent's exit or `subtype: success`.

## 6. Metrics (`harness report`)

All counts only:
- false-done claims;
- verify outcomes;
- tamper denies;
- contract edit attempts;
- blocked reasons, grouped;
- reused vs re-run evidence.

Headline: the **false-done rate**, blocked claims divided by all done claims.

## 7. Failure handling

- **Fail closed** for everything in verify and CI: crashes, git errors, an unreadable contract, a hash mismatch, a review that can't run, a run that times out, and a stale or missing ledger in `--ci`.
- **Fail open, and harmless:** only the Stop gate, by Claude Code's design. Stop never decides.
- **Ledger write fails:** the evidence is simply missing, so verify re-runs the check.

## 8. Known limits (to document)

- A person can merge without the check, or turn the check off.
- Repos without CI get only the attended verdict.
- In-session hooks don't run in setups that skip them, but CI still decides.
- Without the sandbox, the ledger and contracts rely on text guards plus the Edit deny rules.
- The claim checker is a phrase match. A claim worded outside the list isn't caught at Stop, though verify still decides.
- The review is a model and can miss things. The code checks and the judge only drop findings; they don't prove correctness.
- Not in scope:
  - signed attestations: Sigstore and in-toto are a later add-on;
  - mutation testing;
  - multi-agent consensus.

## 9. Testing

- **Unit:**
  - contract validation and lock;
  - ledger tree-hash freshness;
  - the claim phrase list with its negation false positives;
  - verify's step order and fail-closed paths;
  - the verdict commit binding;
  - blocked handling;
  - the `gh pr create` gate.
- **End to end:** temp repos, stub model replies, no network. Cases:
  - a passing task;
  - each criterion failing;
  - a stale pass;
  - weakened tests;
  - an edited contract;
  - blocked;
  - a review that fails or times out;
  - `--ci` ignoring the ledger;
  - `--ci` reading the base contract, not the PR's.
- **Workflow:** no path filters, no `if:`, pinned actions, least privilege.
- **Live, under the owner's live-batch pre-approval:**
  - attended: a false "done" is stopped, and verify passes after a real fix;
  - unattended `-p`: CI rejects a false done.

## 10. PR plan (sizes are estimates)

1. Contract format, `harness task draft|approve|edit|close`, the lock, and the active task.
2. The evidence ledger and tree hash.
3. The claim checker in Stop.
4. `harness verify`, attended path, without the review.
5. The review task mode and its judge, reusing M2a.
6. The `--ci` path and the `harness-verify` CI item.
7. The shipping gates, the pr-ship verdict fill, blocked, metrics, docs, and the rollout defaults.
