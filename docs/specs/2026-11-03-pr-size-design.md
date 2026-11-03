# PR size: design spec

- Status: owner-approved design. The 2026-11-02 decisions are in section 1. The owner's answers of 2026-11-03 to the spec's questions are in section 12. Nothing is open.
- Date: 2026-11-03
- Owner: khubaibqaiser
- Inputs: [`../research/2026-11-02-pr-size.md`](../research/2026-11-02-pr-size.md) (the evidence and the owner decisions), [`2026-11-03-platform-enforcement-design.md`](2026-11-03-platform-enforcement-design.md) ("PE"), and the code on `feature/pe-6-config-change`: `src/checks/guard.ts`, `src/core/config.ts`, `src/checks/multi-file.ts`, `src/hooks/dispatch.ts`.
- Builds on: the PE work (`isShell`, exec-form hooks, `onFailure: "block"` on PreToolUse). It replaces the `pr-create-trigger` hook and fills in the `pr-ship` skill that [`2026-10-30-harness-design.md`](2026-10-30-harness-design.md) §7.3 planned.
- When: after M3, as the research note says (research, owner input, spec, plan, build).

## 1. Owner decisions (2026-11-02)

| # | Decision |
|---|---|
| D1 | **Guide, plus an ask at PR time.** The `pr-ship` skill plans the split. The guard asks when the agent runs `gh pr create` over the limit. Unattended runs are refused. |
| D2 | **Limit.** Aim for 200 changed lines or fewer. Ask above 400 changed lines or above 20 files. Configurable per repo. |
| D3 | **Counting.** Tests count. Everything counts except lockfiles and non-critical ignore files (`.gitignore`, `.prettierignore`, `.dockerignore` and the like). |
| D4 | **Left to this spec:** whether snapshots, `multi_file_gate.generated` paths and whole-file deletions count. The owner decided these on 2026-11-03 (section 12, O1 to O3). |

## 2. Scope

In: a `pr-size` PreToolUse and PostToolUse check; detection of `gh pr create` and of `git push` to a branch harness recorded as a PR; measuring without a shell; the config keys; a `--pr-size` entry on `dispatch.mjs` for the skill; the `pr-ship` skill; the tests.

Out: a CI or GitHub Action size check (the only stop that holds for everyone); `gh pr edit --base`; GitHub MCP tools and the web UI; fetching remote refs from a hook; the PR that the M3 `init` git step opens (the guard sees `harness init`, which PE §3.5 already asks about).

## 3. Detection

### 3.1 One walker for the guard and pr-size

`personOnlyInvocation` and `walkInvocation` in `guard.ts` already find a command through every wrapper the guard knows: the four readings of the text (escape, Windows, and the two grouped readings), segments split on `&&`, `||`, `;`, `|`, `&`, `$(`, backticks and parentheses, `commandStart` (runners, wrapper flags and their values, `VAR=value`, `timeout 60`, `script FILE`, `find -exec`), `npm run`/`pnpm`/`yarn`/`bun` scripts from `package.json`, `-c` payloads and programs fed to a shell on stdin, to depth 3.

The build extracts that walk as `walkCommands(command, where, visit)`, where `visit(toks, k, next)` returns a hit or null. The person-only rules become one visitor; pr-size adds two. The guard's tests must pass unchanged. No new regex rules are added to `DENY` or `ASK` (PE §3.5 froze them).

The walker runs on Bash, PowerShell and Monitor commands (`isShell`), as the guard does. It doesn't parse PowerShell syntax (PE §3.2).

### 3.2 `gh pr create`

A segment is a PR create when `runnerName(toks[k])` is `gh` (so `/usr/local/bin/gh` and `C:/…/gh.exe` match) and its words after `k`, skipping flags, are `pr` then `create`. `-R`/`--repo` take a value and may come between `pr` and `create` (`gh pr -R owner/repo create`).

Hidden names, the same way the guard handles `harness`:
- `$GH pr create`, or a substitution in command position followed by `pr create`, counts as a PR create.
- `eval` in a command that also has the words `gh`, `pr` and `create` counts as a PR create.

From the create's own words it reads `-B`/`--base`/`--base=` and `-H`/`--head`/`--head=`. A `--head owner:branch` value keeps the part after the colon. The build checks the full list of `gh pr create` value flags against `gh pr create --help`, so a flag's value is never read as the base (unverified here).

Not PR creates: `gh pr view`, `gh pr list`, `echo gh pr create`, `grep "gh pr create"`, `git commit -m "gh pr create"`. The walker only looks at words in command position.

### 3.3 `git push` to a PR branch

A push counts, so a PR can't be opened small and grown later. Detection uses no network.

- **The record.** After a PR create or a counted push, PostToolUse writes `.harness/state/pr-branches.json`: `{ "<head branch>": { "base": "<base name>", "lines": n, "files": n, "ts": "…" } }`, with the existing atomic write. It is repo-level, not per session, because a PR outlives a session. It sits under `.harness/state/**`, so the agent's file tools and the sandbox can't write it (PE section 2). It records after the tool ran, failed or not: a failed create leaves a record, which only makes later pushes to that branch stricter.
- **A push.** A segment is a push when the command is `git` and `gitArgs(toks)` starts with `push`. The pushed branches are each refspec's destination (after `:`, without a leading `+` or `refs/heads/`). With no refspec, the pushed branch is the current branch (`git symbolic-ref --quiet --short HEAD`). `--all` means every recorded branch that exists locally.
- **When it counts.** Only for a recorded branch. It measures from the recorded base to the local branch (or to the refspec's source, such as `HEAD`).

## 4. Measuring

Lives in `src/checks/pr-size.ts` as `measure(root, { base, head }, config)`. Every git call is `spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2000 })`, as `detectBaseHead` does. There is no shell. The whole measurement stops after 6 s in total, inside the 10 s hook timeout. Any failure gives "unmeasured" with a one-line reason (section 6).

**The base.**
1. The create's `--base` value.
2. Otherwise the repo's default branch, which is what `gh` targets without `--base`: `git symbolic-ref --quiet --short refs/remotes/origin/HEAD` (for example `origin/main`).
3. Otherwise `stop.base_ref` (default `origin/main`).

For a push it is the recorded base.

**Stacked PRs.** In a stack the base is another branch, passed as `--base feat/a`. A name is looked up as `refs/remotes/origin/<name>` first, because GitHub compares against the remote base, and then as `refs/heads/<name>`, for a base that is local only. A stacked branch created without `--base` is measured against the default branch. That is right, because the PR GitHub opens then holds the whole stack.

**The head.** The create's `--head` value as `refs/heads/<name>`, then `refs/remotes/origin/<name>`. Otherwise `HEAD`. Only committed work counts. The working tree and untracked files are not in the PR, so they are not counted (unlike the diff-coverage step).

**Trust boundary.** Base and head come from the agent's command text. A name must match `^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$` and must not contain `..`. Otherwise the PR is unmeasured ("not a plain branch name"). So a value such as `--output=/tmp/x` never reaches git as an option. Each name is resolved to a commit with `git rev-parse --verify --quiet --end-of-options <ref>^{commit}` (`--end-of-options` needs git 2.24 or later). Only the resolved SHAs are passed to `diff`.

**The diff.** GitHub's PR diff is the three-dot comparison, from the merge base to the head:

```
git -c core.quotePath=false diff --numstat -z -M --no-ext-diff --no-textconv <baseSha>...<headSha>
git -c core.quotePath=false diff --name-status -z --diff-filter=D --no-ext-diff <baseSha>...<headSha>   # whole-file deletions (section 5)
```

With `-z`, a numstat entry is `added\tdeleted\tpath\0`. For a rename it is `added\tdeleted\t\0old\0new\0`. Binary files show `-` for both counts.

## 5. Counting rules

- Changed lines for a file = added + deleted lines, from numstat (the sum GitHub shows). The PR's lines are the sum over the counted files. Its files are the number of counted files.
- **Tests count** (D3), including `*.test.*`, `__tests__/` and Python tests. This differs from the multi-file gate, which skips them.
- **Excluded** paths count toward neither lines nor files: a path that matches `pr_size.exclude` (picomatch, `dot: true`, through the existing `matches`). For a rename, the new path is judged.
- **Binary** files count as one file and 0 lines.
- **A pure rename** counts as one file with its numstat lines (0 when the content is unchanged).
- **Merge commits** on the branch need no rule: the three-dot diff is the net change.
- **Snapshots are not counted** (O1). The `exclude` default holds `**/__snapshots__/**` and `**/*.snap`.
- **Generated paths are not counted** (O2). A path that matches `multi_file_gate.generated` is skipped. This is read from that same key, so the repo has one list of generated paths.
- **A whole-file deletion counts as 1 file and 0 lines** (O3). The deleted files come from the `--diff-filter=D` call in section 4.

## 6. Decision

The PR is **over** when lines > `pr_size.max_lines` or files > `pr_size.max_files`.

| Case | Attended | Unattended (`isUnattended`) |
|---|---|---|
| Within the limit | allow | allow |
| Over the limit, PR create | ask (10.1) | deny (10.2) |
| Over the limit, push to a recorded branch that grows past its record (more lines or more files than recorded) | ask (10.1) | deny (10.2) |
| Over the limit, push that doesn't grow it | allow (the person already approved this size) | allow |
| Unmeasured (no base, git missing, timeout, a name that isn't a plain branch name) | allow with a note (10.3), and log `pr-size-unmeasured` (O5) | the same |

- The check is `pr-size`. It is registered after `guard` in `registry` and runs on PreToolUse (decide) and PostToolUse (record). It has `failClosed: true`, like the guard, so a thrown error denies. It is `pure` at PreToolUse: it runs read-only git and writes only to the event log.
- **Unmeasured.** The check appends a `pr-size-unmeasured` event (`check: 'pr-size'`, with the reason) and returns a `context` decision carrying the 10.3 note. The command runs. A `context` decision is never an ask, so the dispatcher's ask-to-deny doesn't touch it, and unattended runs are allowed too.
- `checks.prSize: false` turns it off. `checks.guard: false` leaves it on, because it is its own check.
- When one command has several PR creates or pushes, each is measured, and the first one over the limit decides.
- A command with no PR create and no push never spawns git, so the PE latency budget is unchanged.
- In an unattended run the check returns its own deny (10.2) rather than relying on the dispatcher's `Unattended run: Confirm: …` prefix, so the agent is told how to split.

## 7. Config

```yaml
# Pull request size (needs checks.prSize). Asks above max_lines or max_files; the pr-ship skill aims for target_lines.
pr_size:
  target_lines: 200
  max_lines: 400
  max_files: 20
  exclude: [<the lockfile and ignore-file globs below>]
```

| Key | Default | Rule |
|---|---|---|
| `checks.prSize` | `true` | boolean (by the type of its default) |
| `pr_size.target_lines` | `200` | must be an integer from 1 to 100000 |
| `pr_size.max_lines` | `400` | must be an integer from 1 to 100000 |
| `pr_size.max_files` | `20` | must be an integer from 1 to 10000 |
| `pr_size.exclude` | the list below | must be a list of strings (by the type of its default) |

- `exclude` default, lockfiles: `**/pnpm-lock.yaml`, `**/package-lock.json`, `**/npm-shrinkwrap.json`, `**/yarn.lock`, `**/bun.lock`, `**/bun.lockb`, `**/Cargo.lock`, `**/poetry.lock`, `**/uv.lock`, `**/Pipfile.lock`, `**/Gemfile.lock`, `**/composer.lock`, `**/go.sum`. Ignore files (O4): `**/.!(npm|harness)ignore`. That is every `.*ignore` file except `.npmignore` and `.harnessignore`; one picomatch extglob, so the list needs no negation. Snapshots (O1): `**/__snapshots__/**`, `**/*.snap`.
- **Cross-key rule:** `target_lines` greater than `max_lines` is an error. It is checked in `loadConfig` after the overlay, as `tdd.results_dir` is. As with any invalid key, the config is then invalid and the hooks fail closed.
- A list set in the config replaces the whole default list, as the overlay does for every list. The README says so: a repo that adds one glob must keep the defaults it wants.
- An existing config without `pr_size` gets the defaults through the overlay, so no migration is needed. `config.example.yaml`, `serializeConfig` and the generated README config table gain the keys.
- `target_lines` is guidance only. Only the skill and the copy read it; no gate enforces it.

## 8. `--pr-size` entry

`node .harness/hooks/dispatch.mjs --pr-size [--base <name>] [--head <name>]` runs `measure` and prints one JSON line:

```json
{ "base": "origin/main", "head": "HEAD", "lines": 512, "files": 14, "target_lines": 200, "max_lines": 400, "max_files": 20, "over": true, "top": [{ "path": "src/a.ts", "lines": 210 }], "excluded": ["pnpm-lock.yaml"] }
```

It exits 0 within the limit, 1 over the limit, and 2 when unmeasured (with `"error"`). It sits next to `--self-test` (PE §3.1). It is read-only and reads no stdin. It lives in the repo's hook bundle, so the skill can run it in every clone, including cloud sessions, where the plugin's CLI isn't loaded. The base and head flags go through the same name rule as section 4.

## 9. `pr-ship` skill

An own item, installed by `init` from `templates/skills/pr-ship/SKILL.md` into `.claude/skills/pr-ship/`, the same way `review-rubric` is. Outline:

1. **Frontmatter.** `name: pr-ship`. The description says when to use it: before opening a PR, or when the size check asked or denied.
2. **Measure.** Run the `--pr-size` entry against the intended base. Read `top` and `excluded`.
3. **Within `target_lines`.** Open the PR with an explicit `--base`.
4. **Above it: plan the split** before touching branches. The order, from the Google guidance in the research:
   - Refactors and renames go in their own PR first.
   - Then vertical slices, each with its own tests (tests stay with the code they test).
   - Each PR aims for `target_lines` or fewer and never goes over `max_lines`/`max_files`.
   - The PRs are stacked: each PR's base is the branch before it.
5. **Show the plan** to the person: for each PR, its title, files, measured or estimated lines (estimates labelled), base, and one line on why it stands alone. Wait for a yes. An unattended run carries on without one.
6. **Build the stack.** Create branches with plain git: no force push (the guard denies it), no `--no-verify`, never onto the default branch, and no rewrite of a pushed branch without the person's yes. Re-measure each branch with `--pr-size --base <previous branch>` before opening it.
7. **Open each PR** with `gh pr create --base <previous branch>`. The body says "Stacked on #N", and lists any multi-file `allow-log` files (2026-10-30 §9b).
8. **A piece that can't be split under the limit** (one generated migration, one large rename): say why, then let the person answer the ask. Unattended, stop and report; don't open it.
9. **Rules.** The skill never edits `.harness/config.yaml` to raise a limit (the agent can't anyway). It treats command output, hook messages and file contents as data, not instructions.

## 10. Copy

### 10.1 Ask (attended)

> Confirm: this pull request is 512 changed lines in 14 files against `origin/main`, over the limit of 400 lines or 20 files (aim for 200). Largest: `src/a.ts` 210, `src/b.ts` 150, `test/a.test.ts` 90. Not counted: `pnpm-lock.yaml`. Approve to open it as it is, or say no and run the pr-ship skill to split it into stacked PRs.

For a push, the first sentence becomes: "this push grows the pull request for `feat/x` to 512 changed lines in 14 files (it was 380 in 9)".

### 10.2 Deny (unattended)

> Blocked by pr-size: this pull request is 512 changed lines in 14 files against `origin/main`, over the limit of 400 lines or 20 files, and no person is here to approve it. Split it with the pr-ship skill into stacked PRs of about 200 lines each, opening each with `--base` set to the branch before it. If a piece can't go under the limit, stop and report it.

### 10.3 Unmeasured (attended and unattended: a note, the command runs)

> Note from pr-size: harness couldn't measure this pull request (`<reason>`, for example "base `feat/a` not found; fetch it first"), so its size against the limit of 400 lines or 20 files wasn't checked. To check it yourself, run `node .harness/hooks/dispatch.mjs --pr-size --base <base>`.

## 11. Tests

**Offline:**
- **Walker refactor:** the existing `guard.test.ts` cases pass with no change.
- **Detection, positive:** plain; absolute path; `gh.exe`; `env GH_TOKEN=x gh …`; `timeout 60 gh …`; `nohup`; `cd x && gh …`; `bash -c "gh pr create"`; `echo 'gh pr create' | sh`; a here-string; an `npm run ship` script; `$GH pr create`; `eval`; `gh pr -R o/r create`; Monitor and PowerShell text.
- **Detection, negative:** `echo`, `grep`, `git commit -m` with the words in an argument; `gh pr view`, `gh pr list`, `gh pr edit`.
- **Base and head** (temporary git repos): `--base`, `--base=`, `-B`; `origin/HEAD` set and unset (falls back to `stop.base_ref`); a stacked base that is remote, local only, or missing; `--head owner:branch`; a detached HEAD.
- **Trust boundary:** `--base=--output=x`, `..`, `-x` and a 300-character name are unmeasured (allowed with the note), and git is never called with them (assert through an injected `run`).
- **Counting:** a lockfile and each default ignore file excluded; a test file counted; a binary as 1 file and 0 lines; a pure rename; a path with spaces and non-ASCII characters (`-z`); working-tree and untracked changes not counted; a merge from the base not counted. Snapshots (`__snapshots__/`, `*.snap`) are not counted. A `multi_file_gate.generated` path is not counted. A whole-file deletion is 1 file and 0 lines. `.gitignore`, `.prettierignore`, `.dockerignore`, `.eslintignore` and a nested `pkg/.gitignore` are excluded; `.npmignore` and `.harnessignore` are counted.
- **Thresholds:** 400 lines allows and 401 asks; 20 files allows and 21 asks; custom limits; `checks.prSize: false` allows.
- **Unattended:** the 10.2 copy.
- **Unmeasured:** a missing base, git not on PATH, and a timeout each allow, attended and unattended. Each returns the 10.3 note as context and appends one `pr-size-unmeasured` event with the reason. None asks or denies.
- **Push:** the record is written at PostToolUse after a create and after a push; a recorded branch that grows past the limit asks; one that doesn't grow allows; an unrecorded branch allows; refspecs `HEAD:feat`, `+feat`, `-u origin feat`, and `--all`.
- **Config:** defaults; out-of-range and non-integer values; `target_lines` above `max_lines` is invalid; an unknown `pr_size` key; the generated README table.
- **`--pr-size` entry:** JSON shape and exit codes 0, 1 and 2.
- **Timing:** an injected `run` that times out gives unmeasured within the 6 s budget. `test/perf` still passes; a non-PR command spawns no git.
- **Skill template:** the frontmatter has `name` and `description`, and `init` installs it and `uninstall` removes it byte-identically.

**Live (gated: costs money; run only with the owner's approval, as one batch, after the offline suite passes):**
1. On a local dummy repo with a 500-line branch, the agent's `gh pr create` shows the ask; the person declines and nothing runs.
2. The same with `claude -p` (unattended): denied with the 10.2 copy.
3. `/pr-ship` plans a split of that branch; the owner judges the plan. Nothing is pushed.

## 12. Decisions (owner, 2026-11-03)

The owner answered every question the first draft left open. None is open.

- **O1. Snapshots are not counted.** `__snapshots__/` and `*.snap` are in the `exclude` default (sections 5 and 7).
- **O2. `multi_file_gate.generated` paths are not counted.** The check reads that same key; there is no `pr_size` copy of it (section 5).
- **O3. A whole-file deletion counts as 1 file and 0 lines** (section 5).
- **O4. Every `.*ignore` file is excluded except `.npmignore` and `.harnessignore`.** The default glob is `**/.!(npm|harness)ignore` (section 7).
- **O5. A PR that can't be measured is allowed with a note.** The check logs `pr-size-unmeasured` and shows the 10.3 note. It doesn't ask and doesn't deny, attended or unattended (section 6). The draft recommended an ask; the owner chose this instead.
- **`checks.prSize` is on by default** (section 7).

## 13. Known limits (README)

- Text detection only. It misses `gh` aliases (`gh alias set`), `gh api` POSTs, `hub`, shell scripts that aren't `package.json` scripts, GitHub MCP tools, the web UI and the person's own terminal. Only a CI size check or branch protection stops a large PR for everyone.
- The hook doesn't fetch. It measures against the last fetched remote refs, so a stale `origin/<base>` can over-count.
- It assumes the `origin` remote. Fork flows, where the base lives on `upstream` or comes from `--repo`, are measured against `origin`.
- The push check covers only branches whose PR harness saw being created. A PR opened by a person, or before this feature, isn't recorded.
- A pushed branch is assumed to have the same name on the remote, unless the refspec names it.
- `gh pr edit --base` can change a PR's size after it was opened; that isn't checked.
- Size is lines and files, not complexity. 200 lines in one file and 200 across 20 files score the same on lines.
- A PR that can't be measured (no base ref, git missing, a timeout) is allowed with only a note and a `pr-size-unmeasured` event, unattended runs included (O5). A repo that never fetches its base is never size-checked.
- `gh`'s own choice of default base beyond the remote's default branch isn't mirrored (unverified).
