# Team decisions: design spec

- Status: owner-approved design, 2026-11-03. The owner decisions are in section 1; section 14 records the owner's rulings on the conflicts the first draft raised. None is open.
- Date: 2026-11-03
- Owner: khubaibqaiser
- Inputs: [`../research/2026-11-03-memory.md`](../research/2026-11-03-memory.md) (design B; cited as "R"), [`2026-11-03-platform-enforcement-design.md`](2026-11-03-platform-enforcement-design.md) ("PE"), [`2026-11-02-harness-recommend-design.md`](2026-11-02-harness-recommend-design.md) ("M3"), `2026-11-03-pr-size-design.md` on `docs/pr-size-spec`, and the code on `feature/pe-7-doctor-status`: `templates/agents-block.md`, `src/install/merge.ts` (`mergeAgents`), `src/checks/guard.ts` (`PERSON_ONLY`), `src/checks/protect.ts`, `src/checks/stop/gate.ts`, `src/checks/multi-file.ts` (`readTranscript`), `src/core/harness-files.ts`, `src/install/manifest.ts`, `src/cli/uninstall.ts`, `src/core/unattended.ts`.
- Builds on: PE (`isShell`, exec-form hooks, sandbox modes) and M3. When: after M3 (R: research, owner input, spec, plan, build).

## 1. Owner decisions (2026-11-03)

| # | Decision |
|---|---|
| D1 | **Scope:** team-shared decisions only. Personal memory stays in Claude Code's auto memory. Harness never reads the home folder for memory and leaves auto memory alone. The one narrow exception: the quote check (7.1) reads the current session's transcript, only to compare the draft against it; nothing from it is stored or copied (C2). |
| D2 | **Location:** `docs/decisions/`, one file per decision. Frontmatter links it to repo paths. |
| D3 | **Loading:** generated `.claude/rules/` files, one per decision, that Claude Code loads when linked paths are touched. AGENTS.md gets one pointer line. The cap is configurable, default 20 lines. |
| D4 | **Writers:** the agent drafts through `harness remember`; the guard asks the person for each write (denied when unattended); the PR reviews it. |
| D5 | **Capture:** a Stop nudge on cheap signals, no model call. A note, never a block. |
| D6 | **Staleness:** git checks (dead linked paths; linked files changed since `verified_at`) and a 90-day expiry unless re-confirmed (`harness remember confirm <id>`). |
| D7 | **Enforcement:** `doctor` lists stale, expired and oversized decisions. Stop warns, never blocks. |
| D8 | **Unattended runs:** no writes; candidates are logged only. |
| D9 | **Untrusted input:** `remember` refuses a draft that quotes tool output, PR text or web content unless the person confirms. Drafts are secret-scanned. |
| D10 | **Reviewer memory:** deferred until the M2 reviewer ships. |
| D11 | **`product.md`:** kept separate. |

## 2. Scope

In: the decision file format and its validation; rule generation and sync; the `harness remember` CLI; guard, protect and change-detection changes; the Stop nudge and Stop warning; `doctor` and `status` lines; config keys; the AGENTS.md pointer line; tests.

Out: section 13.

## 3. Decision files

### 3.1 Path and id

- `docs/decisions/<id>.md`. `<id>` is `YYYY-MM-DD-<slug>`: the UTC date of `add`, then the title lowercased, each run of non-`[a-z0-9]` characters turned into `-`, trimmed of `-`, cut to 40 characters. If the file exists, `-2`, `-3`… is appended. Dated ids avoid the number clashes that `NNNN` ids get on parallel branches; the repo's own docs use the same form.
- Only files whose frontmatter has `schema: harness-decision/1` are decisions. Other files in the folder (an existing ADR set, a README) are ignored by every part of this spec except protect's "new file" rule (section 6.2).

### 3.2 Frontmatter

```markdown
---
schema: harness-decision/1
id: 2026-11-03-validate-env-with-zod
title: Validate env with zod
status: active
paths:
  - "src/env/**"
  - "src/config.ts"
verified_at: 4f0c2a9e1b7d3c5a6e8f0a1b2c3d4e5f6a7b8c9d
verified_on: 2026-11-03
---
**Rule:** Parse every environment variable through `src/env/schema.ts`; never read `process.env` elsewhere.

**Why:** Two outages came from typos in env names that nothing checked.
```

| Key | Rule |
|---|---|
| `schema` | exactly `harness-decision/1` |
| `id` | equals the file name without `.md`; matches `^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,40}(-\d+)?$`; unique in the folder |
| `title` | string, 1 to 80 characters, one line |
| `status` | one of `active`, `superseded`, `retired` |
| `superseded_by` | required when `status` is `superseded`, forbidden otherwise; the id of an existing decision |
| `paths` | 1 to 10 strings. Each is a repo-relative POSIX glob (picomatch, `dot: true`, as `matches` in `src/core/paths.ts`): no leading `/` or `./`, no `..` segment, no `\`, and not `*`, `**` or `**/*` (O1). At `add` and `confirm` each must match at least one file in `git ls-files` |
| `verified_at` | a 40-character lowercase hex commit sha |
| `verified_on` | an ISO date (`YYYY-MM-DD`), not in the future |

- Unknown keys are errors. The frontmatter is parsed with the `yaml` package harness already uses.
- The body is free Markdown. `add` writes it as the **Rule:** and **Why:** paragraphs above; a person may edit it by hand.
- **Validation** runs in `remember add|confirm|retire|sync|check`, `doctor` and `status` (count only). One message per error: `docs/decisions/<file>: <key> <must be …>`. An invalid decision gets no rule; `check` and `doctor` report it.

## 4. Rule generation

### 4.1 Output

One file per active, unexpired, valid decision: `.claude/rules/harness-decision-<id>.md`. Flat names, so no subdirectory loading is assumed (R4).

```markdown
---
paths:
  - "src/env/**"
  - "src/config.ts"
---
<!-- Generated by harness from docs/decisions/2026-11-03-validate-env-with-zod.md. Change it with harness remember, not here. -->
# Team decision: Validate env with zod

**Rule:** Parse every environment variable through `src/env/schema.ts`; never read `process.env` elsewhere.

**Why:** Two outages came from typos in env names that nothing checked.

Source: `docs/decisions/2026-11-03-validate-env-with-zod.md`, confirmed 2026-11-03 at `4f0c2a9`.
```

- `paths` is the only frontmatter key Claude Code reads in a rule (R, Claude Code section); harness writes nothing else there. Globs are double-quoted YAML strings.
- LF line ends and a final newline, so the bytes and hashes match on every OS (as `plan.ts` does for templates).

### 4.2 The cap (`decisions.max_lines`, default 20)

The cap limits the **content lines of one generated rule file**: every line after the closing `---` of its frontmatter, including the header, the generated comment and the `Source:` line. That is the text Claude Code adds to context when the rule loads. There is no always-loaded index (C1).

Generated decision rules count toward harness's always-loaded context budget only when they have no `paths`; path-scoped rules load on demand. The context-budget spec owns that budget and its 2,000-token default (an owner decision). Every decision needs `paths` (3.2, O1), so today no generated rule counts toward it.

- `add` refuses a draft whose rule would exceed the cap: `harness remember: the rule would be <n> lines; the cap is <cap> (decisions.max_lines). Shorten --rule or --why.`
- A hand-edited decision whose rule would exceed the cap is **oversized**. Its rule keeps the first `cap - 1` lines, then `Cut to <cap> lines: read docs/decisions/<id>.md for the rest.` `doctor` and `check` report it (section 9).

### 4.3 Sync

`sync(root)` in `src/core/decisions.ts` computes the wanted rule set from `docs/decisions/` and makes `.claude/rules/harness-decision-*.md` match it: writes new or changed rules, deletes rules whose decision is gone, invalid, not `active` or expired. It runs inside `remember add`, `confirm`, `retire` and `sync`, as one transaction with the decision write (the installer's `apply` with its backup and rollback).

- A rule file that matches `harness-decision-*.md` but is not in the manifest (a person's own file) is never overwritten or deleted; sync stops with `harness remember: .claude/rules/<file> is not harness's; rename it`.
- **Out of sync** = the files on disk differ from what sync would write. `check`, `doctor`, `status` and the Stop warning report it. The usual causes: a person edited a decision by hand, or a decision expired.
- M3's `harness sync` (drift between config, manifest and files) also runs this sync.

### 4.4 Manifest and uninstall

- Each generated rule is a manifest entry `{ rel, kind: "create", hash }`, the shape `init` uses for created files today. Sync adds, rehashes and removes entries; the manifest write is recorded with the CLI snapshot (`harness-files.ts`) so change detection doesn't report it.
- Entries are sorted by `rel`. When two branches each add a decision, `.harness/manifest.json` conflicts in git (C6). The fix is to take either side and run `harness remember sync`, which rebuilds the rule entries from the files.
- `uninstall` removes the rule files by the existing rules: deleted when the hash matches; kept with the "you edited them" line otherwise (`--force` removes them). An emptied `.claude/rules/` is removed by the existing `rmdir` walk.
- `uninstall` leaves `docs/decisions/` alone: decisions are the team's content, not harness's, and are never in the manifest. So `init` → `remember add` → `uninstall` is byte-identical to before `init` for every harness-written file, and leaves the decision files (C7).

### 4.5 AGENTS.md pointer

`templates/agents-block.md` gains, under "Protected paths":

```markdown
- Team decisions live in `docs/decisions/` and load as `.claude/rules/harness-decision-*.md` when you touch their paths. Change them only with `harness remember` (`harness remember --help`); personal preferences go in Claude Code's auto memory.
```

And the protected-paths line becomes: "Never edit `.harness/`, `.claude/settings*.json`, `.claude/rules/harness-decision-*.md` or harness decisions in `docs/decisions/`." The block is installed by `mergeAgents` as today, so `update` and `uninstall` need no change. It stays under the 60-line limit (2026-10-30 §6).

## 5. `harness remember` CLI

`src/cli/remember.ts`, routed from `src/cli/index.ts`. The usage line joins `USAGE`.

```
harness remember add --title <text> --rule <text> [--why <text>] --path <glob> [--path <glob>…] [--supersedes <id>] [--quoted] [--dry-run] [--yes]
harness remember confirm <id> [--dry-run] [--yes]
harness remember retire <id> [--by <id>] [--dry-run] [--yes]
harness remember sync [--dry-run] [--yes]
harness remember list
harness remember check
```

| Subcommand | Does | Guard (section 6.1) |
|---|---|---|
| `add` | Validates, writes `docs/decisions/<id>.md` with `verified_at` = `HEAD`, `verified_on` = today; with `--supersedes`, sets that one to `superseded` with `superseded_by`; syncs | ask |
| `confirm <id>` | Re-checks the paths (each must match a tracked file), sets `verified_at` = `HEAD` and `verified_on` = today; syncs | ask |
| `retire <id>` | Sets `status: retired`, or `superseded` with `--by`; syncs. Never deletes the file (ADR practice, R) | ask |
| `sync` | Section 4.3 | ask |
| `list` | Prints one line per decision | allowed |
| `check` | Validates, checks sync and staleness; for CI | allowed |

Field limits for `add`: `--title` as `title`; `--rule` 1 to 300 characters; `--why` 0 to 500 characters; no newlines in any of them; 1 to 10 `--path`. `--quoted` only changes the guard's handling (6.1); the CLI ignores it.

**Every write subcommand, before writing:**
1. Refuses in an unattended run, using the env parts of `isUnattended` (`CLAUDE_CODE_REMOTE`, `CI`, `HARNESS_UNATTENDED`); the CLI can't see `permission_mode`, which the guard covers.
2. Inside Claude Code (`CLAUDECODE` set) with `checks.guard: false`: refuses, because then nobody asks the person.
3. Runs the secret scan (section 7.2) on every field and on the rendered file. A hit refuses; there is no override.
4. In a terminal (TTY): shows the file(s) it will write and asks `Write these files? [y/N]`, unless `--yes`. Inside Claude Code there is no TTY: the guard's ask was the approval.
5. Writes nothing to git. No commit, no staging.

**Output copy.** Exit 0 on success, 1 on a refusal or validation error, 2 on usage.

`add`:
```
Wrote docs/decisions/2026-11-03-validate-env-with-zod.md
Wrote .claude/rules/harness-decision-2026-11-03-validate-env-with-zod.md (loads when src/env/**, src/config.ts are touched)
Nothing is committed. Open a PR so the team reviews it.
```

`confirm`:
```
Confirmed 2026-11-03-validate-env-with-zod at 4f0c2a9 on 2026-11-03. It expires on 2027-02-01 unless confirmed again.
```

`retire`:
```
Retired 2026-11-03-validate-env-with-zod (superseded by 2026-12-01-env-from-config). Removed its rule. The decision file stays as a record.
```

`sync`: `Rules in sync: <n> decisions, <m> rules (<k> expired or retired, left out).` or one `Wrote …` / `Removed …` line per file.

`list`, one line per decision, sorted by id:
```
2026-11-03-validate-env-with-zod  active   confirmed 2026-11-03  src/env/**, src/config.ts  stale: 2 linked files changed since 4f0c2a9
```

`check`: the `doctor` lines of section 9, then `<n> decisions: <e> errors, <s> stale, <x> expired, <o> oversized, rules <in sync|out of sync>`. Exit 1 on errors or out of sync. Stale, expired and oversized don't fail it, so CI doesn't go red only because 90 days passed.

Refusals:
- Unattended: `harness remember does not write in unattended runs (CI, cloud or no-prompt sessions). A person can save it later.`
- Guard off: `harness remember won't write from inside Claude Code while checks.guard is off, because nobody would be asked. Run it in your own terminal.`
- Secret: `harness remember: --why looks like it holds a secret (<kind>). Decisions are committed to git. Remove it.`
- Dead path: `harness remember: src/env/** matches no tracked file. Fix the path, or retire the decision.`
- Unknown id: `harness remember: no decision 2026-11-03-x in docs/decisions/.`

Events (`.harness/logs/events.jsonl`, check `remember`): `added`, `confirmed`, `retired`, `synced`, `refused` with the reason (never the field text).

## 6. Guard, protect and change detection

### 6.1 Guard

`remember` joins `PERSON_ONLY` as `ask`. `list`, `check`, and any subcommand with `--dry-run` are allowed. Detection uses the guard's existing walker, so wrappers and hidden `harness` names are covered as for `init` and `update` (PE §3.5). No new `DENY` or `ASK` regex (PE §3.5 froze them).

The ask's reason is built by `rememberAsk(ctx, words)` in `src/checks/remember.ts`, from the command's own words. Its result:

1. **Not literal.** Any `remember` argument holds `$`, a backtick, `$(` or `<(`, or the command feeds `remember` from stdin or a file: **deny**. `Blocked by guard: harness remember needs its text as plain quoted words, so the person sees exactly what is written. Remove $, backticks and substitutions.`
2. **Secret** (7.2) in any field: **deny**. `Blocked by guard: this decision looks like it holds a secret (<kind> in --<field>). Decisions are committed to git. Remove it.`
3. **Quotes untrusted text** (7.1), without `--quoted`: **deny**. `Blocked by guard: this decision repeats text from tool output ("<excerpt>"). Decisions become standing instructions for the whole team, so text from tool output, PR text or web pages needs the person's yes. Rewrite it from what the person said, or ask the person; if they agree, run it again with --quoted.`
4. **Otherwise ask.** For `add`: `Confirm: the agent wants to save a team decision to docs/decisions/<id>.md. Title: <title>. Rule: <rule>. Why: <why>. Paths: <paths>. Once merged it loads for every teammate whose session touches those paths. Approve to write the files (nothing is committed).` With `--quoted` and a quote found, it starts with `Warning: this draft repeats tool output ("<excerpt>"). Approve only if you trust where that text came from.` For `confirm`: `Confirm: the agent wants to mark decision <id> as still true at <sha7>; it then stays loaded for another <expiry_days> days.` `retire` and `sync` name the files they change.

Unattended: the dispatcher already turns the ask into a deny. For `add`, the guard also logs `decision-candidate` with the title and rule (after secret redaction, 7.2) and nothing else (D8).

The id in the ask is computed the same way the CLI computes it; if the CLI picks a `-2` suffix, its output says so.

### 6.2 Protect

- Protected for Claude's file tools and for shell write targets named in the command text (the existing routes, including `git checkout/restore` and inline code that names the path):
  - `.claude/rules/harness-decision-*.md`;
  - a file in `docs/decisions/` that exists and is a decision (3.1);
  - any **new** file in `docs/decisions/`, because a new decision must come through `add`.
- Reason: `Team decisions change only through harness remember, which asks the person first. Edit a decision by hand yourself, then run harness remember sync.`
- `PROTECTED_CONCRETE` gains `docs`, `docs/decisions` and `.claude/rules`, so `rm -rf docs` is caught as `rm -rf .claude` is today.
- **No permission deny rule** is added for these paths. Under the sandbox, `Edit(...)` deny rules become OS write denies for every command (PE §2, §4), which would stop the `harness remember` process itself. This is the same choice PE made for `.harness/results/**`.
- With `checks.decisions: false` none of this applies.
- Reading stays free: the agent can Read, Grep and `cat` decisions.

**Is `docs/decisions/` agent-editable? No** (for decision files and new files). Reasons: a plain Edit would skip the person's yes (D4), the untrusted-text and secret checks (D9), and rule sync. The cost: the agent can't fix a typo; a person edits by hand (protect never sees their editor) and runs `harness remember sync`. Existing non-decision files in the folder stay editable (C8).

### 6.3 Change detection

The harness-files snapshot (`harness-files.ts`) gains the generated rule files listed in the manifest. A script that rewrites one is reported at the next prompt and Stop, as for `.harness/hooks`. `docs/decisions/` is not added: teammates change it through git, and the PR is its review.

## 7. Untrusted text and secrets

### 7.1 Quote detection (D9)

Runs in the guard (6.1), at PreToolUse, because only a hook gets `transcript_path`. It reads only the current session's transcript, only to compare the draft against it, and stores or copies nothing from it (C2). The excerpt in the deny or ask is the draft's own words; the event the dispatcher logs for that deny or ask says `quotes tool output` and leaves the excerpt out.

1. Read the transcript with the reader in `multi-file.ts` (`readTranscript`), extended to collect the text of every `tool_result` block (string content and `text` blocks). These are the outputs of Bash, Read, Grep, WebFetch, WebSearch, MCP tools and subagents, so `gh pr view` text, web pages and file contents all count. The person's typed prompts and the agent's own text do not.
2. Read at most the last 8 MB of the transcript.
3. Normalise both sides: lowercase, Unicode NFKC, drop zero-width characters, turn every run of non-letters-or-digits into one space.
4. A field **quotes untrusted text** when any 8 consecutive words of it appear in the normalised tool output. The excerpt is those words, cut to 80 characters.
5. A `--rule` or `--why` that holds a URL also counts as quoting web content.
6. An unreadable or missing transcript counts as a quote with the excerpt `transcript unreadable, so harness can't check`; the person confirms with `--quoted` as above.

Limits, stated in the README:
- A paraphrase, a translation, or a quote shorter than 8 words passes.
- Text the person pasted into their own prompt is trusted, wherever it came from.
- Repo files the agent read count as tool output, so a decision quoting the team's own docs needs `--quoted` too.
- The transcript JSONL is not a documented stable format (the existing note in `multi-file.ts`); a format change makes every draft need `--quoted`, which is safe but noisy.
- It is a speed bump against injected instructions becoming team rules, not a filter. The person's yes and the PR review are the real checks.

### 7.2 Secret scan

`scanSecrets(text)` in `src/core/secrets.ts`, a fixed pattern list with no dependency and no network:

| Kind | Pattern (case-sensitive unless noted) |
|---|---|
| private key | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |
| AWS access key | `\b(AKIA\|ASIA)[0-9A-Z]{16}\b` |
| GitHub token | `\bgh[pousr]_[A-Za-z0-9]{36,}\b`, `\bgithub_pat_[A-Za-z0-9_]{22,}\b` |
| Slack token | `\bxox[abprs]-[A-Za-z0-9-]{10,}\b` |
| Anthropic or OpenAI key | `\bsk-ant-[A-Za-z0-9_-]{20,}`, `\bsk-[A-Za-z0-9]{32,}\b` |
| JWT | `\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}` |
| URL with credentials | `[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@` (case-insensitive) |
| assignment | `(api[_-]?key\|secret\|token\|passw(or)?d)\s*[:=]\s*['"]?[^\s'"]{8,}` (case-insensitive) |

It runs on every draft field, on the rendered decision file, and on every `decision-candidate` log entry (a hit replaces the matching text with `[redacted]`). Limit: patterns miss secrets without a known shape, and personal data such as names or emails is not checked. Gitleaks (a catalog item) is not required or called.

## 8. Stop: nudge and warning

Both are notes (`context`, shown to the person as `systemMessage`; the agent doesn't see them). They go through the Stop gate's existing `done()` path, so they appear only when the Stop is not blocked and are kept for the next Stop otherwise. The gate's docs-only early return also goes through `done()`. With `checks.stop: false` neither runs (C10).

### 8.1 Nudge (D5)

**Signals**, case-insensitive regex on plain text, no model call:

- **P (the person states a rule).** At UserPromptSubmit, the first 4,000 characters of `prompt` are matched against:
  - P1 `\b(from now on|going forward|in (the )?future)\b`
  - P2 `\b(always|never)\s+(use|call|import|run|put|write|add|commit|name)\b`
  - P3 `\b(don'?t|do not|stop)\s+(using|use|calling|call|importing|import|adding|add)\b`
  - P4 `\bwe\s+(decided|agreed|chose|settled on|prefer|always|never)\b`
  - P5 `\b(the|our)\s+(convention|rule|standard|policy)\s+(is|here is)\b`

  A hit stores `{ pattern, excerpt }` (the 120 characters around the match) in the session state, at most 3 per session.
- **A (the agent accepts a standing rule).** At Stop, `last_assistant_message` is matched against:
  - A1 `\bI('ll| will)\s+(remember|keep (this|that) in mind)\b`
  - A2 `\b(from now on|going forward),?\s+I('ll| will)\b`

**When it shows:** at Stop, when there is at least one P or A hit this session, `decisions.nudge` is true, the run is attended, no nudge was shown yet this session, and no `harness remember add` ran this session (PostToolUse records it).

**Copy:**

> Harness: this session may hold a team decision (you said "…from now on use the env schema…"). To keep it for the team, ask Claude to save it with `harness remember add`; you approve the write and the PR reviews it. If it's only your own preference, Claude Code's auto memory is the place.

**Unattended:** no nudge. Each hit is logged once as `decision-candidate` with the pattern id and the redacted excerpt (D8).

Limit: English phrases only; unmeasured precision (R, design C). The patterns are a constant in `src/checks/decisions-stop.ts` so the plan can tune them with a fixture corpus.

### 8.2 Warning (D7)

At Stop, for each active decision whose `paths` match a file this session changed (the gate's changed-file list: `git status` plus the diff from the session's base), harness checks staleness (section 9) once per session per decision. It shows one line per affected decision:

> Harness: you changed code covered by team decision `<id>` ("<title>"). If it still holds, ask the person to run `harness remember confirm <id>`; if not, `harness remember retire <id>`.

It adds `It is expired (last confirmed <date>).` or `Its path <glob> no longer matches any file.` when those apply, and `Rules are out of sync: run harness remember sync.` when they are. It never blocks and never counts as a Stop attempt.

## 9. Staleness, `doctor` and `status`

**States** (an active decision can have several):

| State | Test |
|---|---|
| dead | a `paths` glob matches no file in `git ls-files -z` (one call for all decisions) |
| changed | `git diff --name-only -z <ref> HEAD`, filtered by the decision's globs, is not empty. `<ref>` is the later of `verified_at` and the last commit that touched the decision file (`git log -1 --format=%H -- <file>`): the file's commit when `verified_at` is its ancestor (`git merge-base --is-ancestor`) or is not in the clone, otherwise `verified_at`. The decision file itself doesn't count (C4, C5) |
| expired | `verified_on` is more than `decisions.expiry_days` days before today (UTC) |
| oversized | its rule would exceed `decisions.max_lines` (4.2) |

All git calls are `spawnSync('git', …, { timeout: 2000 })` without a shell, as elsewhere. One diff per distinct `<ref>`. A git failure gives the note `couldn't check decision staleness (<reason>)`.

**`doctor`** (`fix` exits 1, `note` doesn't; same form as PE §8):

| Check | Output |
|---|---|
| Summary | `ok decisions: <n> active, rules in sync` (or `ok no team decisions yet`) |
| Invalid | `fix docs/decisions/<file>: <key> <must be …>: correct it by hand, then run harness remember sync` |
| Sync | `fix decision rules are out of sync with docs/decisions/: run harness remember sync` |
| Foreign rule | `fix .claude/rules/<file> is named like a harness decision rule but isn't harness's: rename it` |
| Dead | `note decision <id> is stale: <glob> matches no tracked file: fix its paths by hand, or run harness remember retire <id>` |
| Changed | `note decision <id> is stale: <n> linked files changed since <sha7> (<first 3>…): check it still holds, then run harness remember confirm <id>` |
| Expired | `note decision <id> expired: last confirmed <date>, over <expiry_days> days ago, so its rule no longer loads after the next sync: run harness remember confirm <id> or harness remember retire <id>` |
| Oversized | `note decision <id> is oversized: its rule is <n> lines, cap <cap>, so it is cut: shorten it by hand, then run harness remember sync` |
| Fallback ref | `note decision <id>: verified_at <sha7> is not in this clone; compared from the decision file's last commit` |

**`status`** adds one line: `Decisions: <n> active (<s> stale, <x> expired), rules <in sync|out of sync>`, or `Decisions: none`. It reuses doctor's computation.

## 10. Config

```yaml
# Team decisions in docs/decisions/ (needs checks.decisions). Each loads as a rule when its paths are touched.
decisions:
  max_lines: 20     # content lines of one generated rule
  expiry_days: 90   # a decision not confirmed for this long stops loading at the next sync
  nudge: true       # Stop suggests saving a decision when the session shows signals
```

| Key | Default | Rule |
|---|---|---|
| `checks.decisions` | `true` | boolean (by the type of its default) |
| `decisions.max_lines` | `20` | must be an integer from 5 to 200 |
| `decisions.expiry_days` | `90` | must be an integer from 7 to 365 |
| `decisions.nudge` | `true` | boolean |

- An existing config without these keys gets the defaults through the overlay; no migration. `config.example.yaml`, `serializeConfig` and the generated README config table gain them.
- An invalid value makes the config invalid, and hooks fail closed, as for any key.
- The folder is fixed at `docs/decisions/` (D2); it is not a key.

## 11. Tests

**Offline (unit and e2e; CI on three OSes):**
- **Schema:** each key's rule, unknown keys, `id` ≠ file name, duplicate ids, `superseded_by` presence, every forbidden glob form, a glob matching nothing at `add`, non-decision files ignored.
- **Rendering:** the rule bytes for a fixture decision (golden file); quoted globs; LF; the cap at 20 and 21 lines; the cut line for an oversized decision.
- **Sync:** add, change, retire, supersede, expire (injected clock), delete a decision file; a foreign `harness-decision-*.md` stops sync; a manifest conflict resolved by sync; dry-run writes nothing.
- **CLI:** every subcommand's output copy and exit code; unattended env refusal; `CLAUDECODE` with `checks.guard: false` refusal; the TTY prompt and `--yes`; the `-2` id suffix; `--supersedes`; `confirm` on a dead path refuses; nothing staged in git.
- **Guard:** `remember add` asks, `list`/`check`/`--dry-run` allowed; wrappers (`npx @khubaibqaiser/harness remember add`, `bash -c`, `env X=1`); the not-literal deny for `$`, backticks, `$(`, stdin; unattended deny plus one `decision-candidate` event; the ask copy for each subcommand.
- **Quote detection:** fixture transcripts with tool results from Bash, WebFetch, Read and an Agent result; an 8-word quote denies, 7 words passes; case, punctuation, NFKC and zero-width variants still match; a URL counts; text from the person's prompt doesn't; an unreadable transcript counts; `--quoted` turns the deny into the warning ask; the 8 MB tail; the logged event holds no excerpt and nothing from the transcript is written anywhere (C2).
- **Secrets:** one positive and one near-miss per pattern; redaction in the candidate log.
- **Protect:** Edit, Write and shell writes to a generated rule, to an existing decision and to a new file in `docs/decisions/` deny; an existing non-decision file there is allowed; `rm -rf docs` denies; Read allowed; everything allowed with `checks.decisions: false`; no deny rule added to the settings fragment.
- **Change detection:** a script-rewritten rule file is reported; a CLI sync is not.
- **Stop:** each P and A pattern, with a negative sample per pattern; once per session; suppressed after `remember add`, with `nudge: false`, when unattended (logged instead); held over when the gate blocks; the warning lists only decisions linked to changed files.
- **Staleness:** temporary git repos for dead, changed, expired and the missing-`verified_at` fallback (a squash-merged branch); a decision committed with its code is not changed (C5); git timeout gives the note.
- **Doctor and status:** every line in section 9.
- **e2e byte-identity:** `init` → `remember add` ×2 → `retire` → `uninstall` restores every harness-written file and leaves `docs/decisions/`; `init` → `uninstall` unchanged by this feature.
- **Config:** defaults, ranges, the generated README table.
- `test/perf` still passes: a PreToolUse with no `remember` command and no protected path reads no transcript and spawns no git.

**Live (gated: costs money; only with the owner's approval, as one batch, after the offline suite passes):**
1. A generated rule loads when the agent Reads a linked file and not before (seen in `/context` or an `InstructionsLoaded` log), including after `/compact` (R1, R2).
2. The agent's `harness remember add` shows the guard ask; declining writes nothing; approving writes both files.
3. `claude -p` (unattended): `add` is denied and one `decision-candidate` is logged.
4. After a WebFetch of a local test page, a draft that copies a sentence from it is denied; with `--quoted` the ask shows the warning (R3).
5. A "from now on" prompt produces the Stop nudge once.
6. Under `sandbox: always`, `harness remember add` run by the agent can write `docs/decisions/` and `.claude/rules/` (R5).

## 12. Known limits (README)

- Rules load when Claude Code's file tools (or a single-file `cat`/`head`) touch a linked path (R). An agent that changes code only through other shell commands, or only searches, may never load the decision.
- No cap on how many rules load in one session; only each rule's size is capped.
- Expired decisions keep loading until someone runs `harness remember sync` and commits the result.
- Quote detection is an 8-word exact match on normalised text (7.1); the secret scan is a fixed pattern list (7.2).
- Nudge signals are English regexes and unmeasured.
- Protect is a text check: a program the agent writes can still change `docs/decisions/` or the rules. Change detection reports rule changes; the PR is the check for decision files.
- `harness remember` may not be on the PATH in cloud sessions (M3 §6); those runs are unattended anyway (`CLAUDE_CODE_REMOTE`), so they don't write. Committed rules still load there.
- "Changed since `verified_at`" counts any change to a linked file, so broad globs go stale often.
- Two branches that each add a decision conflict in `.harness/manifest.json` (4.4).

## 13. Out of scope

- Personal memory, reading or promoting Claude Code's auto memory, and any change to it (D1).
- Reviewer memory, `memory: project` for `staff-reviewer` (D10).
- Merging `product.md` into decisions (D11).
- Model-based capture or summarising; semantic search over decisions.
- A CI workflow or GitHub Action (`harness remember check` is ready for one).
- Personal-data detection; non-English nudge signals; decisions shared across repos; Cursor and OpenCode.

## 14. Decisions after review (owner, 2026-11-03)

The owner ruled on every point the first draft raised. None is open.

**Later ruling (owner, 2026-11-10):** C-R6. A model-invocable `/harness:remember` skill runs the bundled CLI, so a plugin-only install can save decisions too. The AGENTS.md pointer names it. It costs about 30 always-loaded tokens. This replaces the §13 line that ruled the skill out.

| # | Point raised | Ruling |
|---|---|---|
| C1 | D3 sets an "index cap", but per-path rules plus one pointer line leave no index to cap. | The cap applies to each generated rule's content lines (4.2). |
| C2 | D1 says harness never reads the home folder; quote detection reads `transcript_path`, under `~/.claude/projects/`. | Allowed as D1's one narrow exception: only the current session's transcript, only to compare the draft; nothing is stored or copied (D1, 7.1). |
| C3 | D6 expiry has no effect by itself, because rules are committed files. | `sync` leaves expired decisions out; `doctor`, `check` and Stop say they expired. |
| C4 | `verified_at` may not exist in other clones after a squash merge or rebase. | Fall back to the decision file's last commit (section 9). |
| C5 | A decision written with its code in one PR reads as "changed" as soon as it lands. | `<ref>` is the later of `verified_at` and the decision file's last commit; `verified_at` stays the record (section 9). |
| C6 | Recording each rule in the committed manifest makes concurrent decision PRs conflict on `.harness/manifest.json`. | Keep the entries, sorted; `sync` rebuilds them (4.4). |
| C7 | Byte-identical uninstall can't cover `docs/decisions/`, the team's reviewed content. | Uninstall leaves it; byte-identity covers harness-written files (4.4). |
| C8 | Repos may already keep ADRs in `docs/decisions/`. | Only files with `schema: harness-decision/1` are decisions; protect covers them and new files (6.2). |
| C9 | Permission deny rules would, under the sandbox, deny `harness remember` its own writes. | Protect check only, no deny rule (6.2), as PE did for `.harness/results/**`. R5 stays a live check. |
| C10 | The nudge and warning use the Stop gate's note path, so `checks.stop: false` turns them off and a blocked Stop delays them. | Accepted and documented. |
| C11 | Inside Claude Code the guard's ask is the only approval, and the guard is a text check. | As designed: the guard's ask plus PR review is enough. When nobody is watching, the sandbox blocks scripts (PE §3.4). |
| C12 | The 2026-10-30 catalog discourages a third-party `remember` item; the names can be confused. | The name stays `harness remember`. The build updates that catalog item's reason to say it overlaps both auto memory and harness team decisions. |
| C13 | Rules load only through Claude Code's file tools, not Grep, shell edits or subagents. | Accepted as a known limit (12); live check 1 records what loads. |
| O1 | Repo-wide globs (`*`, `**`, `**/*`). | Refused; repo-wide team rules belong in AGENTS.md or CLAUDE.md through a PR (3.2). |

PE §3.5 froze the guard's regex. Adding `remember` to `PERSON_ONLY` and paths to protect's lists adds no regex, so this spec is compatible with it.

## 15. Open risks (unverified)

| # | Risk | How the build confirms it |
|---|---|---|
| R1 | A `paths` rule loads on Read/Write/Edit of a match and reloads on demand after compaction (R, Claude Code section) | Live check 1 |
| R2 | Committed `.claude/rules/` files load in cloud sessions | Owner's call on a cloud live run; not in the batch |
| R3 | The transcript holds `tool_result` blocks, with tool output text, before the next PreToolUse | Live check 4; fixtures follow what it records |
| R4 | Whether Claude Code reads rules in subdirectories of `.claude/rules/` | Not relied on: names are flat (4.1) |
| R5 | Whether the sandbox lets a Bash-run program write `.claude/rules/` and `docs/decisions/` | Live check 6; if not, `remember` writes need the person's terminal under `sandbox: always`, and the docs say so |
| R6 | How the agent invokes the CLI in each install (plugin bin, `npx`) | The plan reads the M3 build; the AGENTS.md line names the command it finds |

## 16. Order of work

1. M3 and the PE work are merged.
2. Plan from this spec, then build: schema and render, sync and manifest, CLI, guard and quote and secret checks, protect and change detection, Stop, doctor and status, config, README.
3. Live batch, final review, release.
